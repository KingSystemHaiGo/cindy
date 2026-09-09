/**
 * migrate.ts — 存量 worktree 分片迁移 (P0 第二阶段, #2379)。
 *
 * 背景: #2399 合入前, `buildMemoryScopeKey()` 对本地会话原样透传 workdir
 * 绝对路径, git linked worktree 会话因此落到独立分片目录
 * `<basePath>/maker-memory/<sanitizeWorkdir(worktree路径)>/`。归一化生效后,
 * 新会话读写 `<sanitizeWorkdir(主仓根+相对子路径)>/` 的 canonical 分片,
 * 旧 worktree 分片不再被访问 — 数据保留在磁盘, 需要一次性迁移 (#2379 正文
 * 修复方向 2; #2400 维护者分析「后续迁移至少应满足…」的落地)。
 *
 * 本模块只做文件层迁移, 不碰 SQLite:
 *  - 文件是 source of truth, FTS5 是派生索引 (fts.ts 设计原则)
 *  - 目标分片下次被打开时, store.init() 的 sanityCheck 会因 count 不一致
 *    自动全量 rebuild FTS — 迁移后无需手工重建索引
 *  - maker-core 不依赖 better-sqlite3 (type-only import, zero-electron-deps 边界)
 *
 * 迁移规则 (遵循 #2379 / #2400 约束):
 *  - 只处理「meta.json.absPath 经 resolveMemoryScopeKey 归一化后, canonical
 *    目录名 ≠ 当前目录名」的分片 — 即真正的旧 worktree 分片
 *  - 空分片 (无合法 <type>_<slug>.md) → 直接删 (零内容零风险, #2379 正文)
 *  - 有内容分片 → 合并进 canonical 分片:
 *      canonical 不存在 → rename 整个目录 (快路径, fts.db 相对名不变仍有效)
 *      canonical 已存在 → 逐文件复制: 同名同内容跳过 / 同名不同内容 = 冲突
 *        (不静默覆盖, #2400 硬约束) 跳过并报告 / 不同名复制
 *    复制后重建目标 MEMORY.md (从 frontmatter 派生, storage.rebuildIndex 语义)
 *  - SSH 分片 (目录名以 ssh- 开头) 一律不碰 (#2379: 不要动 SSH 分支)
 *  - 无 meta.json 的残留目录 → 跳过并报告, 不猜不删
 *  - 迁移前可选备份 (--backup-dir); 空分片删除前若指定备份同样先复制
 *
 * 流程: planLegacyShardMigration() 纯扫描出计划 (dry-run 可预览);
 * runLegacyShardMigration() 执行计划 (幂等, 可重复跑)。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { MemoryStorage, SSH_SCOPE_KEY_PREFIX, memoryScopeDirName, parseFilename } from './storage.js';
import {
  looksLikeWindowsLocalPath,
  normalizeWindowsLocalScopeKey,
  resolveMemoryScopeKey,
} from './scope-resolver.js';

/** meta.json 内容 (storage.ts MemoryStorageMeta 同形)。 */
interface ShardMeta {
  absPath: string;
  createdAt: string;
  lastUsedAt: string;
}

/** 迁移工具依赖注入 (默认走真实 fs / resolver, 测试可替换)。 */
export interface LegacyShardMigrationDeps {
  /** canonical scope key 解析; 默认 resolveMemoryScopeKey (带 worktree 归一化)。 */
  resolveScopeKey?: (workingDir: string) => Promise<string>;
  /** 时钟 (meta 更新)。 */
  now?: () => string;
}

/** 单个分片目录的扫描结果。 */
export interface LegacyShardInfo {
  /** 分片目录绝对路径。 */
  dir: string;
  /** meta.json.absPath (记录旧 workdir, 迁移前是未归一化路径)。 */
  legacyWorkdir: string;
  /** 归一化后的 canonical scope key。 */
  canonicalScopeKey: string;
  /** canonical 分片目录名 (memoryScopeDirName(canonicalScopeKey))。 */
  canonicalDirName: string;
  /** 是否为需要迁移的 legacy 分片 (canonicalDirName ≠ 当前目录名)。 */
  isLegacy: boolean;
  /** 合法 .md 分片数 (排除 MEMORY.md / meta.json / fts.db)。 */
  recordCount: number;
  /** skipped / failed 原因 (relative-absPath / worktree-resolve-failure 等)。 */
  skipReason?: string;
}

/** 迁移计划。 */
export interface LegacyShardMigrationPlan {
  /** 全部扫描到的分片 (含非 legacy)。 */
  all: LegacyShardInfo[];
  /** 空 legacy 分片 (可直接删)。 */
  emptyToDelete: LegacyShardInfo[];
  /** 有内容需合并的 legacy 分片。 */
  mergeCandidates: LegacyShardInfo[];
  /** 无 meta.json / SSH / 相对 absPath 等不处理的分片。 */
  skipped: LegacyShardInfo[];
  /** 活 worktree 解析失败等需 surface 的分片 (不 abort 整份计划)。 */
  failed: LegacyShardInfo[];
}

/** 单文件合并结果。 */
export interface MergeFileResult {
  filename: string;
  outcome: 'copied' | 'same-skipped' | 'conflict-skipped' | 'target-exists-merged';
}

/** 单个 legacy 分片的迁移结果。 */
export interface ShardMigrationResult {
  shard: LegacyShardInfo;
  action: 'removed-empty' | 'renamed' | 'merged' | 'skipped' | 'rename-incomplete';
  mergedFiles?: MergeFileResult[];
  error?: string;
}

export interface RunMigrationOptions {
  /** 备份根目录; 提供时删除/rename 前先复制一份。 */
  backupRoot?: string;
  /** 注入依赖 (测试用)。 */
  deps?: LegacyShardMigrationDeps;
  /** 测试注入: dropStaleFts 用的单文件 rm (Codex 3971991067)。 */
  rmFile?: (filePath: string) => Promise<void>;
  /** 测试注入: 替换 rename (Codex 3971991063)。 */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface RunMigrationResult {
  results: ShardMigrationResult[];
  /** 冲突文件 (同名不同内容) — 调用方应展示给用户。 */
  conflicts: Array<{ dir: string; filename: string }>;
}

/** --apply CLI 汇总: 必须含 plan.failed, 否则 Git 探测失败仍 0 退出 (Codex 3971230679)。 */
export interface ApplyMigrationSummary {
  shards: Array<{
    dir: string;
    action: ShardMigrationResult['action'];
    records: number;
    mergedFiles?: MergeFileResult[];
    error?: string;
  }>;
  conflicts: Array<{ dir: string; filename: string }>;
  failed: Array<{ dir: string; reason: string | null }>;
  executionErrors: Array<{ dir: string; action: ShardMigrationResult['action']; error: string }>;
  /** 无解析失败、无执行期错误、无未解决冲突时为 true (Codex 3971991063)。 */
  ok: boolean;
}

function isExecutionFailure(r: ShardMigrationResult): boolean {
  if (r.action === 'skipped' || r.action === 'rename-incomplete') return true;
  // merged 但带 error = 源目录因冲突/未识别文件保留, 自动化不得当成功。
  return Boolean(r.error);
}

export function summarizeApplyMigration(
  plan: LegacyShardMigrationPlan,
  result: RunMigrationResult,
): ApplyMigrationSummary {
  const executionErrors = result.results
    .filter(isExecutionFailure)
    .map((r) => ({
      dir: r.shard.dir,
      action: r.action,
      error: r.error ?? r.action,
    }));
  return {
    shards: result.results.map((r) => ({
      dir: r.shard.dir,
      action: r.action,
      records: r.shard.recordCount,
      mergedFiles: r.mergedFiles ?? undefined,
      error: r.error ?? undefined,
    })),
    conflicts: result.conflicts.map((c) => ({ dir: c.dir, filename: c.filename })),
    failed: plan.failed.map((s) => ({
      dir: s.dir,
      reason: s.skipReason ?? null,
    })),
    executionErrors,
    ok:
      plan.failed.length === 0 &&
      executionErrors.length === 0 &&
      result.conflicts.length === 0,
  };
}

/**
 * 扫描 maker-memory 根目录下所有分片, 生成迁移计划。
 * 纯只读, 不修改任何文件 (dry-run 安全)。
 */
export async function planLegacyShardMigration(
  memoryRoot: string,
  deps?: LegacyShardMigrationDeps,
): Promise<LegacyShardMigrationPlan> {
  const resolveScopeKey = deps?.resolveScopeKey ?? resolveMemoryScopeKey;
  const plan: LegacyShardMigrationPlan = {
    all: [],
    emptyToDelete: [],
    mergeCandidates: [],
    skipped: [],
    failed: [],
  };

  let entries: string[];
  try {
    entries = await fs.readdir(memoryRoot);
  } catch {
    return plan;
  }

  for (const entry of entries) {
    const dir = path.join(memoryRoot, entry);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let meta: ShardMeta | null = null;
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(path.join(dir, 'meta.json'), 'utf8'),
      );
      // JSON.parse("null") / 数组 / 非对象通过 try, 但 meta.absPath 会抛掉整份计划
      // (Codex review on #2519 第十七轮)。{}、缺 absPath 也当无效 meta。
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as ShardMeta).absPath !== 'string' ||
        (parsed as ShardMeta).absPath.trim() === ''
      ) {
        plan.skipped.push(await buildSkippedInfo(dir, entry, 'invalid-meta'));
        continue;
      }
      meta = parsed as ShardMeta;
    } catch {
      // 无 meta.json / 非 JSON → 不猜不删, 跳过并报告
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'no-meta'));
      continue;
    }

    // SSH 分片不迁移 (#2379 约束 3)。判定依据是 scope key 形态 (meta.absPath
    // 以 `ssh:` 开头 — storage 层只对远端会话生成 ssh: 复合键), 而不是目录名
    // 前缀: sanitizeWorkdir 允许本地路径 (如 /ssh/proj) 恰好产出 ssh- 开头的
    // 目录名, 按前缀误判会把本地 legacy 分片跳过成孤儿 (Codex review on
    // #2519 第五轮)。
    const rawAbs = canonicalizeMetaAbsPath(meta.absPath);
    const isRemote = rawAbs.startsWith(SSH_SCOPE_KEY_PREFIX);
    if (isRemote) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'ssh', rawAbs));
      continue;
    }
    // MemoryStorageMeta.absPath 约定绝对路径; 相对路径 (如 "..") 规划阶段
    // 拒绝, 否则 apply 会把目标解析到 memoryRoot 的父目录并删源
    // (Codex review on #2519 第十八轮)。
    if (!isAbsoluteLocalPath(rawAbs)) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'relative-absPath', rawAbs));
      continue;
    }

    let canonicalScopeKey: string;
    try {
      canonicalScopeKey = await resolveScopeKey(rawAbs);
    } catch {
      canonicalScopeKey = rawAbs;
    }
    // 已归档/删除的 Cindy worktree (resolver live 探测失败回落原样) —
    // 用 `.cindy-worktrees/<name>` 路径形态做静态推导, 否则旧记录永远孤儿
    // (Codex review on #2519)。
    //
    // 仅当该路径**不是活 git 仓库**、且能证明是 Cindy 托管 worktree 时才
    // 推导 (Codex review on #2519 第十二/十六/十七轮): 普通仓内恰好有同名
    // `.cindy-worktrees/<name>` 目录时, resolver 正确返回原样, 不推导。
    // `git worktree remove` 会删掉 worktree 目录与 `.git/worktrees/<name>` 登记,
    // 但 meta.absPath 仍是托管形态 — 记 unregistered-legacy, 仍静态推导,
    // 否则归档分片永远孤儿。
    //
    // 活托管 worktree 上 resolver 超时/失败也回落原路径, 且 isLiveGitRepo
    // 为真会压掉静态推导 → 静默 non-legacy、记忆孤儿。记 failed 并 surface
    // (Codex review on #2519 第十八轮), 不 abort 整份计划。
    if (canonicalScopeKey === rawAbs) {
      const live = await isLiveGitRepo(rawAbs);
      // 活 Cindy worktree 仍有 `.git/worktrees/<name>` 登记, 但 resolver 回落
      // 原路径 (超时/git 失败) → 不能当 non-legacy 静默吞掉。碰巧同名的
      // 独立仓库没有登记, 回落原路径是正确结果, 不进 failed。
      if (live && (await hasGitWorktreeRegistration(rawAbs))) {
        plan.failed.push(
          await buildSkippedInfo(dir, entry, 'worktree-resolve-failure', rawAbs),
        );
        continue;
      }
      if (!live && (await shouldDeriveArchivedManagedWorktree(rawAbs))) {
        const derived = deriveCanonicalFromCindyWorktreePath(rawAbs);
        if (derived) canonicalScopeKey = derived;
      }
    }
    const canonicalDirName = memoryScopeDirName(canonicalScopeKey);
    const isLegacy = canonicalDirName !== entry;

    const info: LegacyShardInfo = {
      dir,
      legacyWorkdir: meta.absPath || entry,
      canonicalScopeKey,
      canonicalDirName,
      isLegacy,
      recordCount: 0,
    };

    // 统计合法分片数 + 未识别遗留内容 (数据保全: 只有遗留文件 (含非
    // Markdown) 的目录不是「空」— 删掉会永久丢失用户内容; Greptile review
    // on #2519 第二轮 + Codex 第十轮: 只含 notes.txt/data.yaml 的分片同样
    // 不能按空删)。
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      files = [];
    }
    let hasUnrecognizedContent = false;
    for (const f of files) {
      if (parseFilename(f)) {
        info.recordCount += 1;
      } else if (f !== 'MEMORY.md' && f !== 'meta.json' && f !== 'fts.db') {
        hasUnrecognizedContent = true;
      }
    }

    plan.all.push(info);
    if (!isLegacy) continue;
    // recordCount === 0 但存在未识别遗留内容 → 不按空删 (内容可能就在里面),
    // 归入 mergeCandidates 走慢路径合并 (那边有未识别文件保留源目录的保护)
    if (info.recordCount === 0 && !hasUnrecognizedContent) {
      plan.emptyToDelete.push(info);
    } else {
      plan.mergeCandidates.push(info);
    }
  }
  return plan;
}

function canonicalizeMetaAbsPath(absPath: string): string {
  const trimmed = absPath.trim();
  if (process.platform === 'win32' || looksLikeWindowsLocalPath(trimmed)) {
    return normalizeWindowsLocalScopeKey(trimmed);
  }
  if (trimmed.length > 1) return trimmed.replace(/\/+$/, '');
  return trimmed;
}

function isAbsoluteLocalPath(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // 跨平台规划: Linux CI 上 Windows 盘符/UNC 仍视为绝对, 相对盘符 C:foo 不算。
  if (/^[A-Za-z]:\//.test(p)) return true;
  if (p.startsWith('//') && p.length > 2) return true;
  return false;
}

async function buildSkippedInfo(
  dir: string,
  entry: string,
  reason?: string,
  legacyWorkdir?: string,
): Promise<LegacyShardInfo> {
  return {
    dir,
    legacyWorkdir: legacyWorkdir ?? entry,
    canonicalScopeKey: entry,
    canonicalDirName: entry,
    isLegacy: false,
    recordCount: -1,
    skipReason: reason,
  };
}

/**
 * 托管 worktree 路径 → 主仓路径的静态推导 (Codex review on #2519)。
 *
 * 场景: 旧 worktree 分片的 meta.absPath 指向 `.../<主仓>/<托管段>/<name>`。
 * 若该 worktree 已被归档/删除, resolver 的 live git 探测找不到 .git 标记,
 * 回落返回原路径 → canonicalDirName === 目录名 → 不迁移, 旧记录永远孤儿。
 *
 * 本函数只处理 **已知的托管 worktree 形态** (产品自己创建的):
 *   `.cindy-worktrees` — 现行形态
 *   `.xdt-worktrees`   — 品牌迁移前的旧形态 (Codex review on #2519 第二轮)
 * 取托管段之前的路径为主仓根, 段之后的子路径拼回。非该形态 (用户手工
 * worktree / 其他布局) 返回 null, 交回 live 探测结果, 不做危险猜测。
 *
 * 例:
 *   /repo/.cindy-worktrees/feat-x            → /repo
 *   /repo/.cindy-worktrees/feat-x/apps/a     → /repo/apps/a
 *   /repo/.xdt-worktrees/feat-x/apps/a       → /repo/apps/a
 *   /Users/me/other/wt (无托管段)            → null
 */
const MANAGED_WORKTREE_DIRS = ['.cindy-worktrees', '.xdt-worktrees'];
const WINDOWS_DRIVE_RE = /^[A-Za-z]:$/;

/**
 * 把托管段之前的路径段还原成主仓根。根盘 / POSIX 根不能用 join 丢分隔符:
 * `C:\\.cindy-worktrees\\name` 的前缀是 `C:`, 必须还原成 `C:/` 而不是 `C:`
 * (`C:` → sanitize `C-`, `C:/` → `C--`; Codex review on #2519 第十七轮);
 * POSIX `/.cindy-worktrees/name` 前缀为空, 必须还原成 `/` 而不是拒绝。
 */
function prefixSegmentsToMainRoot(prefixSegs: string[], original: string): string | null {
  const meaningful = prefixSegs.filter((s) => s.length > 0);
  if (meaningful.length === 0) {
    if (original.startsWith('//') || original.startsWith('\\')) return '//';
    return '/';
  }
  if (meaningful.length === 1 && WINDOWS_DRIVE_RE.test(meaningful[0])) {
    return `${meaningful[0]}/`;
  }
  // UNC: ['', '', 'server', 'share'] 或 ['', 'server', 'share'] 经 split 后
  const uncHost = prefixSegs[0] === '' && prefixSegs[1] === '' ? prefixSegs.slice(2) : null;
  if (uncHost && uncHost.length >= 1) {
    return '//' + uncHost.filter((s) => s.length > 0).join('/');
  }
  const joined = prefixSegs.filter((s) => s.length > 0).join('/');
  if (joined.length === 0) return null;
  return original.startsWith('/') ? `/${joined}` : joined;
}

export function deriveCanonicalFromCindyWorktreePath(absPath: string): string | null {
  // Desktop 存储会把 Windows workingDir 归一化为正斜杠 (C:/repo/.cindy-...),
  // 而 path.sep 在 Windows 是反斜杠 — 只认一种分隔符会漏掉归一化后的路径
  // (Codex review on #2519 第四轮)。统一按段解析, 两种分隔符都接受。
  const segments = absPath.split(/[\\/]/);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!MANAGED_WORKTREE_DIRS.includes(segments[i])) continue;
    // segments[i] = 托管段; segments[i+1] = worktree 名 (必须存在)
    const worktreeName = segments[i + 1];
    if (worktreeName.length === 0) continue;
    const mainRoot = prefixSegmentsToMainRoot(segments.slice(0, i), absPath);
    if (mainRoot === null) continue;
    const subPath = segments.slice(i + 2).filter((s) => s.length > 0).join('/');
    const joined = subPath ? `${mainRoot.replace(/\/+$/, '')}/${subPath}` : mainRoot;
    if (looksLikeWindowsLocalPath(absPath) || process.platform === 'win32') {
      return normalizeWindowsLocalScopeKey(joined);
    }
    return joined;
  }
  return null;
}

/**
 * 执行迁移计划 (幂等: 已合并/已删除的分片第二次跑时 canonicalDirName === 目录名
 * 或目录已不存在, 自然跳过)。
 *
 * 步骤: 可选备份 → 空分片删除 / 有内容合并 → 重建目标 MEMORY.md。
 * 失败不中断: 单个分片出错记录 error 继续下一个 (迁移是可恢复的数据操作,
 * 残留问题由下次运行修复; 冲突文件绝不自动覆盖)。
 */
export async function runLegacyShardMigration(
  plan: LegacyShardMigrationPlan,
  opts: RunMigrationOptions = {},
): Promise<RunMigrationResult> {
  const { backupRoot, deps } = opts;
  const now = deps?.now ?? (() => new Date().toISOString());
  const renameFn = opts.rename ?? ((from: string, to: string) => fs.rename(from, to));
  const dropFtsFn = (dir: string) => dropStaleFts(dir, opts.rmFile);
  const result: RunMigrationResult = { results: [], conflicts: [] };

  // ── 1. 空分片删除 ───────────────────────────────────────────────
  for (const shard of plan.emptyToDelete) {
    const r: ShardMigrationResult = { shard, action: 'removed-empty' };
    try {
      // 竞态防御 (Greptile on #2519): 计划基于扫描快照, 删除前重新校验目录
      // 仍无任何内容 — 若扫描后新增了分片文件或未识别 .md, 跳过删除并报告,
      // 绝不让过期快照删掉新写入的数据。rename-then-remove 把复查与删除之间
      // 的窗口压缩到 rename 原子操作之后: 目录一改名, 新写入只会落到原名
      // 目录 (已不存在) 或别的路径, 不会进到即将删除的临时名目录。
      const gained = await countShardFiles(shard.dir);
      const unrecognized = await findUnrecognizedMdFiles(shard.dir);
      if (gained > 0 || unrecognized.length > 0) {
        r.action = 'skipped';
        r.error = `dir gained content since scan (${gained} shard file(s), ${unrecognized.length} unrecognized md), kept`;
        result.results.push(r);
        continue;
      }
      if (backupRoot) await backupDir(shard.dir, backupRoot);
      // rename → 复查 → remove: 复查放在 rename 之后, 只看将被删的临时目录;
      // rename 后目录已不在原路径, 复查窗口内写入只能落到原名 (已不存在),
      // 无法进入待删目录 (与备份目录同层, 名字带后缀避免冲突)。
      const trashName = `${path.basename(shard.dir)}.trash-${now().replace(/[:.]/g, '-')}`;
      const trashDir = path.join(path.dirname(shard.dir), trashName);
      await renameFn(shard.dir, trashDir);
      // 最终复查 (rename 后, 删前): 合法分片 + 未识别 .md 都要查 — 首次复查
      // 之后、rename 之前写入的 notes.md 等未识别文件同样不能被删 (Greptile
      // review on #2519 第三轮)。
      const afterRename = await countShardFiles(trashDir);
      const unrecognizedAfterRename = await findUnrecognizedMdFiles(trashDir);
      if (afterRename > 0 || unrecognizedAfterRename.length > 0) {
        // 极端: rename 前已写入的内容 — 恢复原目录名并报告
        await fs.rename(trashDir, shard.dir);
        r.action = 'skipped';
        r.error = `dir gained content before rename (${afterRename} shard file(s), ${unrecognizedAfterRename.length} unrecognized md), kept`;
        result.results.push(r);
        continue;
      }
      await fs.rm(trashDir, { recursive: true, force: true });
    } catch (e) {
      r.action = 'skipped';
      r.error = String(e);
    }
    result.results.push(r);
  }

  // ── 2. 有内容分片合并 ───────────────────────────────────────────
  for (const shard of plan.mergeCandidates) {
    const r: ShardMigrationResult = { shard, action: 'merged', mergedFiles: [] };
    try {
      const targetDir = path.join(path.dirname(shard.dir), shard.canonicalDirName);
      const targetExists = await dirExists(targetDir);

      if (!targetExists) {
        // 快路径: canonical 分片不存在 → rename 整个目录
        if (backupRoot) await backupDir(shard.dir, backupRoot);
        await renameFn(shard.dir, targetDir);
        // meta.absPath 更新为 canonical scope key (原值 = 旧 worktree 路径)
        await updateMetaAbsPath(targetDir, shard.canonicalScopeKey, now());
        // 重建 MEMORY.md — legacy 分片索引可能缺失/过期 (写入与重建之间崩溃
        // 或人工修复), 不重建的话 canonical 会话 getIndex() 读到 stale 索引,
        // 记忆进不了 prompt (Codex review on #2519 第十一轮, 与合并路径一致)
        await rebuildIndexFile(targetDir);
        // 丢弃 legacy 的 fts.db 与 sidecar — FTS 曾有更新失败时文件新但行数
        // 碰巧匹配, sanityCheck() 只对比行数 → memory_search 一直返回 stale
        // 行。删除后下次打开由 sanity check 以文件为 source of truth 重建
        // (Codex review on #2519 第十六轮)。rm 失败不得报 renamed
        // (Codex #2519 3971991067): 旧 fts.db 残留会让新 store 撞 stale FTS。
        try {
          await dropFtsFn(targetDir);
          r.action = 'renamed';
        } catch (e) {
          r.action = 'rename-incomplete';
          r.error = `stale fts.db remove failed: ${String(e)}`;
        }
      } else {
        // 慢路径: 逐文件合并
        if (backupRoot) await backupDir(shard.dir, backupRoot);
        const merged = await mergeFilesInto(shard, targetDir, result.conflicts);
        r.mergedFiles = merged;
        // 合并后重建目标 MEMORY.md (从分片 frontmatter 派生)
        await rebuildIndexFile(targetDir);
        // 源目录此刻只剩 MEMORY.md / meta.json / fts.db → 整个删掉。
        // 保留源目录的情形 (数据保全, 人工处理前数据必须仍在磁盘上):
        //  1. 有冲突 — 同名不同内容绝不静默覆盖 (#2400)
        //  2. 有未识别文件 — 不参与合并的任何遗留内容 (含非 Markdown),
        //     删掉源目录会永久丢失 (Greptile review on #2519)
        //  3. 快照后合法分片集合变化 — 新增/缺失/同数替换 (删 A 建 B):
        //     数量复查检测不到同数替换, 文件名集合对比兜底 (Codex review
        //     on #2519 第六轮)
        //  4. 复制后已有分片被更新 — 存量会话在复制后、删源前改写了同名
        //     记忆, 数量复查检测不到, 内容对比兜底 (Greptile review on
        //     #2519 第五轮)
        const hasConflict = merged.some((m) => m.outcome === 'conflict-skipped');
        const snapshotNames = new Set(merged.map((m) => m.filename));
        const unrecognized = await findUnrecognizedMdFiles(shard.dir);
        // 当前合法文件名集合 vs 快照集合: added = 快照后新增, missing =
        // 快照后消失 (被替换删掉) — 任一存在都说明快照后源目录被写过
        const { added, missing } = await diffShardFilenames(shard.dir, snapshotNames);
        // 内容复查: 已合并的合法分片, 源与目标逐字节对比 — 源文件在复制后
        // 被存量会话更新过则源 ≠ 目标, 保留源目录 (目标保留的是旧数据)。
        const contentChanged = await findChangedAfterMerge(shard.dir, targetDir, merged);
        if (unrecognized.length > 0) {
          r.action = 'merged';
          r.error = `unrecognized files kept in source dir for manual review: ${unrecognized.join(', ')}`;
          result.results.push(r);
          continue;
        }
        if (added.length > 0 || missing.length > 0) {
          r.action = 'merged';
          r.error = `shard filename set changed after snapshot (added ${added.length}, missing ${missing.length}), source dir kept`;
          result.results.push(r);
          continue;
        }
        if (contentChanged.length > 0) {
          r.action = 'merged';
          r.error = `shard file(s) updated after copy, source dir kept: ${contentChanged.join(', ')}`;
          result.results.push(r);
          continue;
        }
        if (hasConflict) {
          r.action = 'merged';
          r.error = 'conflicts remain in source dir (kept for manual review)';
          result.results.push(r);
          continue;
        }
        // 全部复查通过 → rename-then-remove: rename 后源目录不在原路径,
        // 复查窗口内新写入只能落到原名 (已不存在), 无法进入待删目录;
        // rename 后对 trash 再做一次最终复查兜底 (Greptile review on #2519
        // 第六轮: 复查完成后 fs.rm 前的写入仍会被删)。
        const trashName = `${path.basename(shard.dir)}.trash-${now().replace(/[:.]/g, '-')}`;
        const trashDir = path.join(path.dirname(shard.dir), trashName);
        await renameFn(shard.dir, trashDir);
        // 最终复查 (rename 后, 删前): 未识别 + 文件名集合 + **内容对比** —
        // 存量会话在 findChangedAfterMerge 之后、rename 之前更新同名记忆时,
        // trash 集合不变但内容新, 只查集合会删掉新版本 (Greptile/Codex
        // review on #2519 第七轮)。
        const trashUnrecognized = await findUnrecognizedMdFiles(trashDir);
        const trashDiff = await diffShardFilenames(trashDir, snapshotNames);
        const trashChanged = await findChangedAfterMerge(trashDir, targetDir, merged);
        if (
          trashUnrecognized.length > 0 ||
          trashDiff.added.length > 0 ||
          trashDiff.missing.length > 0 ||
          trashChanged.length > 0
        ) {
          await fs.rename(trashDir, shard.dir);
          r.action = 'merged';
          r.error = 'content appeared or changed before remove, source dir restored';
          result.results.push(r);
          continue;
        }
        await fs.rm(trashDir, { recursive: true, force: true });
      }
    } catch (e) {
      r.action = 'skipped';
      r.error = String(e);
    }
    result.results.push(r);
  }

  return result;
}

/** 合并源分片的所有 .md 文件进目标目录。返回逐文件结果; 冲突写入 conflicts 并跳过。 */
async function mergeFilesInto(
  shard: LegacyShardInfo,
  targetDir: string,
  conflicts: RunMigrationResult['conflicts'],
): Promise<MergeFileResult[]> {
  const files = (await fs.readdir(shard.dir)).filter((f) => parseFilename(f));
  const out: MergeFileResult[] = [];
  for (const filename of files) {
    const src = path.join(shard.dir, filename);
    const dst = path.join(targetDir, filename);
    const srcBuf = await fs.readFile(src);
    const dstExists = await pathExists(dst);

    if (!dstExists) {
      await fs.copyFile(src, dst);
      out.push({ filename, outcome: 'copied' });
      continue;
    }
    const dstBuf = await fs.readFile(dst);
    if (srcBuf.equals(dstBuf)) {
      out.push({ filename, outcome: 'same-skipped' });
      continue;
    }
    // 同名不同内容 = 冲突: 不静默覆盖 (#2400), 保留两份, 报告人工处理
    conflicts.push({ dir: shard.dir, filename });
    out.push({ filename, outcome: 'conflict-skipped' });
  }
  return out;
}

/** 目标目录 MEMORY.md 重建 — 复用 storage.rebuildIndex (与运行时行为完全一致)。 */
async function rebuildIndexFile(targetDir: string): Promise<void> {
  const storage = new MemoryStorage(targetDir);
  await storage.rebuildIndex();
}

/**
 * 丢弃分片目录中的 FTS 文件 (fts.db + SQLite sidecar)。rename 快路径把
 * legacy fts.db 原样带入 canonical — FTS 曾有更新失败时文件内容新但行数
 * 碰巧匹配, sanityCheck() 只对比行数, memory_search 持续返回 stale 行。
 * 删除后下次打开由 sanity check 以文件为 source of truth 重建 (Codex
 * review on #2519 第十六轮)。文件不存在时静默。
 */
async function dropStaleFts(
  dir: string,
  rmFile?: (filePath: string) => Promise<void>,
): Promise<void> {
  const rm = rmFile ?? ((p: string) => fs.rm(p, { force: true }));
  const errors: string[] = [];
  for (const name of ['fts.db', 'fts.db-wal', 'fts.db-shm']) {
    try {
      await rm(path.join(dir, name));
    } catch (e) {
      // ENOENT 由 force:true 覆盖; 其它错误 (Windows 锁 / ACL) 必须 surface
      // (Codex #2519 3971991067), 不能假定下次 sanityCheck 会重建。
      errors.push(`${name}: ${String(e)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

/** 更新目标分片 meta.json 的 absPath 为 canonical scope key。 */
async function updateMetaAbsPath(dir: string, absPath: string, nowIso: string): Promise<void> {
  const metaPath = path.join(dir, 'meta.json');
  let meta: ShardMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as ShardMeta;
  } catch {
    meta = { absPath, createdAt: nowIso, lastUsedAt: nowIso };
  }
  meta.absPath = absPath;
  meta.lastUsedAt = nowIso;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

/** 迁移前备份单个分片目录到 backupRoot/<目录名>-<时间戳>。 */
async function backupDir(dir: string, backupRoot: string): Promise<void> {
  const name = path.basename(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.cp(dir, path.join(backupRoot, `${name}-${stamp}`), { recursive: true });
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** 文件/目录存在性 (stat 成功即 true)。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 目录中合法分片文件 (<type>_<slug>.md) 的数量。目录不存在返 0。 */
async function countShardFiles(dir: string): Promise<number> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => parseFilename(f)).length;
  } catch {
    return 0;
  }
}

/**
 * 路径是否位于活 git 仓库内 — 从 `<p>` 向上遍历祖先目录找 `.git` 标记
 * (目录或 gitdir 指针文件)。静态推导前的护栏: 普通 checkout 恰好位于
 * .cindy-worktrees 下、会话 workdir 是子目录时 (如 /home/me/.cindy-worktrees/
 * proj/apps/a), `.git` 在祖先 proj/ 下 — 只查 `<p>/.git` 会误判非活仓库并
 * 推导成错误主仓根 (Codex review on #2519 第十二轮 + 第十四轮)。
 *
 * 但遍历祖先对**已归档的托管 worktree** 误伤: /repo/.cindy-worktrees/<name>/
 * 的 <name> 已删除后 worktree 无 .git, 而主仓 /repo/.git 仍存在 — 遍历命中
 * 主仓标记会判活仓库、跳过静态推导, 记忆永远孤儿 (Codex review on #2519
 * 第十五轮)。因此仅在「有托管证据」或「托管根已不在磁盘」(git worktree
 * remove 清掉目录+登记) 时遍历才止步于托管 worktree 根。普通仓内同名目录
 * 仍然存在且无登记, 不把该段当托管根, 继续向上找真正的仓库标记。
 * 非托管形态保持遍历到根的行为。
 */
async function isLiveGitRepo(p: string): Promise<boolean> {
  // 托管根从原始 absPath 重建 (保留 POSIX 前导 /), 不要 path.resolve 后再
  // 比 stop: Windows 会把 `/repo/.cindy-worktrees/wt` 绑到当前盘, 且错误
  // 重建的相对 stop 永远对不上绝对祖先, 命中主仓 `.git` 误判存活
  // (Codex review on #2519 3971230671)。
  const managed = managedWorktreeRoot(p);
  let stop: string | null = null;
  if (managed) {
    const evidence = await hasManagedWorktreeEvidence(p);
    const rootStillThere = await dirExists(managed);
    // 登记还在, 或 worktree remove 后目录已消失 → 止步托管根, 不把主仓 .git
    // 当活仓库。目录还在且无登记 → 普通仓同名路径, 继续向上。
    if (evidence || !rootStillThere) stop = managed;
  }
  let cur = p;
  for (;;) {
    try {
      const s = await fs.stat(path.join(cur, '.git'));
      if (s.isDirectory() || s.isFile()) return true;
    } catch {
      // 继续向上
    }
    if (stop !== null && sameLocalPath(cur, stop)) return false; // 托管根未命中 → 非活仓库
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function sameLocalPath(a: string, b: string): boolean {
  const norm = (s: string): string => {
    const n = s.replace(/\\/g, '/').replace(/\/+$/, '');
    return n === '' ? '/' : n;
  };
  const na = norm(a);
  const nb = norm(b);
  if (process.platform === 'win32' || looksLikeWindowsLocalPath(a) || looksLikeWindowsLocalPath(b)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/**
 * 路径是否有 Cindy 托管 worktree 证据, 而非仅目录名碰巧叫
 * `.cindy-worktrees/<name>`。证据任一即可:
 *   1. 托管根 (含 worktree 名) 自身有 `.git` 标记 (活 worktree / 未清 gitdir)
 *   2. 主仓登记 `<mainRoot>/.git/worktrees/<name>` (归档后磁盘目录已删,
 *      但 git 仍保留 worktree 元数据, 直至 prune)
 * 都没有则视为普通仓内的同名目录, 禁止静态推导 (Codex review on #2519
 * 第十六轮)。
 */
async function hasManagedWorktreeEvidence(absPath: string): Promise<boolean> {
  const root = managedWorktreeRoot(absPath);
  if (!root) return false;
  try {
    const s = await fs.stat(path.join(root, '.git'));
    if (s.isDirectory() || s.isFile()) return true;
  } catch {
    // 归档 worktree 通常已无 .git, 继续看主仓登记
  }
  return hasGitWorktreeRegistration(absPath);
}

/** 主仓是否仍登记该托管 worktree (`.git/worktrees/<name>`)。 */
async function hasGitWorktreeRegistration(absPath: string): Promise<boolean> {
  const root = managedWorktreeRoot(absPath);
  if (!root) return false;
  const worktreeName = path.basename(root);
  const mainRoot = path.dirname(path.dirname(root));
  if (!worktreeName || !mainRoot) return false;
  try {
    const s = await fs.stat(path.join(mainRoot, '.git', 'worktrees', worktreeName));
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

/**
 * 是否应对已归档托管路径做静态推导。
 * - 仍有 worktree `.git` 或 `.git/worktrees/<name>` 登记 → 是托管, 推导
 * - `git worktree remove` 后目录与登记都没了, 但 meta.absPath 仍是托管形态 →
 *   unregistered-legacy, 仍推导 (否则归档分片孤儿; Codex #2519 第十七轮)
 * - 普通仓内同名目录还在磁盘上、且无登记 → 不推导 (第十六轮护栏)
 */
async function shouldDeriveArchivedManagedWorktree(absPath: string): Promise<boolean> {
  const root = managedWorktreeRoot(absPath);
  if (!root) return false;
  if (await hasManagedWorktreeEvidence(absPath)) return true;
  return !(await dirExists(root));
}

/**
 * 托管 worktree 根 (含 worktree 名) — 解析 absPath 中 `.cindy-worktrees/<name>`
 * 或 `.xdt-worktrees/<name>` 段 (两种分隔符), 返回该段整体路径; 无托管段
 * 返回 null。
 */
export function managedWorktreeRoot(absPath: string): string | null {
  const segments = absPath.split(/[\\/]/);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!MANAGED_WORKTREE_DIRS.includes(segments[i])) continue;
    const worktreeName = segments[i + 1];
    if (worktreeName.length === 0) continue;
    // 保留 path.parse(absPath).root: 不要 segments.join(path.sep) /
    // path.join('') — POSIX `/repo/.cindy-worktrees/wt` 的空首段会被丢掉,
    // 变成相对 `repo/...`, dirExists / isLiveGitRepo stop 对不上, 已删
    // worktree 误判存活 (Codex review on #2519 3971230671)。
    const reconstructed = prefixSegmentsToMainRoot(segments.slice(0, i + 2), absPath);
    if (reconstructed === null) continue;
    if (looksLikeWindowsLocalPath(absPath) || process.platform === 'win32') {
      return normalizeWindowsLocalScopeKey(reconstructed);
    }
    return reconstructed;
  }
  return null;
}

/**
 * 对比目录当前合法分片文件名集合与快照集合 (Codex review on #2519 第六轮)。
 * added = 快照后新增的文件名; missing = 快照后消失的文件名 (被存量会话
 * 删掉/替换)。同数替换 (删 A 建 B) 时数量不变, 集合对比兜底。
 * 目录读失败 (并发删除) 返回空差异 — 调用方后续 rm 会失败兜底。
 */
async function diffShardFilenames(
  dir: string,
  snapshot: Set<string>,
): Promise<{ added: string[]; missing: string[] }> {
  try {
    const current = new Set((await fs.readdir(dir)).filter((f) => parseFilename(f)));
    const added = [...current].filter((f) => !snapshot.has(f));
    const missing = [...snapshot].filter((f) => !current.has(f));
    return { added, missing };
  } catch {
    return { added: [], missing: [] };
  }
}

/**
 * 找出「复制后被改写」的已合并分片 — 对 merged 中 outcome 为 copied /
 * same-skipped 的文件, 逐字节对比源目录与目标目录 (Greptile review on
 * #2519 第五轮: 存量会话在复制后、删源前更新已有记忆, 数量复查检测不到)。
 * 返回源 ≠ 目标的文件名列表; 源文件已消失 (并发删除) 视为未变化。
 */
async function findChangedAfterMerge(
  srcDir: string,
  targetDir: string,
  merged: MergeFileResult[],
): Promise<string[]> {
  const changed: string[] = [];
  for (const m of merged) {
    if (m.outcome !== 'copied' && m.outcome !== 'same-skipped') continue;
    const src = path.join(srcDir, m.filename);
    const dst = path.join(targetDir, m.filename);
    let srcBuf: Buffer;
    let dstBuf: Buffer;
    try {
      [srcBuf, dstBuf] = await Promise.all([fs.readFile(src), fs.readFile(dst)]);
    } catch {
      // 读取失败 (源被并发删/目标异常) → 无法证明源与目标一致, 保守记为
      // changed → 调用方保留源目录 (Greptile review on #2519 第十三轮:
      // 跳过会删掉未经验证的最新记忆)
      changed.push(m.filename);
      continue;
    }
    if (!srcBuf.equals(dstBuf)) changed.push(m.filename);
  }
  return changed;
}

/**
 * 找出目录中「不参与合并但仍保存内容的遗留文件」— 排除系统文件
 * (MEMORY.md / meta.json / fts.db) 与合法分片 (<type>_<slug>.md) 之外
 * 的**一切文件**, 含未识别的 .md (手写笔记) 与非 Markdown 遗留内容
 * (notes.txt / data.yaml 等)。存在即数据保全风险: 删掉源目录会永久丢失
 * (Greptile review on #2519)。
 */
async function findUnrecognizedMdFiles(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter(
      (f) => f !== 'MEMORY.md' && f !== 'meta.json' && f !== 'fts.db' && !parseFilename(f),
    );
  } catch {
    return [];
  }
}

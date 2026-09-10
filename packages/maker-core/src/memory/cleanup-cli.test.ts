/**
 * cleanup-cli.test.ts — scripts/cleanup-maker-memory.mjs 审阅集绑定。
 *
 * Codex P1 on #2561: --apply --archive-stale 不得 live 重扫后归档未审阅 stale。
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const cli = path.join(repoRoot, 'scripts', 'cleanup-maker-memory.mjs');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'memory-cleanup-cli-'));
  await writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      absPath: dir,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function shard(
  filename: string,
  type: string,
  title: string,
  description: string,
  body: string,
  updatedAt: string,
): Promise<void> {
  const raw = [
    '---',
    `title: ${title}`,
    `description: ${description}`,
    `type: ${type}`,
    `updatedAt: '${updatedAt}'`,
    '---',
    body,
    '',
  ].join('\n');
  await writeFile(path.join(dir, filename), raw, 'utf8');
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: repoRoot,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function resultJson(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT line in: ${stdout}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

describe('cleanup-maker-memory CLI stale binding', () => {
  it('refuses --apply --archive-stale without --from-plan', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');
    const r = await runCli(['--shard', dir, '--apply', '--archive-stale', '--force', '--json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--from-plan/);
  });

  it('dry-run writes expectedHash + fingerprint; apply binds and skips later stale', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');
    const planPath = path.join(dir, 'reviewed-plan.json');
    const dry = await runCli([
      '--shard',
      dir,
      '--dry-run',
      '--archive-stale',
      '--write-plan',
      planPath,
      '--json',
    ]);
    expect(dry.code).toBe(0);
    const dryJson = resultJson(dry.stdout);
    expect(typeof dryJson.staleFingerprint).toBe('string');
    const stale = dryJson.staleCandidates as Array<{ filename: string; expectedHash: string }>;
    expect(stale).toHaveLength(1);
    expect(stale[0].filename).toBe('project_done.md');
    expect(stale[0].expectedHash).toMatch(/^[0-9a-f]{64}$/);

    await shard('project_later.md', 'project', 'Later', 'hook', '这个项目已结束',
      '2026-02-01T00:00:00.000Z');

    const blocked = await runCli([
      '--shard',
      dir,
      '--apply',
      '--from-plan',
      planPath,
      '--force',
      '--json',
    ]);
    expect(blocked.code).toBe(6);
    expect(blocked.stderr).toMatch(/project_later\.md/);

    const applied = await runCli([
      '--shard',
      dir,
      '--apply',
      '--from-plan',
      planPath,
      '--confirm-stale-diff',
      '--force',
      '--json',
    ]);
    expect(applied.code).toBe(0);
    const applyJson = resultJson(applied.stdout);
    expect(applyJson.skippedUnreviewedStale).toEqual(['project_later.md']);
    await expect(readFile(path.join(dir, 'project_later.md'), 'utf8')).resolves.toContain('已结束');
    await expect(readFile(path.join(dir, 'project_done.md'), 'utf8')).rejects.toThrow();
  });

  it('apply --from-plan uses reviewed keep-digests instead of the default 2', async () => {
    await shard('digest_a.md', 'digest', 'A', 'hook', 'a', '2026-01-01T00:00:00.000Z');
    await shard('digest_b.md', 'digest', 'B', 'hook', 'b', '2026-02-01T00:00:00.000Z');
    await shard('digest_c.md', 'digest', 'C', 'hook', 'c', '2026-03-01T00:00:00.000Z');
    await shard('digest_d.md', 'digest', 'D', 'hook', 'd', '2026-04-01T00:00:00.000Z');
    await shard('digest_e.md', 'digest', 'E', 'hook', 'e', '2026-05-01T00:00:00.000Z');
    const planPath = path.join(dir, 'digest-plan.json');
    const dry = await runCli([
      '--shard',
      dir,
      '--dry-run',
      '--keep-digests',
      '5',
      '--write-plan',
      planPath,
      '--json',
    ]);
    expect(dry.code).toBe(0);
    const written = JSON.parse(await readFile(planPath, 'utf8')) as { keepDigests: number };
    expect(written.keepDigests).toBe(5);
    const dryJson = resultJson(dry.stdout);
    const digests = dryJson.digests as { keep: string[]; archive: string[] };
    expect(digests.keep).toHaveLength(5);
    expect(digests.archive).toHaveLength(0);

    const applied = await runCli(['--shard', dir, '--apply', '--from-plan', planPath, '--force', '--json']);
    expect(applied.code).toBe(0);
    for (const name of ['digest_a.md', 'digest_b.md', 'digest_c.md', 'digest_d.md', 'digest_e.md']) {
      await expect(readFile(path.join(dir, name), 'utf8')).resolves.toBeTruthy();
    }
  });

  it('rejects --from-plan filenames that escape the shard', async () => {
    const planPath = path.join(dir, 'bad-plan.json');
    const filename = '../other-shard/project_x.md';
    await writeFile(
      planPath,
      JSON.stringify({
        version: 1,
        shardDir: dir,
        keepDigests: 2,
        archiveStale: true,
        staleFingerprint: '00',
        staleCandidates: [{ filename, expectedHash: 'abc' }],
      }),
      'utf8',
    );
    const r = await runCli(['--shard', dir, '--apply', '--from-plan', planPath, '--force', '--json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/basename|canonical|--from-plan/);
  });

  it('rejects a reviewed plan whose keepDigests is negative', async () => {
    const planPath = path.join(dir, 'bad-keep.json');
    await writeFile(
      planPath,
      JSON.stringify({
        version: 1,
        shardDir: dir,
        keepDigests: -100,
        archiveStale: false,
        staleFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        staleCandidates: [],
      }),
      'utf8',
    );
    const r = await runCli(['--shard', dir, '--apply', '--from-plan', planPath, '--force', '--json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/keepDigests|--from-plan/);
  });

  it('declares tsx on the repo-root installer graph for node --import tsx', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.tsx).toMatch(/^\^4\./);
  });
});

describe('normalizeProcessComm (Codex P1 macOS ps paths)', () => {
  async function evalHost(script: string): Promise<unknown> {
    const helper = path.join(dir, 'host-comm-helper.mjs');
    const src =
      `import { isCindyHostComm, normalizeProcessComm } from ${JSON.stringify(pathToFileURL(cli).href)};\n` +
      `const out = ${script};\nprocess.stdout.write(JSON.stringify(out));\n`;
    await writeFile(helper, src, 'utf8');
    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', helper], {
        cwd: repoRoot,
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => {
        stdout += String(b);
      });
      child.stderr.on('data', (b) => {
        stderr += String(b);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
    if (r.code !== 0) {
      throw new Error(`host helper eval failed: ${r.stderr || r.stdout}`);
    }
    return JSON.parse(r.stdout) as unknown;
  }

  it('matches packaged macOS bundle executables by basename', async () => {
    const out = await evalHost(`({
      base: normalizeProcessComm('/Applications/Cindy.app/Contents/MacOS/Cindy'),
      cindy: isCindyHostComm('/Applications/Cindy.app/Contents/MacOS/Cindy'),
      cindydev: isCindyHostComm('/Applications/CindyDev.app/Contents/MacOS/CindyDev'),
      electron: isCindyHostComm('/Applications/Electron.app/Contents/MacOS/Electron'),
      packaged: isCindyHostComm('out/Cindy-darwin-arm64/Cindy.app/Contents/MacOS/Cindy'),
    })`);
    expect(out).toEqual({
      base: 'cindy',
      cindy: true,
      cindydev: true,
      electron: true,
      packaged: true,
    });
  });

  it('still matches linux-style bare comm names', async () => {
    const out = await evalHost(`({
      cindy: isCindyHostComm('cindy'),
      electron: isCindyHostComm('electron'),
      padded: isCindyHostComm('  Cindy  '),
    })`);
    expect(out).toEqual({ cindy: true, electron: true, padded: true });
  });

  it('does not treat unrelated apps as the Cindy host', async () => {
    const out = await evalHost(`({
      codex: isCindyHostComm('/Applications/Codex.app/Contents/MacOS/Codex'),
      python: isCindyHostComm('/usr/bin/python3'),
      header: isCindyHostComm('COMM'),
      empty: isCindyHostComm(''),
    })`);
    expect(out).toEqual({ codex: false, python: false, header: false, empty: false });
  });
});

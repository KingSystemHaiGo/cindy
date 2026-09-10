/**
 * cleanup-cli.test.ts — scripts/cleanup-maker-memory.mjs 审阅集绑定。
 *
 * Codex P1 on #2561: --apply --archive-stale 不得 live 重扫后归档未审阅 stale。
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
});

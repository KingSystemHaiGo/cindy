/**
 * memory/write.ts — memory_write tool
 *
 * 写入或覆盖 memory 分片。schema 强校验 (frontmatter + size + slug 路径) 在 storage
 * 层完成, 这里只接管 z.object 校验 + tool result 包装。
 *
 * mode 语义:
 *  - 'create' (默认): 撞名抛 ALREADY_EXISTS, LLM 应改 'update' 或 'append'
 *  - 'update'       : 覆盖现有 (不存在抛 NOT_FOUND)
 *  - 'append'       : 追加到 body 末尾 (不存在抛 NOT_FOUND)
 *
 * 返 WriteResult 含可选 warning ('shard-size-exceeded' / 'index-size-exceeded')
 * 与 warningDetail (sizeBytes/softLimitBytes;hardLimitBytes 仅分片警告带,
 * 索引警告无硬上限), LLM 按超限幅度决定不动 / 微剪 / memory_consolidate 瘦身。
 */

import { z } from 'zod';

import { buildJsonResult, withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';
import { isBotOnlyMemoryType, parseBotMemoryScopeKey, type WriteOptions } from '@cindy/maker-core';

export function registerMemoryWriteTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_write',
    category: 'write',
    description:
      '写入一条 memory 分片。type 必须是 user/feedback/project/reference/moment 之一; ' +
      'moment 仅伙伴(bot)记忆可用 (写用户的重要想法/重大时刻/说过的关键的话, 不记流水账), ' +
      '普通 workdir 记忆写 moment 会被拒绝; ' +
      'name 是 filename slug ([a-z0-9_-]{1,64}, 不是显示文本); title 显示标题 (中英均可); ' +
      'description 一行 hook (用作 MEMORY.md 索引行, 无换行, ≤ 200 字符); body 主体内容。' +
      'mode 默认 create (撞名拒绝), 可选 update/append。' +
      ' 写入后 MEMORY.md 自动重建; 软超 size 上限返 warning + warningDetail' +
      ' (sizeBytes/softLimitBytes, 分片警告另带 hardLimitBytes; 索引警告无硬上限),' +
      ' 按超限幅度决定不动 / 微剪 / memory_consolidate。',
    inputShape: {
      type: z.enum(['user', 'feedback', 'project', 'reference', 'moment']),
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9_-]+$/, 'slug 只允许 [a-z0-9_-]')
        .describe('filename slug, 不是显示文本'),
      title: z.string().min(1).max(100),
      description: z
        .string()
        .min(1)
        .max(200)
        .describe('一行 hook, 无换行, 用作 MEMORY.md 索引'),
      body: z.string().min(1),
      mode: z.enum(['create', 'update', 'append']).optional(),
      occurredAt: z
        .string()
        .max(40)
        .optional()
        .describe('moment 专用: 事件发生时间 (ISO 8601, e.g. 2026-09-08); 缺省 = 当前时刻'),
      significance: z
        .enum(['normal', 'high'])
        .optional()
        .describe('moment 专用: 重要程度; high = 重大想法/里程碑/明确强调'),
      sourceSession: z
        .string()
        .max(120)
        .optional()
        .describe('来源 session 引用 (轻量溯源); 一般由系统自动注入, 无需手填'),
    },
    handler: async (args) =>
      withStore(deps, async (store, scopeKey): Promise<unknown> => {
        // MCP 边界门禁 (#4124): bot-only 类型必须命中 bot scope。store 层也会拒绝
        // (invalid-type → INVALID_PARAMS), 这里先拦一层给出更直接的错误语义。
        if (isBotOnlyMemoryType(args.type) && parseBotMemoryScopeKey(scopeKey) === null) {
          return Promise.resolve(
            buildJsonResult(
              { ok: false, code: 'INVALID_PARAMS', message: 'moment 仅伙伴(bot)记忆可用; 当前 scope 不是 bot 记忆' },
              true,
            ),
          );
        }
        return store.write(args as WriteOptions);
      }),
  });
}

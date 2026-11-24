/**
 * 限流门面：把「桶名 + 上限 + 文案」的查表与抛错收敛到一处。
 * 调用方只描述"哪类动作、谁的 IP"，不再各自拼 bucket 与错误消息。
 */

import type { Context } from 'hono';
import type { Env } from './types';
import { checkRateLimit } from './db';
import { HttpError, RATE_LIMITS, RATE_WINDOW_MS, getClientIp, type RateKind } from './utils';

type Ctx = Context<{ Bindings: Env }>;

/** 返回 true 表示放行；false 表示已超限（调用方自行决定如何响应） */
export async function allowRate(db: D1Database, kind: RateKind, ip: string): Promise<boolean> {
  const rule = RATE_LIMITS[kind];
  return checkRateLimit(db, rule.bucket, ip, rule.max, RATE_WINDOW_MS);
}

/** 超限即抛 429，文案取自策略表 */
export async function enforceRate(db: D1Database, kind: RateKind, ip: string): Promise<void> {
  if (!(await allowRate(db, kind, ip))) throw new HttpError(429, RATE_LIMITS[kind].message);
}

/** 从请求里取 IP 后限流（绝大多数场景） */
export async function enforceRateFor(c: Ctx, kind: RateKind): Promise<void> {
  await enforceRate(c.env.DB, kind, getClientIp(c.req.raw.headers) || 'unknown');
}

/**
 * 定时维护：Cron 唯一入口，编排建表/过期/孤儿/限流/分片任务/无主码清理。
 * 单项失败不阻断其它项，全部结果汇总成一份日志。
 */

import type { Env } from './types';
import { initDB, cleanupRateLimits, takeExpiredFiles } from './db';
import { cleanupOrphanObjects } from './files';
import { cleanupStaleChunks, cleanupUnusedCodes } from './upload';
import { RATE_WINDOW_MS, fileKey, thumbKey } from './utils';
import { removeObjects } from './storage';

export interface MaintenanceReport {
  expiredFiles: number;
  r2Scanned: number;
  r2Removed: number;
  rateLimits: number;
  staleChunks: number;
  orphanCodes: number;
  errors: string[];
}

const step = async <T>(errors: string[], name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${name}: ${String(e)}`);
    return fallback;
  }
};

export async function runMaintenance(env: Env): Promise<MaintenanceReport> {
  const errors: string[] = [];

  // 建表失败时后续步骤都会失败，直接抛出让 Cron 记录
  await initDB(env.DB);

  const expired = await step(errors, 'expired', () => takeExpiredFiles(env.DB), []);
  await step(
    errors,
    'expiredObjects',
    () => removeObjects(env.FILE_STORE, expired.flatMap((f) => [fileKey(f.code), thumbKey(f.code)])),
    undefined,
  );

  const orphans = await step(errors, 'orphans', () => cleanupOrphanObjects(env), { scanned: 0, removed: 0 });
  const rateLimits = await step(errors, 'rateLimits', () => cleanupRateLimits(env.DB, RATE_WINDOW_MS), 0);
  const staleChunks = await step(errors, 'staleChunks', () => cleanupStaleChunks(env), 0);
  const orphanCodes = await step(errors, 'orphanCodes', () => cleanupUnusedCodes(env), 0);

  return {
    expiredFiles: expired.length,
    r2Scanned: orphans.scanned,
    r2Removed: orphans.removed,
    rateLimits,
    staleChunks,
    orphanCodes,
    errors,
  };
}

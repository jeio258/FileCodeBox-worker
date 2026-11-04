/** 运行时配置与过期策略：env 为默认值，D1 设置可覆盖（管理面板写入即生效）。 */

import type { Env, ExpireInput, RuntimeConfig } from './types';
import { getSettings } from './db';
import { DEFAULT_EXPIRE_DAYS, DEFAULT_MAX_SIZE } from './utils';

const toInt = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const toPositive = (v: unknown, fallback: number): number => {
  const n = toInt(v, fallback);
  return n > 0 ? n : fallback;
};

/** 单次查询合并三项配置，避免每个请求多次读表 */
export async function getConfig(env: Env): Promise<RuntimeConfig> {
  // 读设置失败时降级到 env 默认：避免首页/上传因 D1 抖动整体不可用
  const settings = await getSettings(env.DB, ['open_upload', 'max_file_size', 'default_expire_days']).catch(
    () => ({}) as Record<string, string>,
  );
  return {
    maxSize: toPositive(settings.max_file_size, toPositive(env.MAX_FILE_SIZE, DEFAULT_MAX_SIZE)),
    defaultExpireDays: toPositive(
      settings.default_expire_days,
      toPositive(env.DEFAULT_EXPIRE_DAYS, DEFAULT_EXPIRE_DAYS),
    ),
    openUpload: (settings.open_upload ?? '1') !== '0',
  };
}

/**
 * 过期参数统一入口：query / form / JSON 三种来源都先过这里，
 * 避免各处重复写字段别名与类型校验。
 */
export function expireInput(src: Record<string, unknown>): ExpireInput {
  const numOrStr = (key: string) => {
    const v = src[key];
    return typeof v === 'string' || typeof v === 'number' ? v : undefined;
  };
  return {
    expire_value: numOrStr('expire_value'),
    expire_days: numOrStr('expire_days'),
    expire_style: typeof src['expire_style'] === 'string' ? (src['expire_style'] as string) : undefined,
    max_downloads: numOrStr('max_downloads'),
  };
}

/** 过期样式 → 到期时间与次数上限（count 样式用 30 天兜底，避免永不过期） */
function parseExpire(expireValue: number, style: string): { expireAt: string; maxDownloads: number } {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  switch (style) {
    case 'hour':
      return { expireAt: at(expireValue * 3_600_000), maxDownloads: -1 };
    case 'minute':
      return { expireAt: at(expireValue * 60_000), maxDownloads: -1 };
    case 'count':
      return { expireAt: at(30 * 86_400_000), maxDownloads: expireValue };
    case 'forever':
      return { expireAt: at(100 * 365 * 86_400_000), maxDownloads: -1 };
    default:
      return { expireAt: at(expireValue * 86_400_000), maxDownloads: -1 };
  }
}

/**
 * 统一解析过期参数：兼容 expire_value（新）与 expire_days（旧），
 * 显式 max_downloads 优先于 expire_style=count 推出的次数。
 */
export function resolveExpire(input: ExpireInput, config: RuntimeConfig): { expireAt: string; maxDownloads: number } {
  const raw = input.expire_value ?? input.expire_days;
  const value = raw === undefined || raw === null || raw === ''
    ? config.defaultExpireDays
    : toInt(raw, config.defaultExpireDays);
  const { expireAt, maxDownloads } = parseExpire(value, String(input.expire_style ?? 'day'));
  const explicitMax = toInt(input.max_downloads, -1);
  return { expireAt, maxDownloads: explicitMax >= 0 ? explicitMax : maxDownloads };
}

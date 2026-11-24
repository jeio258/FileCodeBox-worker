/**
 * 过期策略：把 query / form / JSON 三种来源的过期参数统一解析为
 * 到期时间与下载次数上限。字段别名（expire_value/expire_days）只在此处处理。
 */

import type { ExpireInput, RuntimeConfig } from './types';
import { toInt } from './utils';

const DAY_MS = 86_400_000;

const pick = (src: Record<string, unknown>, ...names: string[]): string | number | undefined => {
  for (const name of names) {
    const v = src[name];
    if (typeof v === 'string' || typeof v === 'number') return v;
  }
  return undefined;
};

/** 从任意请求载荷提取过期参数（自动兼容新旧字段名） */
export function readExpireInput(src: Record<string, unknown>): ExpireInput {
  return {
    expireValue: pick(src, 'expire_value', 'expireValue'),
    expireDays: pick(src, 'expire_days', 'expireDays'),
    expireStyle: (() => {
      const v = pick(src, 'expire_style', 'expireStyle');
      return typeof v === 'string' ? v : undefined;
    })(),
    maxDownloads: pick(src, 'max_downloads', 'maxDownloads'),
  };
}

/** 样式 → 到期时间与次数上限（count 用 30 天兜底，避免永不过期记录） */
function byStyle(value: number, style: string): { expireAt: string; maxDownloads: number } {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  switch (style) {
    case 'hour':
      return { expireAt: at(value * 3_600_000), maxDownloads: -1 };
    case 'minute':
      return { expireAt: at(value * 60_000), maxDownloads: -1 };
    case 'count':
      return { expireAt: at(30 * DAY_MS), maxDownloads: value };
    case 'forever':
      return { expireAt: at(100 * 365 * DAY_MS), maxDownloads: -1 };
    default:
      return { expireAt: at(value * DAY_MS), maxDownloads: -1 };
  }
}

/**
 * 解析过期参数：显式 max_downloads 优先于 expire_style=count 推出的次数；
 * 值缺失/非法时回落配置里的默认天数。
 */
export function resolveExpire(
  input: ExpireInput,
  config: RuntimeConfig,
): { expireAt: string; maxDownloads: number } {
  const raw = input.expireValue ?? input.expireDays;
  const value =
    raw === undefined || raw === null || raw === ''
      ? config.defaultExpireDays
      : toInt(raw, config.defaultExpireDays);

  const { expireAt, maxDownloads } = byStyle(value, String(input.expireStyle ?? 'day'));
  const explicitMax = toInt(input.maxDownloads, -1);
  return { expireAt, maxDownloads: explicitMax >= 0 ? explicitMax : maxDownloads };
}

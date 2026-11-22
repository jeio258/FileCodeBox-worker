/**
 * 配置唯一入口。
 *
 * 优先级：D1 fc_settings（管理员可编辑，部署不丢） > env（wrangler.jsonc，缺值时兜底）
 *        > 内置默认。getConfig 不再写入，只在管理端更新时写 D1。
 * 读 D1 失败时整体降级到 env/默认，避免首页与上传因数据库抖动不可用。
 */

import type { Env, ExpireInput, RuntimeConfig } from './types';
import { getSettings, setSetting } from './db';
import { DEFAULT_EXPIRE_DAYS, DEFAULT_MAX_SIZE } from './utils';

export const CONFIG_KEYS = {
  maxSize: 'max_file_size',
  defaultExpireDays: 'default_expire_days',
  openUpload: 'open_upload',
  /** D1 侧密码哈希：Secret 缺失时兜底，保证部署后仍可登录 */
  passwordHash: 'admin_password_hash',
} as const;

export const MAX_SIZE_LIMIT = 1024 * 1024 * 1024; // 1GB 上限，防误配

const toInt = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const clampSize = (v: unknown, fallback: number): number => {
  const n = toInt(v, fallback);
  if (n < 1) return fallback;
  return Math.min(n, MAX_SIZE_LIMIT);
};

const clampDays = (v: unknown, fallback: number): number => {
  const n = toInt(v, fallback);
  if (n < 1) return fallback;
  return Math.min(n, 3650);
};

/** 三项配置一次查询；失败时回退 env/内置默认 */
export async function getConfig(env: Env): Promise<RuntimeConfig> {
  const settings = await getSettings(
    env.DB,
    [CONFIG_KEYS.maxSize, CONFIG_KEYS.defaultExpireDays, CONFIG_KEYS.openUpload],
  ).catch(() => ({}) as Record<string, string>);

  return {
    maxSize: clampSize(settings[CONFIG_KEYS.maxSize], clampSize(env.MAX_FILE_SIZE, DEFAULT_MAX_SIZE)),
    defaultExpireDays: clampDays(
      settings[CONFIG_KEYS.defaultExpireDays],
      clampDays(env.DEFAULT_EXPIRE_DAYS, DEFAULT_EXPIRE_DAYS),
    ),
    openUpload: (settings[CONFIG_KEYS.openUpload] ?? '1') !== '0',
  };
}

/** 管理端更新：字段名到存储键的唯一映射处，含范围校验 */
export async function updateConfig(env: Env, patch: Record<string, unknown>): Promise<RuntimeConfig> {
  const current = await getConfig(env);
  const writes: Promise<void>[] = [];

  if (patch.maxFileSize !== undefined) {
    writes.push(setSetting(env.DB, CONFIG_KEYS.maxSize, String(clampSize(patch.maxFileSize, current.maxSize))));
  }
  if (patch.defaultExpireDays !== undefined) {
    writes.push(
      setSetting(env.DB, CONFIG_KEYS.defaultExpireDays, String(clampDays(patch.defaultExpireDays, current.defaultExpireDays))),
    );
  }
  if (patch.openUpload !== undefined) {
    const open = patch.openUpload === true || patch.openUpload === '1' || patch.openUpload === 'true';
    writes.push(setSetting(env.DB, CONFIG_KEYS.openUpload, open ? '1' : '0'));
  }
  await Promise.all(writes);
  return getConfig(env);
}

/** 兼容 API 的字符串化输出（与历史字段保持一致） */
export function configToApi(config: RuntimeConfig) {
  return {
    openUpload: config.openUpload ? '1' : '0',
    maxFileSize: String(config.maxSize),
    defaultExpireDays: String(config.defaultExpireDays),
  };
}

/** 过期参数统一入口：query / form / JSON 三种来源都先过这里 */
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

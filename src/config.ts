/**
 * 运行配置：D1 设置（管理员可改，部署不丢） > env（wrangler.jsonc 兜底） > 内置默认。
 * 读 D1 失败时整体降级到 env/默认，避免首页与上传因数据库抖动不可用。
 */

import type { Env, RuntimeConfig } from './types';
import { getSettings, setSetting } from './db';
import {
  DEFAULT_EXPIRE_DAYS,
  DEFAULT_MAX_SIZE,
  MAX_CONFIG_EXPIRE_DAYS,
  MAX_CONFIG_SIZE,
  toBoundedInt,
} from './utils';

/** 配置项存储键（唯一映射处） */
export const CONFIG_KEYS = {
  maxSize: 'max_file_size',
  defaultExpireDays: 'default_expire_days',
  openUpload: 'open_upload',
  /** D1 侧密码哈希：Secret 缺失时兜底 */
  passwordHash: 'admin_password_hash',
} as const;

const CONFIG_READ_KEYS = [CONFIG_KEYS.maxSize, CONFIG_KEYS.defaultExpireDays, CONFIG_KEYS.openUpload];

export async function getConfig(env: Env): Promise<RuntimeConfig> {
  const settings = await getSettings(env.DB, CONFIG_READ_KEYS).catch(() => ({}) as Record<string, string>);

  return {
    maxSize: toBoundedInt(
      settings[CONFIG_KEYS.maxSize],
      toBoundedInt(env.MAX_FILE_SIZE, DEFAULT_MAX_SIZE, MAX_CONFIG_SIZE),
      MAX_CONFIG_SIZE,
    ),
    defaultExpireDays: toBoundedInt(
      settings[CONFIG_KEYS.defaultExpireDays],
      toBoundedInt(env.DEFAULT_EXPIRE_DAYS, DEFAULT_EXPIRE_DAYS, MAX_CONFIG_EXPIRE_DAYS),
      MAX_CONFIG_EXPIRE_DAYS,
    ),
    openUpload: (settings[CONFIG_KEYS.openUpload] ?? '1') !== '0',
  };
}

/** 管理端更新：字段名 → 存储键的唯一换算处，含范围夹取 */
export async function updateConfig(env: Env, patch: Record<string, unknown>): Promise<RuntimeConfig> {
  const current = await getConfig(env);
  const writes: Promise<void>[] = [];

  if (patch.maxFileSize !== undefined) {
    const value = toBoundedInt(patch.maxFileSize, current.maxSize, MAX_CONFIG_SIZE);
    writes.push(setSetting(env.DB, CONFIG_KEYS.maxSize, String(value)));
  }
  if (patch.defaultExpireDays !== undefined) {
    const value = toBoundedInt(patch.defaultExpireDays, current.defaultExpireDays, MAX_CONFIG_EXPIRE_DAYS);
    writes.push(setSetting(env.DB, CONFIG_KEYS.defaultExpireDays, String(value)));
  }
  if (patch.openUpload !== undefined) {
    const open = patch.openUpload === true || patch.openUpload === '1' || patch.openUpload === 'true';
    writes.push(setSetting(env.DB, CONFIG_KEYS.openUpload, open ? '1' : '0'));
  }
  await Promise.all(writes);
  return getConfig(env);
}

/** 兼容 API 输出形状（历史字段为字符串） */
export function configToApi(config: RuntimeConfig) {
  return {
    openUpload: config.openUpload ? '1' : '0',
    maxFileSize: String(config.maxSize),
    defaultExpireDays: String(config.defaultExpireDays),
  };
}

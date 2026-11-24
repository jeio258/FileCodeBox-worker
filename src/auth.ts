/**
 * 管理员认证。
 *
 * 密码来源（优先级）：env.ADMIN_PASSWORD（Secret）→ D1 admin_password_hash（部署不丢）→ 均无则拒绝登录。
 * 会话 token 存 fc_state，与配置分离；登出/改密都会清空 token 使旧会话立即失效。
 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, RuntimeConfig } from './types';
import {
  ADMIN_MIN_PASSWORD_LEN,
  ADMIN_TOKEN_KEY,
  ADMIN_TOKEN_MAX_AGE,
  HttpError,
  MESSAGES,
  RATE_LIMITS,
  getClientIp,
  hashPassword,
  timingSafeCompare,
} from './utils';
import { getSetting, getState, setSetting, setState } from './db';
import { allowRate } from './rate';
import { CONFIG_KEYS } from './config';

type Ctx = Context<{ Bindings: Env }>;

export type LoginResult =
  | { success: true; token: string }
  | { success: false; error: string; status: 401 | 429 };

const NO_PASSWORD_HINT =
  '未配置管理员密码：请运行 wrangler secret put ADMIN_PASSWORD，或通过 /api/admin/password 设置（存入 D1，部署后仍有效）';

/** 按密码值缓存哈希，避免每次登录重复 PBKDF2，同时避免密码轮换后命中旧值 */
let cachedSecretHash: { password: string; hash: string } | null = null;

/** 解析当前有效密码哈希：Secret 优先，D1 兜底；D1 异常按"未配置"处理而非 500 */
async function resolvePasswordHash(env: Env): Promise<string | null> {
  if (env.ADMIN_PASSWORD) {
    if (cachedSecretHash?.password !== env.ADMIN_PASSWORD) {
      cachedSecretHash = { password: env.ADMIN_PASSWORD, hash: await hashPassword(env.ADMIN_PASSWORD) };
    }
    return cachedSecretHash.hash;
  }
  return getSetting(env.DB, CONFIG_KEYS.passwordHash).catch(() => null);
}

/** 是否已具备可登录的密码（供 /api/status 自检与部署排障） */
export async function isAdminPasswordConfigured(env: Env): Promise<boolean> {
  return (await resolvePasswordHash(env).catch(() => null)) !== null;
}

/** Cookie 或 Bearer token 是否有效 */
export async function isAdminAuthed(c: Ctx, env: Env): Promise<boolean> {
  const token = getCookie(c, ADMIN_TOKEN_KEY) ?? c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;
  try {
    return timingSafeCompare(token, (await getState(env.DB, ADMIN_TOKEN_KEY)) ?? '');
  } catch {
    return false;
  }
}

export async function login(c: Ctx, env: Env, inputPassword: string): Promise<LoginResult> {
  const expected = await resolvePasswordHash(env);
  if (!expected) return { success: false, error: NO_PASSWORD_HINT, status: 401 };

  const ip = getClientIp(c.req.raw.headers) || 'unknown';
  if (!(await allowRate(env.DB, 'login', ip))) {
    return { success: false, error: RATE_LIMITS.login.message, status: 429 };
  }

  if (!timingSafeCompare(await hashPassword(inputPassword), expected)) {
    return { success: false, error: '密码错误', status: 401 };
  }

  const token = crypto.randomUUID();
  await setState(env.DB, ADMIN_TOKEN_KEY, token);
  setCookie(c, ADMIN_TOKEN_KEY, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: ADMIN_TOKEN_MAX_AGE,
    path: '/',
  });
  return { success: true, token };
}

export async function logout(c: Ctx, env: Env): Promise<void> {
  deleteCookie(c, ADMIN_TOKEN_KEY, { path: '/' });
  // 清 DB token，防已泄露 token 继续可用
  await setState(env.DB, ADMIN_TOKEN_KEY, '').catch(() => {});
}

/**
 * 修改密码：写入 D1 哈希（部署不丢）并轮换会话。
 * 已存在密码时校验当前密码；完全无密码时要求已是管理员（Secret 或已有会话）。
 */
export async function changePassword(
  c: Ctx,
  env: Env,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!newPassword || newPassword.length < ADMIN_MIN_PASSWORD_LEN) {
    throw new HttpError(422, `新密码至少 ${ADMIN_MIN_PASSWORD_LEN} 位`);
  }

  const expected = await resolvePasswordHash(env);
  if (expected) {
    if (!timingSafeCompare(await hashPassword(currentPassword), expected)) {
      throw new HttpError(401, '当前密码错误');
    }
  } else if (!(await isAdminAuthed(c, env))) {
    throw new HttpError(401, '当前未设置密码，请先登录或配置 Secret');
  }

  await setSetting(env.DB, CONFIG_KEYS.passwordHash, await hashPassword(newPassword));
  await setState(env.DB, ADMIN_TOKEN_KEY, '').catch(() => {});
  deleteCookie(c, ADMIN_TOKEN_KEY, { path: '/' });
}

/** 游客上传关闭时（open_upload=0）要求管理员身份 */
export async function assertUploadAllowed(c: Ctx, config: RuntimeConfig): Promise<void> {
  if (config.openUpload) return;
  if (await isAdminAuthed(c, c.env)) return;
  throw new HttpError(401, MESSAGES.uploadDisabled);
}

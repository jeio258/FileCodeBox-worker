/** 管理员认证与上传门控。 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, RuntimeConfig } from './types';
import { HttpError, LOGIN_RATE_MAX, RATE_WINDOW_MS, getClientIp, hashPassword, timingSafeCompare } from './utils';
import { checkRateLimit, getSetting, setSetting } from './db';

const TOKEN_KEY = 'admin_token';
const TOKEN_MAX_AGE = 86_400;

/** 按密码值缓存哈希，避免每次登录重复 PBKDF2，同时避免密码轮换后命中旧值 */
let cachedHash: { password: string; hash: string } | null = null;

async function secretHash(env: Env): Promise<string | null> {
  if (!env.ADMIN_PASSWORD) return null;
  if (cachedHash?.password !== env.ADMIN_PASSWORD) {
    cachedHash = { password: env.ADMIN_PASSWORD, hash: await hashPassword(env.ADMIN_PASSWORD) };
  }
  return cachedHash.hash;
}

/** Cookie 或 Bearer token 是否有效 */
export async function adminAuth(c: Context<{ Bindings: Env }>, env: Env): Promise<boolean> {
  const token = getCookie(c, TOKEN_KEY) ?? c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;
  try {
    const stored = await getSetting(env.DB, TOKEN_KEY);
    return timingSafeCompare(token, stored ?? '');
  } catch {
    return false;
  }
}

export async function handleAdminLogin(
  c: Context<{ Bindings: Env }>,
  env: Env,
  inputPassword: string,
): Promise<{ success: true; token: string } | { success: false; error: string }> {
  const expected = await secretHash(env);
  if (!expected) {
    return { success: false, error: '未配置管理员密码，请运行 wrangler secret put ADMIN_PASSWORD 设置' };
  }

  const ip = getClientIp(c.req.raw.headers) || 'unknown';
  if (!(await checkRateLimit(env.DB, 'login_ratelimit', ip, LOGIN_RATE_MAX, RATE_WINDOW_MS))) {
    return { success: false, error: '尝试次数过多，请稍后再试' };
  }

  if (!timingSafeCompare(await hashPassword(inputPassword), expected)) {
    return { success: false, error: '密码错误' };
  }

  const token = crypto.randomUUID();
  await setSetting(env.DB, TOKEN_KEY, token);
  setCookie(c, TOKEN_KEY, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: TOKEN_MAX_AGE,
    path: '/',
  });
  return { success: true, token };
}

export async function handleAdminLogout(c: Context, env: Env): Promise<void> {
  deleteCookie(c, TOKEN_KEY, { path: '/' });
  // 同时清 DB token，防止已泄露的 token 继续可用
  await setSetting(env.DB, TOKEN_KEY, '').catch(() => {});
}

/** 游客上传开关关闭时（open_upload=0）要求管理员身份 */
export async function assertUploadAllowed(c: Context<{ Bindings: Env }>, config: RuntimeConfig): Promise<void> {
  if (config.openUpload) return;
  if (await adminAuth(c, c.env)) return;
  throw new HttpError(401, '游客上传已关闭，请先登录');
}

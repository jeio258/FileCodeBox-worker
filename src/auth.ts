/**
 * 管理员认证。
 *
 * 密码来源（按优先级，覆盖部署后 Secret 被清空的情况）：
 *   1. env.ADMIN_PASSWORD（Secret，推荐）
 *   2. D1 fc_settings.admin_password_hash（通过管理端改密码写入，部署不丢）
 *   3. 都没有 → 明确报错，并通过 /api/status 暴露，避免"静默无法登录"
 * 会话 token 存 fc_state，与配置分离。
 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, RuntimeConfig } from './types';
import {
  HttpError,
  LOGIN_RATE_MAX,
  RATE_WINDOW_MS,
  getClientIp,
  hashPassword,
  timingSafeCompare,
} from './utils';
import { checkRateLimit, getSetting, getState, setSetting, setState } from './db';
import { CONFIG_KEYS } from './config';

const TOKEN_KEY = 'admin_token';
const TOKEN_MAX_AGE = 86_400;

/** 按密码值缓存哈希，避免每次登录重复 PBKDF2，同时避免密码轮换后命中旧值 */
let cachedSecretHash: { password: string; hash: string } | null = null;

/**
 * 解析当前有效的密码哈希。
 * Secret 存在时忽略 D1（Secret 为最高优先级），否则用 D1 哈希兜底。
 */
async function resolvePasswordHash(env: Env): Promise<{ hash: string; source: 'secret' | 'db' } | null> {
  if (env.ADMIN_PASSWORD) {
    if (cachedSecretHash?.password !== env.ADMIN_PASSWORD) {
      cachedSecretHash = { password: env.ADMIN_PASSWORD, hash: await hashPassword(env.ADMIN_PASSWORD) };
    }
    return { hash: cachedSecretHash.hash, source: 'secret' };
  }
  // D1 异常不应让登录变成 500：按"未配置密码"处理并给出明确提示
  const stored = await getSetting(env.DB, CONFIG_KEYS.passwordHash).catch(() => null);
  return stored ? { hash: stored, source: 'db' } : null;
}

/** 是否已具备可登录的密码（供状态接口与部署自检使用） */
export async function adminPasswordConfigured(env: Env): Promise<boolean> {
  return (await resolvePasswordHash(env).catch(() => null)) !== null;
}

/** Cookie 或 Bearer token 是否有效 */
export async function adminAuth(c: Context<{ Bindings: Env }>, env: Env): Promise<boolean> {
  const token = getCookie(c, TOKEN_KEY) ?? c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;
  try {
    const stored = await getState(env.DB, TOKEN_KEY);
    return timingSafeCompare(token, stored ?? '');
  } catch {
    return false;
  }
}

const NO_PASSWORD_HINT =
  '未配置管理员密码：请运行 wrangler secret put ADMIN_PASSWORD，或通过 /api/admin/password 设置（存入 D1，部署后仍有效）';

export async function handleAdminLogin(
  c: Context<{ Bindings: Env }>,
  env: Env,
  inputPassword: string,
): Promise<{ success: true; token: string } | { success: false; error: string; status: 401 | 429 }> {
  const resolved = await resolvePasswordHash(env);
  if (!resolved) return { success: false, error: NO_PASSWORD_HINT, status: 401 };

  const ip = getClientIp(c.req.raw.headers) || 'unknown';
  if (!(await checkRateLimit(env.DB, 'login_ratelimit', ip, LOGIN_RATE_MAX, RATE_WINDOW_MS))) {
    return { success: false, error: '尝试次数过多，请稍后再试', status: 429 };
  }

  if (!timingSafeCompare(await hashPassword(inputPassword), resolved.hash)) {
    return { success: false, error: '密码错误', status: 401 };
  }

  const token = crypto.randomUUID();
  await setState(env.DB, TOKEN_KEY, token);
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
  // 清 DB token，防止已泄露 token 继续可用
  await setState(env.DB, TOKEN_KEY, '').catch(() => {});
}

/**
 * 修改密码：写入 D1 哈希（部署不丢），并让旧会话失效。
 * 需已登录；若当前无任何密码（首次引导），需 env.ADMIN_PASSWORD 作为当前密码。
 */
export async function changeAdminPassword(
  c: Context<{ Bindings: Env }>,
  env: Env,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!newPassword || newPassword.length < 6) throw new HttpError(422, '新密码至少 6 位');

  const resolved = await resolvePasswordHash(env);
  if (resolved && !timingSafeCompare(await hashPassword(currentPassword), resolved.hash)) {
    throw new HttpError(401, '当前密码错误');
  }
  if (!resolved && !(await adminAuth(c, env))) {
    throw new HttpError(401, '当前未设置密码，请先登录或配置 Secret');
  }

  await setSetting(env.DB, CONFIG_KEYS.passwordHash, await hashPassword(newPassword));
  // 轮换会话：旧 token 立即失效
  await setState(env.DB, TOKEN_KEY, '').catch(() => {});
  deleteCookie(c, TOKEN_KEY, { path: '/' });
}

/** 游客上传开关关闭时（open_upload=0）要求管理员身份 */
export async function assertUploadAllowed(c: Context<{ Bindings: Env }>, config: RuntimeConfig): Promise<void> {
  if (config.openUpload) return;
  if (await adminAuth(c, c.env)) return;
  throw new HttpError(401, '游客上传已关闭，请先登录');
}

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types';
import { hashPassword, generateCode } from './utils';
import { getSetting, setSetting } from './db';

/**
 * 验证管理员是否已登录。
 * 返回 true 表示已认证，false 需要登录。
 */
export async function adminAuth(c: Context<{ Bindings: Env }>, env: Env): Promise<boolean> {
  const token =
    getCookie(c, 'admin_token') ??
    c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;

  try {
    const stored = await getSetting(env.DB, 'admin_token');
    return stored === token;
  } catch {
    return false;
  }
}

/**
 * 管理员登录处理。
 * 只做哈希比较（无明文回退）。
 * 首次运行时自动将 ADMIN_PASSWORD 环境变量哈希后存入 DB。
 */
export async function handleAdminLogin(
  c: Context<{ Bindings: Env }>,
  env: Env,
  inputPassword: string,
): Promise<{ success: true } | { success: false; error: string }> {
  // 确保密码已存入 DB（首次运行时从环境变量初始化）
  let storedHash = await getSetting(env.DB, 'admin_password');
  if (!storedHash) {
    storedHash = await hashPassword(env.ADMIN_PASSWORD || 'admin123');
    await setSetting(env.DB, 'admin_password', storedHash);
  }

  const inputHash = await hashPassword(inputPassword);
  if (inputHash !== storedHash) {
    return { success: false, error: '密码错误' };
  }

  const token = crypto.randomUUID();
  await setSetting(env.DB, 'admin_token', token);

  setCookie(c, 'admin_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: 86400,
    path: '/',
  });

  return { success: true };
}

/** 管理员登出 */
export function handleAdminLogout(c: Context): void {
  deleteCookie(c, 'admin_token', { path: '/' });
}

// ---- 简易登录速率限制（KV based） ----

const RATE_LIMIT_WINDOW = 60; // 秒
const RATE_LIMIT_MAX = 5;     // 窗口内最大尝试次数

export async function checkLoginRateLimit(
  kv: KVNamespace,
  ip: string,
): Promise<boolean> {
  const key = `ratelimit:login:${ip}`;
  const val = await kv.get(key);
  const count = val ? parseInt(val) : 0;
  if (count >= RATE_LIMIT_MAX) return false;

  await kv.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW,
  });
  return true;
}

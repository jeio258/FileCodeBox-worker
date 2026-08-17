import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types';
import { hashPassword } from './utils';
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
 * 密码只存在 Cloudflare Secret（ADMIN_PASSWORD），不落盘、不写 DB。
 */
export async function handleAdminLogin(
  c: Context<{ Bindings: Env }>,
  env: Env,
  inputPassword: string,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!env.ADMIN_PASSWORD) {
    return { success: false, error: '未配置管理员密码，请运行 wrangler secret put ADMIN_PASSWORD 设置' };
  }

  const inputHash = await hashPassword(inputPassword);
  const secretHash = await hashPassword(env.ADMIN_PASSWORD);
  if (inputHash !== secretHash) {
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

/**
 * 可选 Turnstile 人机校验。
 * 站点键与密钥都配置后才能在后台开启；未配置时视为关闭，不影响上传。
 */

import type { Env } from './types';
import { HttpError, getClientIp } from './utils';
import { isAdminAuthed } from './auth';
import type { Context } from 'hono';

type Ctx = Context<{ Bindings: Env }>;

export const turnstileSiteKey = (env: Env): string => env.TURNSTILE_SITE_KEY?.trim() ?? '';

export const turnstileConfigured = (env: Env): boolean =>
  Boolean(env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET?.trim());

/** 校验令牌：管理员免校验；未配置凭证时放行（避免误开关导致全站不能传） */
export async function assertTurnstile(
  c: Ctx,
  env: Env,
  enabled: boolean,
  formToken?: string,
): Promise<void> {
  if (!enabled || !turnstileConfigured(env)) return;
  if (await isAdminAuthed(c, env)) return;

  const token = (formToken ?? c.req.header('X-Turnstile-Token') ?? '').trim();
  if (!token) throw new HttpError(403, '请先完成人机校验');

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET!.trim());
  form.append('response', token);
  const ip = getClientIp(c.req.raw.headers);
  if (ip) form.append('remoteip', ip);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  }).catch(() => null);
  const data = (await res?.json().catch(() => null)) as { success?: boolean } | null;
  if (!data?.success) throw new HttpError(403, '人机校验未通过，请重试');
}

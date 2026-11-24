/**
 * 边缘缓存：Cloudflare 不会自动缓存 Worker 响应（响应头里看不到 cf-cache-status），
 * 想让"只依赖配置"的页面真正命中边缘，必须显式用 Cache API。
 *
 * 只缓存匿名、无 Cookie 的 GET；带 Cookie 或 Authorization 一律跳过，
 * 避免把管理员/私密内容落到共享缓存。
 */

import type { Context } from 'hono';
import type { Env } from './types';

type Ctx = Context<{ Bindings: Env }>;

/** 请求是否适合走共享缓存 */
export function cacheable(c: Ctx): boolean {
  if (c.req.method !== 'GET') return false;
  if (c.req.header('Authorization') || c.req.header('Cookie')) return false;
  const cacheControl = c.req.header('Cache-Control');
  return !cacheControl || !/no-store|no-cache/i.test(cacheControl);
}

/**
 * 读缓存 → 命中直接返回；未命中执行 render 并按 ttl 写入缓存。
 * 缓存键用请求 URL（含 query），因此 /?a=1 与 / 分开缓存。
 */
export async function cached(c: Ctx, ttl: number, render: () => Promise<Response>): Promise<Response> {
  if (!cacheable(c)) return render();

  const cache = await caches.open('fcb-edge');
  const key = new Request(c.req.url, { method: 'GET' });

  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit;

  const res = await render();
  if (res.status !== 200) return res;

  // 复制一份：原响应体只能读一次；头可能是 immutable，必须新建而不是改原响应
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`);
  const toCache = new Response(res.body, { status: res.status, headers });
  const toReturn = new Response(toCache.clone().body, { status: res.status, headers: new Headers(headers) });

  // 后台写入，不阻塞响应；拿不到 executionCtx（非 Workers 上下文）时退化为同步等待
  const write = cache.put(key, toCache).catch(() => {});
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    await write;
  }
  return toReturn;
}

/**
 * 页面路由：首页、取件落地页、文件/文本取件页。
 * 页面内容随配置变化，首页短缓存，其余 no-store（避免私密内容被边缘缓存）。
 */

import type { Hono } from 'hono';
import type { Env } from '../types';
import { getConfig } from '../config';
import { getFileByCode } from '../db';
import { homePage, retrievePage, filePage } from '../templates/pages';
import { turnstileConfigured, turnstileSiteKey } from '../turnstile';
import { PLAIN_UPLOAD_LIMIT, getBaseUrl } from '../utils';
import { pathParam, type Ctx } from '../respond';
import { cached } from '../cache';

const noStore = (c: Ctx) => c.header('Cache-Control', 'no-store');
const baseUrl = (c: Ctx) => getBaseUrl(new URL(c.req.url).origin, c.req.header('host'));

/** 首页渲染：分片阈值取 min(配置上限, 平台单请求上限) */
async function renderHome(c: Ctx): Promise<Response> {
  const config = await getConfig(c.env);
  return c.html(
    homePage({
      chunkThreshold: Math.min(config.maxSize, PLAIN_UPLOAD_LIMIT),
      maxFileSize: config.maxSize,
      defaultExpireDays: config.defaultExpireDays,
      turnstileSiteKey: config.turnstileEnabled && turnstileConfigured(c.env) ? turnstileSiteKey(c.env) : '',
    }),
  );
}
export function registerPageRoutes(app: Hono<{ Bindings: Env }>): void {

  app.get('/', (c) =>
    // 首页只依赖配置（上限/天数/Turnstile）：用 Cache API 落到边缘，
    // 避免每次请求都跑一遍 Worker + 查 D1（实测这部分占 TTFB ~370ms）。
    cached(c, 30, async () => {
      const res = await renderHome(c);
      res.headers.set('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=300');
      return res;
    }),
  );

  app.get('/r', (c) => {
    const code = (c.req.query('code') ?? '').trim();
    if (code) return c.redirect(`/r/${code}`);
    noStore(c);
    return c.html(retrievePage());
  });

  app.get('/r/:code', async (c) => {
    noStore(c);
    const code = pathParam(c, 'code');
    const file = await getFileByCode(c.env.DB, code);
    return c.html(file ? filePage(file, baseUrl(c)) : retrievePage(code));
  });

}
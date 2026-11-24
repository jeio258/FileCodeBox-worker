/**
 * 静态资源路由：样式表、首页脚本、背景图。
 * 三者都带内容哈希/固定 URL + immutable 长缓存，改动靠 URL 变化失效。
 */

import type { Hono } from 'hono';
import type { Env } from '../types';
import { STYLE } from '../templates/style';
import { HOME_JS } from '../templates/home-script';

const IMMUTABLE = 'public, max-age=31536000, immutable';
export function registerStaticRoutes(app: Hono<{ Bindings: Env }>): void {

  app.get('/static/style.css', () =>
    new Response(STYLE, {
      headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': IMMUTABLE },
    }),
  );

  // 首页脚本外置：内容哈希换 URL + immutable，避免每次请求都重新下载 ~19KB 内联 JS
  app.get('/static/home.js', () =>
    new Response(HOME_JS, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': IMMUTABLE,
        'X-Content-Type-Options': 'nosniff',
      },
    }),
  );

  // 背景图本地提供：固定 URL + 长缓存（替代外部随机图源的跳转与超大图）
  app.get('/static/bg.webp', async (c) => {
    const obj = await c.env.FILE_STORE.get('bg.webp');
    if (!obj) return new Response('Not Found', { status: 404 });
    return new Response(obj.body, {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': IMMUTABLE, 'X-Content-Type-Options': 'nosniff' },
    });
  });

}
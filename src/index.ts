/**
 * FileCodeBox Worker 入口：中间件、惰性建表、路由装配与 Cron。
 * Web 路由见 routes/web.ts，兼容 API 见 routes/compat.ts。
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Env } from './types';
import { SCHEMA_VERSION, getSchemaVersion, initDB } from './db';
import { runMaintenance } from './maintenance';
import { errorPage } from './templates/pages';
import { registerStaticRoutes } from './routes/static';
import { registerPageRoutes } from './routes/pages';
import { registerApiRoutes } from './routes/api';
import { registerAdminRoutes } from './routes/admin';
import compatApi from './routes/compat';

const app = new Hono<{ Bindings: Env }>();

// ===================== 中间件 =====================

app.use('*', cors({ origin: 'self', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }));

const CSP =
  "default-src 'self'; " +
  // Cloudflare Web Analytics 由边缘自动注入，不放开会被 CSP 拦掉并产生控制台报错
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com; " +
  "connect-src 'self' https://cloudflareinsights.com https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https://t.alcy.cc https://q1.qlogo.cn https: data: blob:; " +
  "object-src 'none'; " +
  "frame-ancestors 'none';";

app.use('*', async (c, next) => {
  await next();

  // 注意：c.html()/c.json() 返回的响应头是 immutable，直接 set 会抛
  // TypeError: Can't modify immutable headers —— 必须重建响应再写头。
  const headers = new Headers(c.res.headers);
  // 私密内容与状态接口一律不缓存（页面另在各自路由设 no-store）
  if (c.req.path.startsWith('/api/')) headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', CSP);

  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

// ===================== 惰性建表 =====================
// 由库内 schema_version 驱动：缺表或版本落后时补建（新增表/列不会漏）。
// 不能用"探某张老表是否存在"判断——老表存在、新表缺失时会被误判为就绪。
let readyVersion: number | null = null;

async function ensureSchema(db: D1Database): Promise<void> {
  if (readyVersion === SCHEMA_VERSION) return;
  if ((await getSchemaVersion(db)) !== SCHEMA_VERSION) await initDB(db);
  readyVersion = SCHEMA_VERSION;
}

app.use('*', async (c, next) => {
  // 建表失败不阻断请求：后续查询会暴露具体错误，避免整站 500
  await ensureSchema(c.env.DB).catch((e) => {
    console.error(JSON.stringify({ event: 'schema_ensure_failed', error: String(e) }));
  });
  await next();
});

// ===================== 路由装配 =====================

// 装配顺序即匹配优先级：静态 → 页面 → 业务 API → 管理/自检 → 兼容 API → 兜底
registerStaticRoutes(app);
registerPageRoutes(app);
registerApiRoutes(app);
registerAdminRoutes(app);

// 兼容 API 必须晚于 Web 路由注册，未知 /api/* 返回 404 而不是落到首页
app.route('/api', compatApi);
app.all('/api/*', (c) => c.json({ code: 404, msg: 'Not Found' }, 404));

// 全站兜底必须最后注册，否则会抢在兼容 API 之前吃掉 /api/* 请求
// 未知路径返回真正的 404（不再回首页冒充正常页面）
app.all('*', (c) => c.html(errorPage('页面不存在', '请检查地址是否正确'), 404));

// ===================== 入口 =====================

export default {
  fetch: app.fetch,

  /** Cron：幂等建表 + 过期/孤儿/限流/分片任务/无主码清理 */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const report = await runMaintenance(env);
          console.log(JSON.stringify({ event: 'scheduled_cleanup', ...report }));
        } catch (e) {
          console.error(JSON.stringify({ event: 'scheduled_cleanup_error', error: String(e) }));
        }
      })(),
    );
  },
};

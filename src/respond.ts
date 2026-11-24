/**
 * 路由响应层：三种对外形态的唯一出口，避免每个路由各写一套 try/catch。
 *   json   — Web JSON：错误 `{ error }`
 *   html   — 页面：错误渲染错误页
 *   compat — 兼容 API：`{ code, msg, detail }`
 * 未知异常一律掩码，只记录日志，不向客户端泄露内部实现。
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './types';
import { MESSAGES, publicMessage, statusOf } from './utils';
import { errorPage } from './templates/pages';

export type Ctx = Context<{ Bindings: Env }>;

export const statusCode = (e: unknown, fallback = 500) => statusOf(e, fallback) as ContentfulStatusCode;

export const json =
  (fn: (c: Ctx) => Promise<Response>) =>
  async (c: Ctx): Promise<Response> => {
    try {
      return await fn(c);
    } catch (e) {
      return c.json({ error: publicMessage(e, MESSAGES.internal) }, statusCode(e));
    }
  };

export const html =
  (fn: (c: Ctx) => Promise<Response>) =>
  async (c: Ctx): Promise<Response> => {
    try {
      return await fn(c);
    } catch (e) {
      return c.html(errorPage(publicMessage(e, '操作失败'), ''), statusCode(e));
    }
  };

export const compatOk = (c: Ctx, detail: unknown, msg = 'success') => c.json({ code: 200, msg, detail });

export const compatFail = (c: Ctx, status: number, msg: string) =>
  c.json({ code: status, msg }, status as ContentfulStatusCode);

export const compat =
  (fn: (c: Ctx) => Promise<Response>) =>
  async (c: Ctx): Promise<Response> => {
    try {
      return await fn(c);
    } catch (e) {
      return compatFail(c, statusOf(e), publicMessage(e, MESSAGES.internal));
    }
  };

// ===================== 请求参数 =====================

/** 取件码：兼容 path 参数与 query 的 code/key 两种写法 */
export const codeOf = (c: Ctx): string =>
  (c.req.param('code') ?? c.req.query('code') ?? c.req.query('key') ?? '').trim();

/** 路径参数（去空白，缺失返回空串） */
export const pathParam = (c: Ctx, name: string): string => (c.req.param(name) ?? '').trim();

export const isHead = (c: Ctx): boolean => c.req.method === 'HEAD';

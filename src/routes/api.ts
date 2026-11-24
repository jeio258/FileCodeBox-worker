/**
 * 业务 API 路由：上传（普通/文本/分片）、读取（文本/下载/信息/二维码）、
 * 批量取件码与缩略图。全部走 respond.ts 的统一出口。
 */

import type { Hono } from 'hono';
import type { Env } from '../types';
import { getConfig } from '../config';
import { getFileByCode } from '../db';
import { assertUploadAllowed } from '../auth';
import { buildDownloadResponse, readThumb, resolveShare, saveThumb } from '../files';
import { allocateCodeRun, chunkAbort, chunkComplete, chunkInit, chunkPut, chunkStatus, uploadFile, uploadText } from '../upload';
import { enforceRateFor } from '../rate';
import { MESSAGES, getBaseUrl, getClientIp, isValidCode, toInt } from '../utils';
import { generateQRCodeGIF } from '../qr';
import { errorPage } from '../templates/pages';
import { html, json, codeOf, isHead, pathParam, type Ctx } from '../respond';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const baseUrl = (c: Ctx) => getBaseUrl(new URL(c.req.url).origin, c.req.header('host'));

export function registerApiRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(
    '/api/upload',
    json(async (c) => c.json(await uploadFile(c, c.env))),
  );

  // 文本上传：成功后 303 到取件页（PRG，避免刷新重复提交）
  app.post(
    '/api/upload/text',
    html(async (c) => {
      const result = await uploadText(c, c.env);
      return c.redirect(`/r/${result.code}`, 303);
    }),
  );

  // 分片接口对外字段保持 snake_case（线上已使用的契约），内部模型为 camelCase
  app.post(
    '/api/upload/chunk/init',
    json(async (c) => {
      const r = await chunkInit(c, c.env);
      return c.json({ upload_id: r.uploadId, code: r.code, chunk_size: r.chunkSize, total_chunks: r.totalChunks });
    }),
  );
  app.put('/api/upload/chunk/:upload_id/:index', json(async (c) => c.json(await chunkPut(c, c.env))));
  app.get(
    '/api/upload/chunk/status/:upload_id',
    json(async (c) => {
      const r = await chunkStatus(c, c.env);
      return c.json({ upload_id: r.uploadId, code: r.code, total_chunks: r.totalChunks, received: r.received });
    }),
  );
  app.post('/api/upload/chunk/complete/:upload_id', json(async (c) => c.json(await chunkComplete(c, c.env))));
  app.post('/api/upload/chunk/abort/:upload_id', json(async (c) => c.json(await chunkAbort(c, c.env))));

  app.get(
    '/api/text/:code',
    json(async (c) => {
      const lookup = await resolveShare(c.env, codeOf(c), {
        count: true,
        isHead: isHead(c),
        textOnly: true,
        clientIp: getClientIp(c.req.raw.headers),
      });
      if (lookup.status === 'notFound') return c.text('Not found', 404);
      if (lookup.status === 'maxExceeded') return c.text('Max downloads exceeded', 403);
      return c.text(await lookup.obj.text());
    }),
  );

  app.get(
    '/api/download/:code',
    html(async (c) => {
      const lookup = await resolveShare(c.env, codeOf(c), {
        count: true,
        isHead: isHead(c),
        clientIp: getClientIp(c.req.raw.headers),
      });
      if (lookup.status === 'notFound') return c.html(errorPage(MESSAGES.notFound, '该文件可能已被清理'), 404);
      if (lookup.status === 'maxExceeded') {
        return c.html(errorPage(MESSAGES.maxExceeded, '该文件的下载次数已用完'), 403);
      }
      return buildDownloadResponse(lookup.file, lookup.obj, isHead(c));
    }),
  );

  app.get(
    '/api/info/:code',
    json(async (c) => {
      const file = await getFileByCode(c.env.DB, codeOf(c));
      if (!file) return c.json({ error: 'not found' }, 404);
      return c.json({
        // 达查看上限后按下游口径遮蔽标题，避免正文被拒读而标题仍泄露
        filename:
          file.isText && file.maxDownloads >= 0 && file.downloadCount >= file.maxDownloads
            ? '***'
            : file.filename,
        size: file.size,
        download_count: file.downloadCount,
        max_downloads: file.maxDownloads,
        expire_at: file.expireAt,
      });
    }),
  );

  app.get('/qrcode/:code', async (c) => {
    const code = pathParam(c, 'code');
    if (!isValidCode(code)) return c.text('Invalid code', 400);
    if (!(await getFileByCode(c.env.DB, code))) return c.text('File not found', 404);

    const gif = generateQRCodeGIF(`${baseUrl(c)}/r/${code}`);
    return new Response(gif as unknown as BodyInit, {
      headers: { 'Content-Type': 'image/gif', 'Cache-Control': IMMUTABLE },
    });
  });

  app.get(
    '/api/codes/:count',
    json(async (c) => {
      await assertUploadAllowed(c, await getConfig(c.env));
      // 取件码只有 1 万个，批量接口用更紧的独立配额，避免被用来耗尽码空间
      await enforceRateFor(c, 'codes');
      return c.json({ codes: await allocateCodeRun(c.env, toInt(pathParam(c, 'count'), 0)) });
    }),
  );

  app.post(
    '/api/thumb/:code',
    json(async (c) => {
      const data = await c.req.arrayBuffer();
      await saveThumb(c.env, pathParam(c, 'code'), data);
      return c.json({ ok: true });
    }),
  );

  app.get('/api/thumb/:code', async (c) => {
    const obj = await readThumb(c.env, pathParam(c, 'code'));
    if (!obj) return new Response('Not Found', { status: 404 });
    return new Response(obj.body, {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': IMMUTABLE, 'X-Content-Type-Options': 'nosniff' },
    });
  });
}

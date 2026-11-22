#!/usr/bin/env node
/**
 * 部署后冒烟：直接打真实域名，覆盖"页面 / 状态 / 普通上传下载 / 文本 / 分片 / 未授权"。
 * 用法：node scripts/smoke.mjs https://your-domain
 * 退出码非 0 表示有失败项（可用于 CI / 部署后门禁）。
 */
const base = (process.argv[2] || process.env.BASE_URL || '').replace(/\/$/, '');
if (!base) {
  console.error('用法: node scripts/smoke.mjs https://your-domain');
  process.exit(2);
}

const ts = Date.now();
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`  ✗ ${name} — ${e.message}`);
  }
};

const req = async (path, init) => {
  const res = await fetch(base + path, init);
  return res;
};
const expectStatus = (res, want) => {
  if (res.status !== want) throw new Error(`HTTP ${res.status}，期望 ${want}`);
};
const j = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应非 JSON: ${text.slice(0, 120)}`);
  }
};

await check('首页', async () => {
  const res = await req('/');
  expectStatus(res, 200);
  const html = await res.text();
  if (!html.includes('FileCodeBox')) throw new Error('首页内容异常');
  return `${html.length}B`;
});

await check('/api/status', async () => {
  const s = await j(await req('/api/status'));
  if (!s.ok) throw new Error('ok 非 true');
  return `maxSize=${s.maxFileSize} adminPasswordConfigured=${s.adminPasswordConfigured}`;
});

await check('普通上传 → 下载内容一致', async () => {
  const body = `smoke-${ts}`;
  const res = await req(`/api/upload?code=${9000 + (ts % 900)}`, {
    method: 'POST',
    headers: { 'X-Filename': 'smoke.txt', 'Content-Type': 'text/plain' },
    body,
  });
  expectStatus(res, 200);
  const { code } = await j(res);
  const dl = await req(`/api/download/${code}`);
  expectStatus(dl, 200);
  const got = await dl.text();
  if (got !== body) throw new Error('下载内容与上传不一致');
  return `code=${code}`;
});

await check('文本上传 → 读取一致', async () => {
  const text = `smoke-text-${ts}`;
  const res = await req('/api/upload/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text }),
    redirect: 'manual',
  });
  if (![200, 303].includes(res.status)) throw new Error(`HTTP ${res.status}`);
  const loc = res.headers.get('location') || '';
  const code = loc.match(/\/r\/(\d{4})/)?.[1];
  if (!code) throw new Error(`未拿到取件码（location=${loc}）`);
  const got = await (await req(`/api/text/${code}`)).text();
  if (got !== text) throw new Error('文本内容不一致');
  return `code=${code}`;
});

await check('分片上传 → 合并下载一致', async () => {
  const size = 1_048_576;
  const data = new Uint8Array(size).map((_, i) => i % 251);
  const init = await j(
    await req('/api/upload/chunk/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'smoke-chunk.bin', size, total_chunks: 1 }),
    }),
  );
  if (!init.upload_id) throw new Error(`init 失败: ${JSON.stringify(init)}`);
  const put = await req(`/api/upload/chunk/${init.upload_id}/0`, { method: 'PUT', body: data });
  expectStatus(put, 200);
  const done = await j(await req(`/api/upload/chunk/complete/${init.upload_id}`, { method: 'POST' }));
  if (!done.code) throw new Error(`complete 失败: ${JSON.stringify(done)}`);
  const buf = new Uint8Array(await (await req(`/api/download/${done.code}`)).arrayBuffer());
  if (buf.length !== size || buf[0] !== data[0] || buf[size - 1] !== data[size - 1]) {
    throw new Error('分片合并内容不一致');
  }
  return `code=${done.code} ${size}B`;
});

await check('管理接口未授权 → 401', async () => {
  expectStatus(await req('/api/admin/dashboard'), 401);
  return '401';
});

await check('未知 API → 404', async () => {
  expectStatus(await req('/api/__nope__'), 404);
  return '404';
});

const failed = results.filter((r) => !r.ok);
console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);

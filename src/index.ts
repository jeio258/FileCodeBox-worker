/**
 * FileCodeBox - Cloudflare Worker 重写版
 * 像取快递一样取文件
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
  FILE_STORE: KVNamespace;
  ADMIN_PASSWORD: string;
  MAX_FILE_SIZE: string;
  DEFAULT_EXPIRE_DAYS: string;
};

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Referrer-Policy', 'no-referrer');
});

// 支持 /filecodebox 前缀路由
const filebox = new Hono<{ Bindings: Env }>();
app.route('/filecodebox', filebox);

// ===================== 工具函数 =====================

function generateCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function ttl(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

async function hashPassword(pwd: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pwd);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===================== 数据库初始化 =====================

async function initDB(db: D1Database) {
  const stmts = [
    'CREATE TABLE IF NOT EXISTS fc_files (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, mime_type TEXT DEFAULT "application/octet-stream", expire_at TEXT NOT NULL, download_count INTEGER DEFAULT 0, max_downloads INTEGER DEFAULT -1, created_at TEXT NOT NULL, ip TEXT DEFAULT "")',
    'CREATE INDEX IF NOT EXISTS idx_fc_code ON fc_files(code)',
    'CREATE INDEX IF NOT EXISTS idx_fc_expire ON fc_files(expire_at)',
    'CREATE TABLE IF NOT EXISTS fc_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'INSERT OR IGNORE INTO fc_settings(key, value) VALUES("admin_password", "admin123")',
  ];
  for (const s of stmts) {
    await db.prepare(s).run();
  }
  return true;
}

// ===================== HTML 模板 =====================

const PAGE_STYLE = `
:root{--bg:#f0f2f5;--card:#fff;--text:#1a1a2e;--text2:#6b7280;--primary:#6366f1;--primary2:#818cf8;--accent:#10b981;--danger:#ef4444;--border:#e5e7eb;--radius:16px;--radius-sm:10px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',Roboto,sans-serif;background:linear-gradient(135deg,#667eea0a,#764ba20a,var(--bg));color:var(--text);min-height:100vh}
.container{max-width:480px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border-radius:var(--radius);padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.04);border:1px solid var(--border);transition:box-shadow .3s}
.card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08),0 8px 32px rgba(0,0,0,.06)}
.logo{text-align:center;margin-bottom:28px}
.logo h1{font-size:26px;font-weight:800;background:linear-gradient(135deg,var(--primary),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.logo p{font-size:14px;color:var(--text2)}
.section-title{font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px;display:flex;align-items:center;gap:8px}
.section-divider{height:1px;background:linear-gradient(90deg,transparent,var(--border),transparent);margin:24px 0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border:none;border-radius:var(--radius-sm);font-size:14px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-primary{background:linear-gradient(135deg,var(--primary),var(--primary2));color:#fff;width:100%;box-shadow:0 2px 8px rgba(99,102,241,.3)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(99,102,241,.4)}
.btn-primary:active{transform:translateY(0)}
.btn-primary:disabled{opacity:.6;transform:none}
.btn-secondary{background:var(--bg);color:var(--text);border:1px solid var(--border);width:100%}
.btn-secondary:hover{background:#e5e7eb}
.btn-sm{padding:6px 14px;font-size:13px;width:auto}
.input{width:100%;padding:10px 14px;border:2px solid var(--border);border-radius:var(--radius-sm);font-size:15px;outline:none;transition:all .2s;background:var(--bg)}
.input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(99,102,241,.1);background:var(--card)}
.input-group{margin-bottom:14px}
.input-group label{display:block;font-size:13px;font-weight:600;color:var(--text2);margin-bottom:5px}
.code-box{text-align:center;padding:20px 0}
.code-display{font-size:52px;font-weight:900;letter-spacing:12px;background:linear-gradient(135deg,var(--primary),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-family:'JetBrains Mono','Courier New',monospace;margin:16px 0}
.copy-text-btn{cursor:pointer;color:var(--primary);font-size:13px;font-weight:500}
.copy-text-btn:hover{color:var(--primary2)}
.info-row{display:flex;justify-content:center;gap:20px;font-size:13px;color:var(--text2);margin:12px 0;flex-wrap:wrap}
.info-tag{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:var(--bg);border-radius:20px;font-size:12px}
.file-icon-box{width:72px;height:72px;background:linear-gradient(135deg,var(--primary),#a855f7);border-radius:18px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 4px 16px rgba(99,102,241,.2)}
.nav{display:flex;justify-content:flex-end;gap:8px;margin-bottom:20px}
.nav a{font-size:13px;color:var(--text2);text-decoration:none;padding:6px 12px;border-radius:var(--radius-sm);transition:all .2s}
.nav a:hover{background:var(--bg);color:var(--primary)}
.file-list-item{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--bg);border-radius:var(--radius-sm);margin-bottom:8px;transition:all .2s}
.file-list-item:hover{background:#e5e7eb}
.file-list-item .fname{font-size:14px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-list-item .fmeta{font-size:12px;color:var(--text2);margin-left:10px;white-space:nowrap}
.expired{opacity:.4}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.badge-danger{background:#fef2f2;color:var(--danger)}
.badge-success{background:#ecfdf5;color:var(--accent)}
.stats-row{display:flex;gap:8px;margin-bottom:16px}
.stats-row .btn{flex:1}
@media(max-width:400px){.container{padding:16px 10px}.card{padding:20px 16px}}
`;

function layout(title: string, content: string, nav: string = ''): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><div class="container">${nav}<div class="card">${content}</div></div></body></html>`;
}

// ===================== 页面 =====================

function homePage(): string {
  const nav = `<div class="nav"><a href="/admin">管理</a></div>`;
  const content = `
    <div class="logo"><h1>📦 FileCodeBox</h1><p>像取快递一样取文件</p></div>
    
    <!-- 取件区 -->
    <form action="/r" method="get" style="margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--border)">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--text)">📥 输入取件码取件</div>
      <div style="display:flex;gap:8px">
        <input type="text" name="code" class="input" placeholder="输入4位取件码" maxlength="4" required style="text-align:center;font-size:20px;letter-spacing:6px;text-transform:uppercase;flex:1" autocomplete="off">
        <button type="submit" class="btn btn-primary" style="width:auto;padding:12px 20px">取件</button>
      </div>
    </form>

    <!-- 上传区 -->
    <div style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--text)">📤 上传新文件</div>
    <form action="/api/upload" method="post" enctype="multipart/form-data" onsubmit="document.getElementById('submitBtn').disabled=true;document.getElementById('submitBtn').textContent='上传中...'">
      <div class="input-group"><label>选择文件</label><input type="file" name="file" required class="input" style="padding:10px"></div>
      <div style="display:flex;gap:12px">
        <div class="input-group" style="flex:1"><label>最大下载次数</label><input type="number" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限"></div>
        <div class="input-group" style="flex:1"><label>过期天数</label><input type="number" name="expire_days" min="1" max="365" value="7" class="input" placeholder="7天"></div>
      </div>
      <div class="input-group"><label>自定义取件码（留空自动生成）</label><input type="text" name="code" class="input" placeholder="4位取件码" maxlength="4" pattern="[A-Z0-9]{0,4}"></div>
      <button type="submit" id="submitBtn" class="btn btn-primary">📤 上传并获取取件码</button>
    </form>`;
  return layout('FileCodeBox - 文件快递柜', content, nav);
}

function retrievePage(code?: string): string {
  const nav = `<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>`;
  const content = `
    <div class="logo"><h1>📦 取件</h1><p>输入取件码下载文件</p></div>
    <form action="/r" method="get">
      <div class="input-group"><label>取件码</label><input type="text" name="code" value="${code || ''}" class="input" placeholder="输入4位取件码" maxlength="4" required style="text-align:center;font-size:24px;letter-spacing:8px;text-transform:uppercase" autofocus></div>
      <button type="submit" class="btn btn-primary">📥 取件</button>
    </form>`;
  return layout('取件 - FileCodeBox', content, nav);
}

function resultPage(code: string, filename: string, size: number): string {
  const sizeStr = size > 1048576 ? `${(size/1048576).toFixed(1)} MB` : size > 1024 ? `${(size/1024).toFixed(1)} KB` : `${size} B`;
  const nav = `<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>`;
  const shareUrl = `https://ooo.994613.xyz/r/${code}`;
  const content = `
    <div class="logo"><h1>✅ 上传成功</h1></div>
    <div class="code-box">
      <div style="font-size:13px;color:var(--text2);margin-bottom:8px">取件码</div>
      <div class="code-display">${code}</div>
      <button class="copy-text-btn" onclick="navigator.clipboard.writeText('${code}').then(()=>{this.textContent='✅ 已复制'});setTimeout(()=>{this.textContent='📋 复制取件码'},2000)">📋 复制取件码</button>
      <div class="info-row" style="margin-top:16px">
        <span class="info-tag">📄 ${filename}</span>
        <span class="info-tag">📏 ${sizeStr}</span>
      </div>
      <div style="margin-top:20px">
        <button class="copy-text-btn" onclick="navigator.clipboard.writeText('${shareUrl}').then(()=>{this.textContent='✅ 链接已复制'});setTimeout(()=>{this.textContent='🔗 复制分享链接'},2000)">🔗 复制分享链接</button>
      </div>
    </div>
    <a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:12px">继续上传</a>`;
  return layout('上传成功 - FileCodeBox', content, nav);
}

function filePage(file: any): string {
  const nav = `<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>`;
  const sizeStr = file.size > 1048576 ? `${(file.size/1048576).toFixed(1)} MB` : file.size > 1024 ? `${(file.size/1024).toFixed(1)} KB` : `${file.size} B`;
  const dlInfo = file.max_downloads < 0 ? '不限次数' : `已下载 ${file.download_count}/${file.max_downloads} 次`;
  const expireDate = new Date(file.expire_at);
  const expireStr = expireDate > new Date(Date.now() + 365 * 86400000) ? '永久有效' : `过期时间: ${expireDate.toLocaleDateString('zh-CN')}`;
  const expired = new Date(file.expire_at).getTime() < Date.now();
  const shareUrl = `https://ooo.994613.xyz/r/${file.code}`;

  const content = `
    <div class="logo"><h1>📦 取件</h1></div>
    ${expired ? '<div style="text-align:center;color:#ef4444;font-size:14px;margin-bottom:16px">⚠️ 此文件已过期</div>' : ''}
    <div style="text-align:center;padding:20px 0">
      <div style="width:64px;height:64px;background:var(--primary);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      </div>
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;word-break:break-all">${file.filename}</div>
      <div style="display:flex;justify-content:center;gap:24px;font-size:13px;color:var(--text2);margin-bottom:8px">
        <span>📏 ${sizeStr}</span>
        <span>📥 ${dlInfo}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:24px">🕐 ${expireStr}</div>
      ${!expired ? `
        <a href="/api/download/${file.code}" class="btn btn-primary" style="text-decoration:none;width:auto;padding:14px 48px;display:inline-flex">📥 下载文件</a>
        <div style="margin-top:12px;font-size:13px;color:var(--text2)">
          取件码: <strong style="font-size:18px;color:var(--primary);letter-spacing:3px">${file.code}</strong>
        </div>
        <div style="margin-top:8px">
          <button onclick="navigator.clipboard.writeText('${shareUrl}')" class="btn btn-secondary" style="width:auto;display:inline-flex;padding:8px 16px;font-size:13px">📋 复制分享链接</button>
        </div>
      ` : ''}
    </div>`;
  return layout('取件 - FileCodeBox', content, nav);
}

function adminLoginPage(error?: string): string {
  const content = `
    <div class="logo"><h1>🔐 管理员登录</h1><p>FileCodeBox 后台管理</p></div>
    ${error ? `<div style="color:#ef4444;text-align:center;margin-bottom:16px;font-size:14px">${error}</div>` : ''}
    <form action="/api/admin/login" method="post">
      <div class="input-group"><label>密码</label><input type="password" name="password" class="input" placeholder="输入管理员密码" required autofocus></div>
      <button type="submit" class="btn btn-primary">登录</button>
    </form>
    <div style="text-align:center;margin-top:16px"><a href="/" style="font-size:14px;color:var(--text2)">← 返回首页</a></div>`;
  return layout('管理员登录 - FileCodeBox', content);
}

function adminPage(files: any[], total: number, page: number, error?: string): string {
  const nav = `<div class="nav"><a href="/">首页</a><a href="/api/admin/logout">退出</a></div>`;
  const totalPages = Math.ceil(total / 50);
  const pagination = totalPages > 1 ? `<div style="text-align:center;margin-top:16px;font-size:14px;color:var(--text2)">第 ${page}/${totalPages} 页 | 共 ${total} 个文件</div>` : '';

  const fileRows = files.map((f: any) => {
    const expired = new Date(f.expire_at).getTime() < Date.now();
    const size = f.size > 1048576 ? `${(f.size/1048576).toFixed(1)}MB` : `${(f.size/1024).toFixed(1)}KB`;
    return `<div class="file-list-item ${expired ? 'expired' : ''}">
      <span class="fname">${f.filename}</span>
      <span class="fmeta">${f.code}</span>
      <span class="fmeta">${size}</span>
      <span class="fmeta">${f.download_count}次</span>
      <span class="fmeta">${f.expire_at.slice(0,10)}</span>
      <a href="/api/admin/delete/${f.id}" style="color:#ef4444;font-size:13px;text-decoration:none;margin-left:8px" onclick="return confirm('确认删除?')">删除</a>
    </div>`;
  }).join('');

  const content = `
    <div class="logo"><h1>📊 管理面板</h1><p>共 ${total} 个文件</p></div>
    ${error ? `<div style="color:#ef4444;text-align:center;margin-bottom:16px">${error}</div>` : ''}
    <div style="margin-bottom:16px">
      <a href="/api/admin/cleanup" class="btn btn-secondary" style="text-decoration:none" onclick="return confirm('确认清理所有过期文件?')">🧹 清理过期文件</a>
    </div>
    <div>${fileRows}</div>
    ${pagination}
    <div style="text-align:center;margin-top:16px">
      ${page > 1 ? `<a href="/admin?page=${page-1}" style="font-size:14px;margin-right:12px;">← 上一页</a>` : ''}
      ${page < totalPages ? `<a href="/admin?page=${page+1}" style="font-size:14px">下一页 →</a>` : ''}
    </div>`;
  return layout('管理面板 - FileCodeBox', content, nav);
}

// ===================== 中间件 =====================

async function adminAuth(c: any, env: Env): Promise<boolean> {
  const token = getCookie(c, 'admin_token') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;
  try {
    const result = await env.DB.prepare('SELECT value FROM fc_settings WHERE key = ?').bind('admin_token').first<any>();
    return result?.value === token;
  } catch { return false; }
}

// ===================== 路由 =====================

// 首页
app.get('/', (c) => c.html(homePage()));

// 取件页
app.get('/r', (c) => {
  const code = (c.req.query('code') || '').toUpperCase().trim();
  if (code) return c.redirect(`/r/${code}`);
  return c.html(retrievePage());
});

// ===== API: 上传 =====
app.post('/api/upload', async (c) => {
  const env = c.env;
  try {
  const body = await c.req.parseBody();
  const file = body['file'] as File | undefined;

  if (!file) {
    return c.html(homePage());
  }

  const maxSize = parseInt(env.MAX_FILE_SIZE || '104857600');
  if (file.size > maxSize) {
    return c.html(layout('错误', `<div class="logo"><h1>❌ 文件过大</h1></div><p style="text-align:center">最大支持 ${Math.floor(maxSize/1048576)}MB</p><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
  }

  const code = (body['code'] as string || generateCode()).toUpperCase().trim() || generateCode();
  const maxDownloads = parseInt(body['max_downloads'] as string || '-1');
  const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7');

  // Check code uniqueness
  const existing = await env.DB.prepare('SELECT id FROM fc_files WHERE code = ? AND expire_at > datetime("now")').bind(code).first();
  if (existing) {
    return c.html(layout('错误', `<div class="logo"><h1>❌ 取件码已被占用</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
  }

  const expireAt = new Date(Date.now() + expireDays * 86400000).toISOString();

  // Store file in KV (max 25MB per value)
  const buffer = await file.arrayBuffer();
  const key = `file:${code}`;
  await env.FILE_STORE.put(key, buffer, { metadata: { filename: file.name, mimeType: file.type, size: file.size } });

  // Store metadata in D1
  await env.DB.prepare(
    'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(code, file.name || '未命名', file.size, file.type || 'application/octet-stream', expireAt, maxDownloads, new Date().toISOString()).run();

  return c.html(resultPage(code, file.name || '未命名', file.size));
  } catch (e: any) {
    return c.html(layout('错误', `<div class="logo"><h1>❌ 上传失败</h1></div><p style="text-align:center">${e.message}</p><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
  }
});

// ===== API: 下载 =====
app.get('/api/download/:code', async (c) => {
  const env = c.env;
  const code = c.req.param('code').toUpperCase();

  const file = await env.DB.prepare(
    'SELECT * FROM fc_files WHERE code = ? AND expire_at > datetime("now")'
  ).bind(code).first<any>();

  if (!file) {
    return c.html(retrievePage(code));
  }

  if (file.max_downloads >= 0 && file.download_count >= file.max_downloads) {
    return c.html(layout('错误', '<div class="logo"><h1>❌ 已达最大下载次数</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>'));
  }

  await env.DB.prepare('UPDATE fc_files SET download_count = download_count + 1 WHERE code = ?').bind(code).run();

  const fileData = await env.FILE_STORE.get(`file:${code}`, 'arrayBuffer');
  if (!fileData) {
    return c.html(layout('错误', '<div class="logo"><h1>❌ 文件不存在</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>'));
  }

  return new Response(fileData, {
    headers: {
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(file.size),
    }
  });
});

// 查看文件信息
app.get('/api/info/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const file = await c.env.DB.prepare('SELECT * FROM fc_files WHERE code = ?').bind(code).first<any>();
  if (!file) return c.json({ error: 'not found' }, 404);
  return c.json({
    filename: file.filename,
    size: file.size,
    download_count: file.download_count,
    max_downloads: file.max_downloads,
    expire_at: file.expire_at,
  });
});

// 取件（GET）
app.get('/r/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const file = await c.env.DB.prepare('SELECT * FROM fc_files WHERE code = ? AND expire_at > datetime("now")').bind(code).first<any>();
  if (!file) return c.html(retrievePage(code));

  return c.html(filePage(file));
});

// ===== Admin =====
app.get('/admin', async (c) => {
  const env = c.env;
  if (!await adminAuth(c, env)) return c.html(adminLoginPage());

  const page = parseInt(c.req.query('page') || '1');
  const offset = (page - 1) * 50;

  const files = await env.DB.prepare('SELECT * FROM fc_files ORDER BY id DESC LIMIT 50 OFFSET ?').bind(offset).all<any>();
  const total = await env.DB.prepare('SELECT COUNT(*) as count FROM fc_files').first<any>();

  return c.html(adminPage(files.results || [], total?.count || 0, page));
});

app.post('/api/admin/login', async (c) => {
  const env = c.env;
  const body = await c.req.parseBody();
  const password = body['password'] as string;

  const setting = await env.DB.prepare('SELECT value FROM fc_settings WHERE key = ?').bind('admin_password').first<any>();
  const correctPwd = setting?.value || env.ADMIN_PASSWORD || 'admin123';

  const hashedInput = await hashPassword(password);
  const hashedStored = await hashPassword(correctPwd);

  if (hashedInput !== hashedStored && password !== correctPwd) {
    return c.html(adminLoginPage('密码错误'));
  }

  const token = crypto.randomUUID();
  await env.DB.prepare('INSERT OR REPLACE INTO fc_settings(key, value) VALUES(?, ?)').bind('admin_token', token).run();

  setCookie(c, 'admin_token', token, { httpOnly: true, maxAge: 86400, path: '/' });
  return c.redirect('/admin');
});

app.get('/api/admin/logout', async (c) => {
  deleteCookie(c, 'admin_token');
  return c.redirect('/');
});

app.get('/api/admin/delete/:id', async (c) => {
  const env = c.env;
  if (!await adminAuth(c, env)) return c.redirect('/admin');

  const id = c.req.param('id');
  const file = await env.DB.prepare('SELECT * FROM fc_files WHERE id = ?').bind(parseInt(id)).first<any>();
  if (file) {
    await env.FILE_STORE.delete(`file:${file.code}`);
    await env.DB.prepare('DELETE FROM fc_files WHERE id = ?').bind(parseInt(id)).run();
  }
  return c.redirect('/admin');
});

app.get('/api/admin/cleanup', async (c) => {
  const env = c.env;
  if (!await adminAuth(c, env)) return c.redirect('/admin');

  const expired = await env.DB.prepare("SELECT * FROM fc_files WHERE expire_at <= datetime('now')").all<any>();
  for (const f of (expired.results || [])) {
    await env.FILE_STORE.delete(`file:${f.code}`);
  }
  await env.DB.prepare("DELETE FROM fc_files WHERE expire_at <= datetime('now')").run();
  return c.redirect('/admin');
});

// Cron: 自动清理过期文件
app.get('/api/cron/cleanup', async (c) => {
  const expired = await c.env.DB.prepare("SELECT * FROM fc_files WHERE expire_at <= datetime('now')").all<any>();
  for (const f of (expired.results || [])) {
    await c.env.FILE_STORE.delete(`file:${f.code}`);
  }
  await c.env.DB.prepare("DELETE FROM fc_files WHERE expire_at <= datetime('now')").run();
  return c.json({ cleaned: expired.results?.length || 0 });
});

// 初始化
app.get('/api/init', async (c) => {
  try {
    await initDB(c.env.DB);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default app;

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
    'CREATE TABLE IF NOT EXISTS fc_files (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, mime_type TEXT DEFAULT "application/octet-stream", expire_at TEXT NOT NULL, download_count INTEGER DEFAULT 0, max_downloads INTEGER DEFAULT -1, created_at TEXT NOT NULL, ip TEXT DEFAULT "", is_text INTEGER DEFAULT 0)',
    'CREATE INDEX IF NOT EXISTS idx_fc_code ON fc_files(code)',
    'CREATE INDEX IF NOT EXISTS idx_fc_expire ON fc_files(expire_at)',
    'CREATE TABLE IF NOT EXISTS fc_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS fc_chunks (upload_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, total_chunks INTEGER NOT NULL, file_name TEXT NOT NULL, file_size INTEGER NOT NULL, chunk_size INTEGER NOT NULL, mime_type TEXT DEFAULT "application/octet-stream", created_at TEXT NOT NULL, PRIMARY KEY (upload_id, chunk_index))',
    'INSERT OR IGNORE INTO fc_settings(key, value) VALUES("admin_password", "admin123")',
  ];
  for (const s of stmts) {
    await db.prepare(s).run();
  }
  return true;
}

// ===================== HTML 模板 =====================

const PAGE_STYLE = `
:root{--bg:#f5f3ef;--card:#fafaf8;--text:#3d3a35;--text2:#8c8880;--accent:#7d8c7d;--accent-hv:#6b7a6b;--warm:#c4a882;--warm-hv:#b0956e;--danger:#c0392b;--danger-bg:#fdf0ef;--border:#e8e4df;--border-focus:#b8b0a4;--radius:8px;--radius-sm:6px}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{overflow-x:clip}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Noto Sans SC',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6;-webkit-font-smoothing:antialiased}
.container{max-width:480px;margin:0 auto;padding:32px 16px 48px}
.card{background:var(--card);border-radius:var(--radius);padding:28px 24px;border:1px solid var(--border)}
.logo{text-align:center;margin-bottom:24px}
.logo h1{font-size:24px;font-weight:600;color:var(--accent);letter-spacing:-0.3px}
.logo p{font-size:13px;color:var(--text2);margin-top:4px}
.section-pickup{background:linear-gradient(135deg,rgba(196,168,130,.12),rgba(196,168,130,.04));border:1px solid rgba(196,168,130,.2);border-radius:var(--radius);padding:20px;margin-bottom:20px}
.section-pickup .section-label{font-size:13px;font-weight:600;color:var(--warm-hv);margin-bottom:10px;letter-spacing:0.3px}
.section-upload .section-label{font-size:13px;font-weight:600;color:var(--text2);margin-bottom:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 18px;border:none;border-radius:var(--radius-sm);font-size:14px;font-weight:500;cursor:pointer;transition:background .15s,opacity .15s;text-decoration:none;line-height:1;font-family:inherit}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn-primary{background:var(--accent);color:#fff;width:100%}
.btn-primary:hover{background:var(--accent-hv)}
.btn-primary:active{background:var(--accent-hv)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-warm{background:var(--warm);color:#fff;width:100%}
.btn-warm:hover{background:var(--warm-hv)}
.btn-warm:active{background:var(--warm-hv)}
.btn-secondary{background:var(--bg);color:var(--text);border:1px solid var(--border);width:100%}
.btn-secondary:hover{background:var(--border)}
.btn-sm{padding:6px 14px;font-size:13px;width:auto}
.btn-danger{color:var(--danger);font-size:13px;text-decoration:none;padding:4px 8px;border-radius:var(--radius-sm)}
.btn-danger:hover{background:var(--danger-bg)}
.input{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:15px;font-family:inherit;outline:none;transition:border-color .15s;background:#fff;color:var(--text)}
.input:focus{border-color:var(--border-focus);box-shadow:0 0 0 3px rgba(125,140,125,.12)}
.input-group{margin-bottom:14px}
.input-group label{display:block;font-size:13px;font-weight:500;color:var(--text2);margin-bottom:5px}
.code-box{text-align:center;padding:16px 0}
.code-display{font-size:48px;font-weight:600;letter-spacing:10px;color:var(--text);font-family:'SF Mono','JetBrains Mono','Courier New',monospace;background:var(--bg);display:inline-block;padding:6px 20px;border-radius:var(--radius-sm);margin:12px 0}
.copy-text-btn{cursor:pointer;color:var(--accent);font-size:13px;font-weight:500;background:none;border:none;padding:4px 10px;border-radius:var(--radius-sm);transition:background .15s,color .15s;font-family:inherit}
.copy-text-btn:hover{background:rgba(125,140,125,.08)}
.copy-text-btn.copied{color:var(--warm-hv)}
.info-row{display:flex;justify-content:center;gap:16px;font-size:13px;color:var(--text2);margin:12px 0;flex-wrap:wrap}
.info-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;background:var(--bg);border-radius:20px;font-size:12px;border:1px solid var(--border)}
.file-icon-box{width:56px;height:56px;background:var(--accent);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px}
.nav{display:flex;justify-content:flex-end;gap:4px;margin-bottom:20px}
.nav a{font-size:13px;color:var(--text2);text-decoration:none;padding:6px 12px;border-radius:var(--radius-sm);transition:background .15s}
.nav a:hover{background:var(--border);color:var(--text)}
.nav a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.file-list-item{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg);border-radius:var(--radius-sm);margin-bottom:6px;transition:background .15s;gap:8px}
.file-list-item:hover{background:var(--border)}
.file-list-item .fname{font-size:13px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-list-item .fmeta{font-size:12px;color:var(--text2);white-space:nowrap}
.expired{opacity:.4}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:500}
.badge-danger{background:var(--danger-bg);color:var(--danger)}
.badge-success{background:#edf2ed;color:var(--accent)}
.stats-row{display:flex;gap:8px;margin-bottom:16px}
.stats-row .btn{flex:1}
.footer{text-align:center;margin-top:24px;font-size:12px;color:var(--text2)}
.footer a{color:var(--text2)}
.tabs{display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid var(--border)}
.tab{flex:1;text-align:center;padding:8px 0;font-size:14px;font-weight:500;color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:color .15s,border-color .15s;background:none;border-top:none;border-left:none;border-right:none;font-family:inherit}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab-panel{display:none}
.tab-panel.active{display:block}
textarea.input{resize:vertical;min-height:120px;line-height:1.5}
.chunk-progress{height:4px;background:var(--border);border-radius:2px;margin-top:10px;overflow:hidden;display:none}
.chunk-progress-bar{height:100%;background:var(--accent);border-radius:2px;transition:width .2s;width:0}
.chunk-status{font-size:12px;color:var(--text2);text-align:center;margin-top:6px;display:none}
.text-content{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;font-family:inherit}
@media(max-width:420px){.container{padding:20px 12px 40px}.card{padding:20px 16px}.code-display{font-size:36px;letter-spacing:8px}.section-pickup{padding:16px}}
`;

function layout(title: string, content: string, nav: string = '', showFooter: boolean = true): string {
  const footer = showFooter ? '<div class="footer"><a href="/">FileCodeBox</a> · 安全临时文件分享</div>' : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><div class="container">${nav}<div class="card">${content}</div>${footer}</div></body></html>`;
}

// ===================== 页面 =====================

function homePage(): string {
  const nav = `<div class="nav"><a href="/admin">管理</a></div>`;
  const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB per chunk
  const content = `
    <div class="logo"><h1>FileCodeBox</h1><p>像取快递一样取文件</p></div>
    
    <!-- 取件区 - 主操作 -->
    <div class="section-pickup">
      <div class="section-label">取件</div>
      <form action="/r" method="get">
        <div style="display:flex;gap:8px">
          <input type="text" name="code" class="input" placeholder="输入 4 位取件码" maxlength="4" required style="text-align:center;font-size:20px;letter-spacing:6px;text-transform:uppercase;flex:1" autocomplete="off">
          <button type="submit" class="btn btn-warm" style="width:auto;padding:10px 20px">取件</button>
        </div>
      </form>
      <div style="font-size:12px;color:var(--text2);margin-top:8px">输入分享者给你的 4 位取件码</div>
    </div>

    <!-- 上传区 - 文件/文本 Tab 切换 -->
    <div class="section-upload">
      <div class="section-label">上传新内容</div>
      <div class="tabs">
        <button class="tab active" onclick="switchTab('file')">文件</button>
        <button class="tab" onclick="switchTab('text')">文本</button>
      </div>

      <!-- 文件上传面板 -->
      <div id="tab-file" class="tab-panel active">
        <form id="uploadForm" onsubmit="handleUpload(event)">
          <div class="input-group"><label>选择文件</label><input type="file" name="file" id="fileInput" required class="input"></div>
          <div style="display:flex;gap:12px">
            <div class="input-group" style="flex:1"><label>最大下载次数</label><input type="number" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限"></div>
            <div class="input-group" style="flex:1"><label>过期天数</label><input type="number" name="expire_days" min="1" max="365" value="7" class="input" placeholder="7"></div>
          </div>
          <div class="input-group"><label>自定义取件码 <span style="font-weight:400;color:var(--text2)">（可选，留空自动生成）</span></label><input type="text" name="code" class="input" placeholder="4 位取件码" maxlength="4" pattern="[A-Z0-9]{0,4}"></div>
          <div class="chunk-progress" id="chunkProgress"><div class="chunk-progress-bar" id="chunkProgressBar"></div></div>
          <div class="chunk-status" id="chunkStatus"></div>
          <button type="submit" id="submitBtn" class="btn btn-primary">上传并获取取件码</button>
        </form>
      </div>

      <!-- 文本分享面板 -->
      <div id="tab-text" class="tab-panel">
        <form action="/api/upload/text" method="post" onsubmit="var b=document.getElementById('textSubmitBtn');b.disabled=true;b.textContent='保存中…'">
          <div class="input-group"><label>文本内容</label><textarea name="text" class="input" placeholder="粘贴或输入要分享的文本内容…" required></textarea></div>
          <div style="display:flex;gap:12px">
            <div class="input-group" style="flex:1"><label>最大查看次数</label><input type="number" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限"></div>
            <div class="input-group" style="flex:1"><label>过期天数</label><input type="number" name="expire_days" min="1" max="365" value="7" class="input" placeholder="7"></div>
          </div>
          <div class="input-group"><label>自定义取件码 <span style="font-weight:400;color:var(--text2)">（可选，留空自动生成）</span></label><input type="text" name="code" class="input" placeholder="4 位取件码" maxlength="4" pattern="[A-Z0-9]{0,4}"></div>
          <button type="submit" id="textSubmitBtn" class="btn btn-primary">保存并获取取件码</button>
        </form>
      </div>
    </div>

    <script>
    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.textContent.trim().toLowerCase().includes(name)));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
    }
    async function handleUpload(e) {
      e.preventDefault();
      var file = document.getElementById('fileInput').files[0];
      if (!file) return;
      var btn = document.getElementById('submitBtn');
      var progressBar = document.getElementById('chunkProgressBar');
      var progress = document.getElementById('chunkProgress');
      var status = document.getElementById('chunkStatus');
      var chunkSize = ${CHUNK_SIZE};
      
      if (file.size <= chunkSize) {
        // 小文件直接提交
        btn.disabled = true; btn.textContent = '上传中…';
        e.target.submit();
        return;
      }
      
      // 大文件分片上传
      btn.disabled = true; btn.textContent = '初始化…';
      progress.style.display = 'block'; status.style.display = 'block';
      
      try {
        var form = new FormData();
        form.append('file_name', file.name);
        form.append('file_size', file.size);
        form.append('chunk_size', chunkSize);
        form.append('mime_type', file.type || 'application/octet-stream');
        var initResp = await fetch('/api/chunk/init', { method:'POST', body:form });
        var initData = await initResp.json();
        if (!initData.upload_id) throw new Error('Init failed');
        
        var uploadId = initData.upload_id;
        var totalChunks = Math.ceil(file.size / chunkSize);
        btn.textContent = '上传中 0/' + totalChunks;
        
        for (var i = 0; i < totalChunks; i++) {
          var start = i * chunkSize;
          var end = Math.min(start + chunkSize, file.size);
          var blob = file.slice(start, end);
          var chunkForm = new FormData();
          chunkForm.append('chunk', blob, 'chunk');
          await fetch('/api/chunk/upload/' + uploadId + '/' + i, { method:'POST', body:chunkForm });
          var pct = Math.round((i + 1) / totalChunks * 100);
          progressBar.style.width = pct + '%';
          btn.textContent = '上传中 ' + (i + 1) + '/' + totalChunks;
        }
        
        status.textContent = '合并文件中…';
        var completeForm = new FormData();
        completeForm.append('max_downloads', document.querySelector('[name="max_downloads"]').value || '-1');
        completeForm.append('expire_days', document.querySelector('[name="expire_days"]').value || '7');
        completeForm.append('code', document.querySelector('[name="code"]').value || '');
        var completeResp = await fetch('/api/chunk/complete/' + uploadId, { method:'POST', body:completeForm });
        var completeData = await completeResp.json();
        if (completeData.code) {
          window.location.href = '/r/' + completeData.code;
        } else {
          status.textContent = '错误: ' + (completeData.error || 'unknown');
        }
      } catch(err) {
        status.textContent = '上传失败: ' + err.message;
        btn.disabled = false; btn.textContent = '上传并获取取件码';
      }
    }
    </script>`;
  return layout('FileCodeBox - 文件快递柜', content, nav);
}

function retrievePage(code?: string): string {
  const nav = `<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>`;
  const content = `
    <div class="logo"><h1>取件</h1><p>输入取件码下载文件</p></div>
    <form action="/r" method="get">
      <div class="input-group"><label>取件码</label><input type="text" name="code" value="${code || ''}" class="input" placeholder="输入 4 位取件码" maxlength="4" required style="text-align:center;font-size:24px;letter-spacing:8px;text-transform:uppercase" autofocus></div>
      <button type="submit" class="btn btn-primary">取件</button>
    </form>`;
  return layout('取件 - FileCodeBox', content, nav);
}

function resultPage(code: string, filename: string, size: number): string {
  const sizeStr = size > 1048576 ? `${(size/1048576).toFixed(1)} MB` : size > 1024 ? `${(size/1024).toFixed(1)} KB` : `${size} B`;
  const nav = `<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>`;
  const shareUrl = `https://ooo.994613.xyz/r/${code}`;
  const content = `
    <div class="logo"><h1>上传成功</h1></div>
    <div class="code-box">
      <div style="font-size:13px;color:var(--text2);margin-bottom:8px">取件码</div>
      <div class="code-display">${code}</div>
      <button class="copy-text-btn" id="copyCodeBtn" onclick="var b=document.getElementById('copyCodeBtn');navigator.clipboard.writeText('${code}').then(()=>{b.textContent='已复制';b.classList.add('copied');setTimeout(()=>{b.textContent='复制取件码';b.classList.remove('copied')},2000)})">复制取件码</button>
      <div class="info-row" style="margin-top:16px">
        <span class="info-tag">${filename}</span>
        <span class="info-tag">${sizeStr}</span>
      </div>
      <div style="margin-top:20px">
        <button class="copy-text-btn" id="copyLinkBtn" onclick="var b=document.getElementById('copyLinkBtn');navigator.clipboard.writeText('${shareUrl}').then(()=>{b.textContent='链接已复制';b.classList.add('copied');setTimeout(()=>{b.textContent='复制分享链接';b.classList.remove('copied')},2000)})">复制分享链接</button>
      </div>
    </div>
    <a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:12px">继续上传</a>`;
  return layout('上传成功 - FileCodeBox', content, nav);
}

function filePage(file: any): string {
  const nav = `<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>`;
  const sizeStr = file.size > 1048576 ? `${(file.size/1048576).toFixed(1)} MB` : file.size > 1024 ? `${(file.size/1024).toFixed(1)} KB` : `${file.size} B`;
  const dlInfo = file.max_downloads < 0 ? '不限次数' : `已查看 ${file.download_count}/${file.max_downloads} 次`;
  const expireDate = new Date(file.expire_at);
  const expireStr = expireDate > new Date(Date.now() + 365 * 86400000) ? '永久有效' : `过期时间: ${expireDate.toLocaleDateString('zh-CN')}`;
  const expired = new Date(file.expire_at).getTime() < Date.now();
  const shareUrl = `https://ooo.994613.xyz/r/${file.code}`;
  const isText = file.is_text === 1;

  if (isText && !expired) {
    // 文本内容 — 页面内展示
    const content = `
      <div class="logo"><h1>取件</h1></div>
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:20px;font-weight:600;margin-bottom:4px;word-break:break-all">${file.filename}</div>
        <div style="display:flex;justify-content:center;gap:24px;font-size:13px;color:var(--text2);margin-bottom:16px">
          <span>${sizeStr}</span>
          <span>${dlInfo}</span>
          <span>${expireStr}</span>
        </div>
        <div class="text-content" id="textContent">加载中…</div>
        <div style="margin-top:12px;font-size:13px;color:var(--text2)">
          取件码: <strong style="font-size:18px;color:var(--accent);letter-spacing:3px">${file.code}</strong>
        </div>
        <div style="margin-top:8px">
          <button id="copyShareBtn" onclick="var b=document.getElementById('copyShareBtn');navigator.clipboard.writeText('${shareUrl}').then(()=>{b.textContent='链接已复制';b.classList.add('copied');setTimeout(()=>{b.textContent='复制分享链接';b.classList.remove('copied')},2000)})" class="btn btn-secondary" style="width:auto;display:inline-flex;padding:8px 16px;font-size:13px">复制分享链接</button>
        </div>
      </div>
      <script>
        fetch('/api/text/${file.code}').then(r=>r.text()).then(t=>{
          document.getElementById('textContent').textContent = t;
        });
      </script>`;
    return layout('取件 - FileCodeBox', content, nav);
  }

  const content = `
    <div class="logo"><h1>取件</h1></div>
    ${expired ? '<div style="text-align:center;color:var(--danger);font-size:14px;margin-bottom:16px">此文件已过期</div>' : ''}
    <div style="text-align:center;padding:20px 0">
      <div style="width:56px;height:56px;background:var(--accent);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      </div>
      <div style="font-size:20px;font-weight:600;margin-bottom:8px;word-break:break-all">${file.filename}</div>
      <div style="display:flex;justify-content:center;gap:24px;font-size:13px;color:var(--text2);margin-bottom:8px">
        <span>${sizeStr}</span>
        <span>${dlInfo}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:24px">${expireStr}</div>
      ${!expired ? `
        <a href="/api/download/${file.code}" class="btn btn-primary" style="text-decoration:none;width:auto;padding:14px 48px;display:inline-flex">下载文件</a>
        <div style="margin-top:12px;font-size:13px;color:var(--text2)">
          取件码: <strong style="font-size:18px;color:var(--accent);letter-spacing:3px">${file.code}</strong>
        </div>
        <div style="margin-top:8px">
          <button id="copyShareBtn" onclick="var b=document.getElementById('copyShareBtn');navigator.clipboard.writeText('${shareUrl}').then(()=>{b.textContent='链接已复制';b.classList.add('copied');setTimeout(()=>{b.textContent='复制分享链接';b.classList.remove('copied')},2000)})" class="btn btn-secondary" style="width:auto;display:inline-flex;padding:8px 16px;font-size:13px">复制分享链接</button>
        </div>
      ` : ''}
    </div>`;
  return layout('取件 - FileCodeBox', content, nav);
}

function adminLoginPage(error?: string): string {
  const content = `
    <div class="logo"><h1>管理员登录</h1><p>FileCodeBox 后台管理</p></div>
    ${error ? `<div style="color:var(--danger);text-align:center;margin-bottom:16px;font-size:14px">${error}</div>` : ''}
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
      <a href="/api/admin/delete/${f.id}" class="btn-danger" onclick="return confirm('确认删除?')">删除</a>
    </div>`;
  }).join('');

  const content = `
    <div class="logo"><h1>管理面板</h1><p>共 ${total} 个文件</p></div>
    ${error ? `<div style="color:var(--danger);text-align:center;margin-bottom:16px">${error}</div>` : ''}
    <div style="margin-bottom:16px">
      <a href="/api/admin/cleanup" class="btn btn-secondary" style="text-decoration:none" onclick="return confirm('确认清理所有过期文件?')">清理过期文件</a>
    </div>
    <div>${fileRows}</div>
    ${pagination}
    <div style="text-align:center;margin-top:16px">
      ${page > 1 ? `<a href="/admin?page=${page-1}" style="font-size:14px;margin-right:12px;color:var(--accent)">← 上一页</a>` : ''}
      ${page < totalPages ? `<a href="/admin?page=${page+1}" style="font-size:14px;color:var(--accent)">下一页 →</a>` : ''}
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
    return c.html(layout('错误', `<div class="logo"><h1>文件过大</h1></div><p style="text-align:center">最大支持 ${Math.floor(maxSize/1048576)}MB</p><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
  }

  const code = (body['code'] as string || generateCode()).toUpperCase().trim() || generateCode();
  const maxDownloads = parseInt(body['max_downloads'] as string || '-1');
  const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7');

  // Check code uniqueness
  const existing = await env.DB.prepare('SELECT id FROM fc_files WHERE code = ? AND expire_at > datetime("now")').bind(code).first();
  if (existing) {
    return c.html(layout('错误', `<div class="logo"><h1>取件码已被占用</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
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
    return c.html(layout('错误', `<div class="logo"><h1>上传失败</h1></div><p style="text-align:center">${e.message}</p><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
  }
});

// ===== API: 文本分享 =====
app.post('/api/upload/text', async (c) => {
  const env = c.env;
  try {
    const body = await c.req.parseBody();
    const text = (body['text'] as string || '').trim();
    if (!text) {
      return c.html(layout('错误', '<div class="logo"><h1>内容为空</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>'));
    }

    const textSize = new TextEncoder().encode(text).length;
    const maxSize = 512 * 1024; // 512KB max for text
    if (textSize > maxSize) {
      return c.html(layout('错误', `<div class="logo"><h1>文本过长</h1></div><p style="text-align:center">最大支持 512KB</p><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
    }

    const code = ((body['code'] as string) || generateCode()).toUpperCase().trim() || generateCode();
    const maxDownloads = parseInt(body['max_downloads'] as string || '-1');
    const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7');

    const existing = await env.DB.prepare('SELECT id FROM fc_files WHERE code = ? AND expire_at > datetime("now")').bind(code).first();
    if (existing) {
      return c.html(layout('错误', '<div class="logo"><h1>取件码已被占用</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>'));
    }

    const expireAt = new Date(Date.now() + expireDays * 86400000).toISOString();
    // 取前 50 字符作为标题
    const title = text.replace(/\s+/g, ' ').slice(0, 50) + (text.length > 50 ? '…' : '');

    // Store text in KV
    await env.FILE_STORE.put(`file:${code}`, text, { metadata: { filename: title, mimeType: 'text/plain', size: textSize } });

    await env.DB.prepare(
      'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at, is_text) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    ).bind(code, title, textSize, 'text/plain', expireAt, maxDownloads, new Date().toISOString()).run();

    return c.html(resultPage(code, title, textSize));
  } catch (e: any) {
    return c.html(layout('错误', `<div class="logo"><h1>保存失败</h1></div><p style="text-align:center">${e.message}</p><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>`));
  }
});

// 获取文本内容
app.get('/api/text/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const file = await c.env.DB.prepare(
    'SELECT * FROM fc_files WHERE code = ? AND expire_at > datetime("now")'
  ).bind(code).first<any>();
  if (!file || file.is_text !== 1) return c.text('Not found', 404);

  await c.env.DB.prepare('UPDATE fc_files SET download_count = download_count + 1 WHERE code = ?').bind(code).run();
  const text = await c.env.FILE_STORE.get(`file:${code}`, 'text');
  return c.text(text || '');
});

// ===== API: 分片上传 =====
app.post('/api/chunk/init', async (c) => {
  const env = c.env;
  const body = await c.req.parseBody();
  const fileName = (body['file_name'] as string) || '未命名';
  const fileSize = parseInt(body['file_size'] as string || '0');
  const chunkSize = parseInt(body['chunk_size'] as string || '5242880');
  const mimeType = (body['mime_type'] as string) || 'application/octet-stream';

  const maxSize = parseInt(env.MAX_FILE_SIZE || '104857600');
  if (fileSize > maxSize) {
    return c.json({ error: `文件过大，最大 ${Math.floor(maxSize/1048576)}MB` }, 400);
  }

  const uploadId = crypto.randomUUID();
  const totalChunks = Math.ceil(fileSize / chunkSize);

  await env.DB.prepare(
    'INSERT INTO fc_chunks(upload_id, chunk_index, total_chunks, file_name, file_size, chunk_size, mime_type, created_at) VALUES (?, -1, ?, ?, ?, ?, ?, ?)'
  ).bind(uploadId, totalChunks, fileName, fileSize, chunkSize, mimeType, new Date().toISOString()).run();

  return c.json({ upload_id: uploadId, total_chunks: totalChunks, chunk_size: chunkSize });
});

app.post('/api/chunk/upload/:uploadId/:index', async (c) => {
  const env = c.env;
  const uploadId = c.req.param('uploadId');
  const index = parseInt(c.req.param('index'));

  const session = await env.DB.prepare(
    'SELECT * FROM fc_chunks WHERE upload_id = ? AND chunk_index = -1'
  ).bind(uploadId).first<any>();
  if (!session) return c.json({ error: 'Upload session not found' }, 404);

  const body = await c.req.parseBody();
  const chunk = body['chunk'] as File | undefined;
  if (!chunk) return c.json({ error: 'No chunk' }, 400);

  const buffer = await chunk.arrayBuffer();
  await env.FILE_STORE.put(`chunk:${uploadId}:${index}`, buffer, { expirationTtl: 3600 });

  await env.DB.prepare(
    'INSERT OR REPLACE INTO fc_chunks(upload_id, chunk_index, total_chunks, file_name, file_size, chunk_size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(uploadId, index, session.total_chunks, session.file_name, session.file_size, session.chunk_size, session.mime_type, new Date().toISOString()).run();

  return c.json({ ok: true, index });
});

app.post('/api/chunk/complete/:uploadId', async (c) => {
  const env = c.env;
  const uploadId = c.req.param('uploadId');

  const session = await env.DB.prepare(
    'SELECT * FROM fc_chunks WHERE upload_id = ? AND chunk_index = -1'
  ).bind(uploadId).first<any>();
  if (!session) return c.json({ error: 'Upload session not found' }, 404);

  // Check all chunks exist
  const uploadedChunks = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM fc_chunks WHERE upload_id = ? AND chunk_index >= 0'
  ).bind(uploadId).first<any>();

  if (uploadedChunks.count < session.total_chunks) {
    return c.json({ error: `Missing chunks: ${uploadedChunks.count}/${session.total_chunks}` }, 400);
  }

  try {
    const body = await c.req.parseBody();
    const code = ((body['code'] as string) || generateCode()).toUpperCase().trim() || generateCode();
    const maxDownloads = parseInt(body['max_downloads'] as string || '-1');
    const expireDays = parseInt(body['expire_days'] as string || env.DEFAULT_EXPIRE_DAYS || '7');

    const existing = await env.DB.prepare('SELECT id FROM fc_files WHERE code = ? AND expire_at > datetime("now")').bind(code).first();
    if (existing) {
      return c.json({ error: '取件码已被占用' }, 409);
    }

    // Assemble chunks
    const parts: ArrayBuffer[] = [];
    for (let i = 0; i < session.total_chunks; i++) {
      const chunkData = await env.FILE_STORE.get(`chunk:${uploadId}:${i}`, 'arrayBuffer');
      if (!chunkData) return c.json({ error: `Chunk ${i} data missing` }, 500);
      parts.push(chunkData);
    }

    const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const assembled = new Uint8Array(totalLength);
    let offset = 0;
    for (const p of parts) {
      assembled.set(new Uint8Array(p), offset);
      offset += p.byteLength;
    }

    const expireAt = new Date(Date.now() + expireDays * 86400000).toISOString();

    await env.FILE_STORE.put(`file:${code}`, assembled.buffer, {
      metadata: { filename: session.file_name, mimeType: session.mime_type, size: session.file_size }
    });

    await env.DB.prepare(
      'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(code, session.file_name, session.file_size, session.mime_type, expireAt, maxDownloads, new Date().toISOString()).run();

    // Cleanup chunks
    for (let i = 0; i < session.total_chunks; i++) {
      await env.FILE_STORE.delete(`chunk:${uploadId}:${i}`);
    }
    await env.DB.prepare('DELETE FROM fc_chunks WHERE upload_id = ?').bind(uploadId).run();

    return c.json({ code, name: session.file_name, size: session.file_size });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
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
    return c.html(layout('错误', '<div class="logo"><h1>已达最大下载次数</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>'));
  }

  await env.DB.prepare('UPDATE fc_files SET download_count = download_count + 1 WHERE code = ?').bind(code).run();

  const fileData = await env.FILE_STORE.get(`file:${code}`, 'arrayBuffer');
  if (!fileData) {
    return c.html(layout('错误', '<div class="logo"><h1>文件不存在</h1></div><a href="/" class="btn btn-secondary" style="text-decoration:none;margin-top:16px">返回</a>'));
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
  const storedPwd = setting?.value || env.ADMIN_PASSWORD || 'admin123';

  const hashedInput = await hashPassword(password);
  // storedPwd may already be a SHA-256 hash (64-char hex) — compare directly
  const storedIsHash = /^[a-f0-9]{64}$/.test(storedPwd);
  const matches = storedIsHash
    ? hashedInput === storedPwd
    : hashedInput === await hashPassword(storedPwd) || password === storedPwd;

  if (!matches) {
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
  // Clean orphaned chunks older than 1 day
  await env.DB.prepare("DELETE FROM fc_chunks WHERE created_at <= datetime('now', '-1 day')").run();
  return c.redirect('/admin');
});

// Cron: 自动清理过期文件
app.get('/api/cron/cleanup', async (c) => {
  const expired = await c.env.DB.prepare("SELECT * FROM fc_files WHERE expire_at <= datetime('now')").all<any>();
  for (const f of (expired.results || [])) {
    await c.env.FILE_STORE.delete(`file:${f.code}`);
  }
  await c.env.DB.prepare("DELETE FROM fc_files WHERE expire_at <= datetime('now')").run();
  await c.env.DB.prepare("DELETE FROM fc_chunks WHERE created_at <= datetime('now', '-1 day')").run();
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

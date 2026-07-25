import type { FileRecord } from '../types';
import { formatFileSize } from '../utils';
import { layout } from './layout';

// ---- 首页 ----

export function homePage(): string {
  const nav = '<div class="nav"><a href="/admin">管理</a></div>';
  const content = `
    <div class="header"><h1>FileCodeBox</h1><p>像取快递一样取文件</p></div>

    <form action="/r" method="get" style="margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--border)">
      <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:10px">取件</div>
      <div style="display:flex;gap:8px">
        <input type="text" name="code" class="input" placeholder="输入 4 位取件码" maxlength="4" required
          style="text-align:center;font-size:20px;letter-spacing:6px;text-transform:uppercase;flex:1" autocomplete="off">
        <button type="submit" class="btn btn-primary" style="width:auto;padding:10px 20px">取件</button>
      </div>
    </form>

    <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:10px">上传新文件</div>
    <form action="/api/upload" method="post" enctype="multipart/form-data"
      onsubmit="var b=document.getElementById('uploadBtn');b.disabled=true;b.textContent='上传中...'">
      <div class="input-group"><label>选择文件</label><input type="file" name="file" required class="input"></div>
      <div style="display:flex;gap:12px">
        <div class="input-group" style="flex:1"><label>最大下载次数</label><input type="number" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限"></div>
        <div class="input-group" style="flex:1"><label>过期天数</label><input type="number" name="expire_days" min="1" max="365" value="7" class="input" placeholder="7"></div>
      </div>
      <div class="input-group"><label>自定义取件码（留空自动生成）</label><input type="text" name="code" class="input" placeholder="4 位取件码" maxlength="4" pattern="[A-Z0-9]{0,4}"></div>
      <button type="submit" id="uploadBtn" class="btn btn-primary">上传并获取取件码</button>
    </form>`;
  return layout('FileCodeBox', content, nav);
}

// ---- 取件页 ----

export function retrievePage(code?: string): string {
  const nav = '<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>';
  const content = `
    <div class="header"><h1>取件</h1><p>输入取件码下载文件</p></div>
    <form action="/r" method="get">
      <div class="input-group"><label>取件码</label>
        <input type="text" name="code" value="${code ?? ''}" class="input" placeholder="输入 4 位取件码"
          maxlength="4" required style="text-align:center;font-size:22px;letter-spacing:8px;text-transform:uppercase" autofocus>
      </div>
      <button type="submit" class="btn btn-primary">取件</button>
    </form>`;
  return layout('取件', content, nav);
}

// ---- 上传成功页 ----

export function resultPage(code: string, filename: string, size: number, baseUrl: string): string {
  const shareUrl = `${baseUrl}/r/${code}`;
  const nav = '<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>';
  const content = `
    <div class="header"><h1>上传成功</h1></div>
    <div class="code-box">
      <div style="font-size:13px;color:var(--text2);margin-bottom:8px">取件码</div>
      <div class="code-display">${code}</div>
      <button class="copy-text-btn" onclick="navigator.clipboard.writeText('${code}').then(()=>{this.textContent='已复制'});setTimeout(()=>{this.textContent='复制取件码'},2000)">复制取件码</button>
      <div class="info-row" style="margin-top:16px">
        <span class="info-tag">${filename}</span>
        <span class="info-tag">${formatFileSize(size)}</span>
      </div>
      <div style="margin-top:16px">
        <button class="copy-text-btn" onclick="navigator.clipboard.writeText('${shareUrl}').then(()=>{this.textContent='链接已复制'});setTimeout(()=>{this.textContent='复制分享链接'},2000)">复制分享链接</button>
      </div>
    </div>
    <a href="/" class="btn btn-secondary" style="margin-top:12px">继续上传</a>`;
  return layout('上传成功', content, nav);
}

// ---- 文件详情页 ----

export function filePage(file: FileRecord, baseUrl: string): string {
  const nav = '<div class="nav"><a href="/">上传</a><a href="/admin">管理</a></div>';
  const sizeStr = formatFileSize(file.size);
  const dlInfo = file.max_downloads < 0 ? '不限次数' : `已下载 ${file.download_count}/${file.max_downloads} 次`;
  const expireDate = new Date(file.expire_at);
  const expireStr =
    expireDate.getTime() - Date.now() > 365 * 86400000
      ? '永久有效'
      : `过期: ${expireDate.toLocaleDateString('zh-CN')}`;
  const expired = expireDate.getTime() < Date.now();
  const shareUrl = `${baseUrl}/r/${file.code}`;

  const content = `
    <div class="header"><h1>取件</h1></div>
    ${expired ? '<div style="text-align:center;color:var(--danger);font-size:14px;margin-bottom:16px">此文件已过期</div>' : ''}
    <div style="text-align:center;padding:16px 0">
      <div class="file-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
      </div>
      <div style="font-size:18px;font-weight:500;margin-bottom:6px;word-break:break-all">${file.filename}</div>
      <div style="display:flex;justify-content:center;gap:20px;font-size:13px;color:var(--text2);margin-bottom:6px">
        <span>${sizeStr}</span>
        <span>${dlInfo}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:20px">${expireStr}</div>
      ${!expired ? `
        <a href="/api/download/${file.code}" class="btn btn-primary" style="width:auto;padding:12px 40px;display:inline-flex">下载文件</a>
        <div style="margin-top:12px;font-size:13px;color:var(--text2)">
          取件码 <strong style="font-size:18px;color:var(--accent);letter-spacing:3px;font-family:monospace">${file.code}</strong>
        </div>
        <div style="margin-top:8px">
          <button onclick="navigator.clipboard.writeText('${shareUrl}')" class="btn btn-secondary" style="width:auto;display:inline-flex;padding:8px 16px;font-size:13px">复制分享链接</button>
        </div>
      ` : ''}
    </div>`;
  return layout('取件', content, nav);
}

// ---- 管理员登录页 ----

export function adminLoginPage(error?: string): string {
  const content = `
    <div class="header"><h1>管理员登录</h1><p>FileCodeBox 后台管理</p></div>
    ${error ? `<div style="color:var(--danger);text-align:center;margin-bottom:16px;font-size:14px">${error}</div>` : ''}
    <form action="/api/admin/login" method="post">
      <div class="input-group"><label>密码</label><input type="password" name="password" class="input" placeholder="输入管理员密码" required autofocus></div>
      <button type="submit" class="btn btn-primary">登录</button>
    </form>
    <div style="text-align:center;margin-top:16px"><a href="/" style="font-size:13px;color:var(--text2);text-decoration:none">&larr; 返回首页</a></div>`;
  return layout('管理员登录', content);
}

// ---- 管理面板 ----

export function adminPanel(
  files: FileRecord[],
  total: number,
  page: number,
  error?: string,
): string {
  const nav =
    '<div class="nav"><a href="/">首页</a><a href="/api/admin/logout">退出</a></div>';
  const totalPages = Math.ceil(total / 50);
  const pagination =
    totalPages > 1
      ? `<div style="text-align:center;margin-top:14px;font-size:13px;color:var(--text2)">第 ${page}/${totalPages} 页 &middot; 共 ${total} 个文件</div>`
      : '';

  const fileRows = files
    .map((f) => {
      const expired = new Date(f.expire_at).getTime() < Date.now();
      const size = formatFileSize(f.size);
      return `<div class="file-list-item ${expired ? 'expired' : ''}">
        <span class="fname">${f.filename}</span>
        <span class="fmeta">${f.code}</span>
        <span class="fmeta">${size}</span>
        <span class="fmeta">${f.download_count}次</span>
        <span class="fmeta">${f.expire_at.slice(0, 10)}</span>
        <form method="post" action="/api/admin/delete/${f.id}" style="display:inline;margin-left:6px" onsubmit="return confirm('确认删除？')">
          <button type="submit" class="btn-danger" style="background:none;border:none;cursor:pointer">删除</button>
        </form>
      </div>`;
    })
    .join('');

  const content = `
    <div class="header"><h1>管理面板</h1><p>共 ${total} 个文件</p></div>
    ${error ? `<div style="color:var(--danger);text-align:center;margin-bottom:14px;font-size:14px">${error}</div>` : ''}
    <div style="margin-bottom:14px">
      <form method="post" action="/api/admin/cleanup" style="display:inline" onsubmit="return confirm('确认清理所有过期文件？')">
        <button type="submit" class="btn btn-secondary btn-sm" style="text-decoration:none">清理过期文件</button>
      </form>
    </div>
    <div>${fileRows || '<div style="text-align:center;color:var(--text2);padding:20px">暂无文件</div>'}</div>
    ${pagination}
    <div style="text-align:center;margin-top:14px">
      ${page > 1 ? `<a href="/admin?page=${page - 1}" style="font-size:13px;margin-right:10px;color:var(--accent);text-decoration:none">&larr; 上一页</a>` : ''}
      ${page < totalPages ? `<a href="/admin?page=${page + 1}" style="font-size:13px;color:var(--accent);text-decoration:none">下一页 &rarr;</a>` : ''}
    </div>`;
  return layout('管理面板', content, nav);
}

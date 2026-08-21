import type { FileRecord } from '../types';
import { formatFileSize } from '../utils';
import { layout } from './layout';

// ---- 首页 ----

export function homePage(): string {
  const content = `
    <div class="header">
      <div>
        <h1>FileCodeBox</h1>
        <p>像取快递一样取文件</p>
      </div>
      <div class="header-actions">
        <a href="/admin">管理</a>
      </div>
    </div>

    <!-- 取件区 -->
    <form action="/r" method="get" style="margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--color-rule)">
      <div style="font-size:13px;font-weight:500;color:var(--color-ink-2);margin-bottom:10px">取件</div>
      <div style="display:flex;gap:8px">
        <input type="text" name="code" class="input" placeholder="输入 4 位取件码" maxlength="4" required
          style="text-align:center;font-size:20px;letter-spacing:6px;flex:1" autocomplete="off" inputmode="numeric" pattern="[0-9]{4}">
        <button type="submit" class="btn btn-warm" style="width:auto;padding:10px 20px">取件</button>
      </div>
    </form>

    <!-- 上传区 -->
    <div style="font-size:13px;font-weight:500;color:var(--color-ink-2);margin-bottom:10px">上传新内容</div>

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
        <div class="input-group"><label>自定义取件码 <span style="font-weight:400;color:var(--color-ink-2)">（可选，留空自动生成）</span></label><input type="text" name="code" class="input" placeholder="4 位数字取件码" maxlength="4" inputmode="numeric" pattern="[0-9]{0,4}"></div>
        <div class="upload-progress" id="uploadProgress"><div class="upload-progress-bar" id="uploadProgressBar"></div></div>
        <div class="upload-status" id="uploadStatus"></div>
        <button type="submit" id="submitBtn" class="btn btn-primary">上传并获取取件码</button>
      </form>
    </div>

    <!-- 文本分享面板 -->
    <div id="tab-text" class="tab-panel">
      <form action="/api/upload/text" method="post" onsubmit="var b=document.getElementById('textSubmitBtn');b.disabled=true;b.textContent='保存中\u2026'">
        <div class="input-group"><label>文本内容</label><textarea name="text" class="input" placeholder="粘贴或输入要分享的文本内容\u2026" required></textarea></div>
        <div style="display:flex;gap:12px">
          <div class="input-group" style="flex:1"><label>最大查看次数</label><input type="number" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限"></div>
          <div class="input-group" style="flex:1"><label>过期天数</label><input type="number" name="expire_days" min="1" max="365" value="7" class="input" placeholder="7"></div>
        </div>
        <div class="input-group"><label>自定义取件码 <span style="font-weight:400;color:var(--color-ink-2)">（可选，留空自动生成）</span></label><input type="text" name="code" class="input" placeholder="4 位数字取件码" maxlength="4" inputmode="numeric" pattern="[0-9]{0,4}"></div>
        <button type="submit" id="textSubmitBtn" class="btn btn-primary">保存并获取取件码</button>
      </form>
    </div>

    <script>
    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t.textContent.trim().toLowerCase().includes(name)) });
      document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active') });
      document.getElementById('tab-' + name).classList.add('active');
    }
    function handleUpload(e) {
      e.preventDefault();
      var file = document.getElementById('fileInput').files[0];
      if (!file) return;
      var btn = document.getElementById('submitBtn');
      var progress = document.getElementById('uploadProgress');
      var progressBar = document.getElementById('uploadProgressBar');
      var status = document.getElementById('uploadStatus');

      var code = document.querySelector('[name="code"]').value || '';
      var maxDownloads = document.querySelector('[name="max_downloads"]').value || '-1';
      var expireDays = document.querySelector('[name="expire_days"]').value || '7';

      var url = '/api/upload?code=' + encodeURIComponent(code) +
                '&max_downloads=' + encodeURIComponent(maxDownloads) +
                '&expire_days=' + encodeURIComponent(expireDays);

      function resetUpload() {
        btn.disabled = false;
        btn.textContent = '\u4e0a\u4f20\u5e76\u83b7\u53d6\u53d6\u4ef6\u7801';
        progress.style.display = 'none';
        status.style.display = 'none';
        progressBar.style.width = '0%';
      }

      // 用 XMLHttpRequest 获取原生上传进度（fetch 不支持）
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      btn.disabled = true;
      btn.textContent = '\u4e0a\u4f20\u4e2d\u2026';
      progress.style.display = 'block';
      status.style.display = 'block';
      status.textContent = '\u4e0a\u4f20\u4e2d 0%';

      xhr.upload.onprogress = function(event) {
        if (event.lengthComputable) {
          var pct = Math.round(event.loaded / event.total * 100);
          progressBar.style.width = pct + '%';
          status.textContent = '\u4e0a\u4f20\u4e2d ' + pct + '%';
        }
      };

      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.code) {
            status.textContent = '\u4e0a\u4f20\u5b8c\u6210\uff0c\u8df3\u8f6c\u4e2d\u2026';
            window.location.href = '/r/' + data.code;
          } else {
            alert(data.error || '\u4e0a\u4f20\u5931\u8d25');
            resetUpload();
          }
        } catch (err) {
          alert('\u4e0a\u4f20\u5931\u8d25');
          resetUpload();
        }
      };

      xhr.onerror = function() {
        alert('\u4e0a\u4f20\u5931\u8d25\uff1a\u7f51\u7edc\u9519\u8bef');
        resetUpload();
      };

      xhr.send(file);
    }
    </script>`;
  return layout('FileCodeBox', content);
}

// ---- 取件页 ----

export function retrievePage(code?: string): string {
  const content = `
    <div class="header">
      <div>
        <h1>取件</h1>
        <p>输入取件码下载文件</p>
      </div>
      <div class="header-actions">
        <a href="/">上传</a>
        <a href="/admin">管理</a>
      </div>
    </div>
    <form action="/r" method="get">
      <div class="input-group"><label>取件码</label>
        <input type="text" name="code" value="${code ?? ''}" class="input" placeholder="输入 4 位数字取件码"
          maxlength="4" required style="text-align:center;font-size:22px;letter-spacing:8px" inputmode="numeric" pattern="[0-9]{4}" autofocus>
      </div>
      <button type="submit" class="btn btn-primary">取件</button>
    </form>`;
  return layout('取件', content);
}

// ---- 上传成功页 ----

export function resultPage(code: string, filename: string, size: number, baseUrl: string): string {
  const shareUrl = `${baseUrl}/r/${code}`;
  const content = `
    <div class="header">
      <div>
        <h1>上传成功</h1>
      </div>
      <div class="header-actions">
        <a href="/">上传</a>
        <a href="/admin">管理</a>
      </div>
    </div>
    <div class="code-box">
      <div style="font-size:13px;color:var(--color-ink-2);margin-bottom:8px">取件码</div>
      <div class="code-display">${code}</div>
      <button class="copy-text-btn" onclick="var t=this;navigator.clipboard.writeText('${code}').then(function(){t.textContent='\u5df2\u590d\u5236'});setTimeout(function(){t.textContent='\u590d\u5236\u53d6\u4ef6\u7801'},2000)">复制取件码</button>
      <div class="info-row" style="margin-top:16px">
        <span class="info-tag">${filename}</span>
        <span class="info-tag">${formatFileSize(size)}</span>
      </div>
      <div style="margin-top:16px">
        <button class="copy-text-btn" onclick="var t=this;navigator.clipboard.writeText('${shareUrl}').then(function(){t.textContent='\u94fe\u63a5\u5df2\u590d\u5236'});setTimeout(function(){t.textContent='\u590d\u5236\u5206\u4eab\u94fe\u63a5'},2000)">复制分享链接</button>
      </div>
    </div>
    <a href="/" class="btn btn-secondary" style="margin-top:12px">继续上传</a>`;
  return layout('上传成功', content);
}

// ---- 文件详情页 ----

export function filePage(file: FileRecord, baseUrl: string): string {
  const sizeStr = formatFileSize(file.size);
  const dlInfo = file.max_downloads < 0 ? `已下载 ${file.download_count} 次` : `已下载 ${file.download_count}/${file.max_downloads} 次`;
  const expireDate = new Date(file.expire_at);
  const expireStr =
    expireDate.getTime() - Date.now() > 365 * 86400000
      ? '永久有效'
      : `过期: ${expireDate.toLocaleDateString('zh-CN')}`;
  const expired = expireDate.getTime() < Date.now();
  const shareUrl = `${baseUrl}/r/${file.code}`;

  // 文本内容 — 页面内展示
  if (file.is_text === 1 && !expired) {
    const content = `
      <div class="header">
        <div>
          <h1>取件</h1>
        </div>
        <div class="header-actions">
          <a href="/">上传</a>
          <a href="/admin">管理</a>
        </div>
      </div>
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:20px;font-weight:600;margin-bottom:4px;word-break:break-all">${file.filename}</div>
        <div style="display:flex;justify-content:center;gap:24px;font-size:13px;color:var(--color-ink-2);margin-bottom:16px">
          <span>${sizeStr}</span>
          <span>${dlInfo}</span>
          <span>${expireStr}</span>
        </div>
        <div class="text-content" id="textContent">加载中…</div>
        <div style="margin-top:12px;font-size:13px;color:var(--color-ink-2)">
          取件码: <strong style="font-size:18px;color:var(--color-accent);letter-spacing:3px;font-family:var(--font-mono)">${file.code}</strong>
        </div>
        <div style="margin-top:8px">
          <button onclick="navigator.clipboard.writeText('${shareUrl}')" class="btn btn-secondary" style="width:auto;display:inline-flex;padding:8px 16px;font-size:13px">复制分享链接</button>
        </div>
      </div>
      <script>
        fetch('/api/text/${file.code}').then(function(r){return r.text()}).then(function(t){
          document.getElementById('textContent').textContent = t;
        });
      </script>`;
    return layout('取件', content);
  }

  // 文件下载页
  const content = `
    <div class="header">
      <div>
        <h1>取件</h1>
      </div>
      <div class="header-actions">
        <a href="/">上传</a>
        <a href="/admin">管理</a>
      </div>
    </div>
    ${expired ? '<div style="text-align:center;color:var(--color-danger);font-size:14px;margin-bottom:16px">此文件已过期</div>' : ''}
    <div style="text-align:center;padding:16px 0">
      <div class="file-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
      </div>
      <div style="font-size:18px;font-weight:500;margin-bottom:6px;word-break:break-all">${file.filename}</div>
      <div style="display:flex;justify-content:center;gap:20px;font-size:13px;color:var(--color-ink-2);margin-bottom:6px">
        <span>${sizeStr}</span>
        <span>${dlInfo}</span>
      </div>
      <div style="font-size:12px;color:var(--color-ink-2);margin-bottom:20px">${expireStr}</div>
      ${!expired ? `
        <a href="/api/download/${file.code}" class="btn btn-primary" style="width:auto;padding:12px 40px;display:inline-flex">下载文件</a>
        <div style="margin-top:12px;font-size:13px;color:var(--color-ink-2)">
          取件码 <strong style="font-size:18px;color:var(--color-accent);letter-spacing:3px;font-family:var(--font-mono)">${file.code}</strong>
        </div>
        <div style="margin-top:8px">
          <button onclick="navigator.clipboard.writeText('${shareUrl}')" class="btn btn-secondary" style="width:auto;display:inline-flex;padding:8px 16px;font-size:13px">复制分享链接</button>
        </div>
      ` : ''}
    </div>`;
  return layout('取件', content);
}

// ---- 错误页 ----

export function errorPage(title: string, message: string): string {
  const content = `
    <div class="header"><h1>${title}</h1></div>
    <p style="text-align:center">${message}</p>
    <a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>`;
  return layout(title, content);
}

// ---- 管理员登录页 ----

export function adminLoginPage(error?: string): string {
  const content = `
    <div class="header"><h1>管理员登录</h1><p>FileCodeBox 后台管理</p></div>
    ${error ? `<div style="color:var(--color-danger);text-align:center;margin-bottom:16px;font-size:14px">${error}</div>` : ''}
    <form action="/api/admin/login" method="post">
      <div class="input-group"><label>密码</label><input type="password" name="password" class="input" placeholder="输入管理员密码" required autofocus></div>
      <button type="submit" class="btn btn-primary">登录</button>
    </form>
    <div style="text-align:center;margin-top:16px"><a href="/" style="font-size:13px;color:var(--color-ink-2);text-decoration:none">&larr; 返回首页</a></div>`;
  return layout('管理员登录', content);
}

// ---- 管理面板 ----

export function adminPanel(
  files: FileRecord[],
  total: number,
  page: number,
  error?: string,
): string {
  const totalPages = Math.ceil(total / 50);
  const pagination =
    totalPages > 1
      ? `<div style="text-align:center;margin-top:14px;font-size:13px;color:var(--color-ink-2)">第 ${page}/${totalPages} 页 &middot; 共 ${total} 个文件</div>`
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
        <form method="post" action="/api/admin/delete/${f.id}" style="display:inline;margin-left:6px" onsubmit="return confirm('\u786e\u8ba4\u5220\u9664\uff1f')">
          <button type="submit" class="btn-danger" style="background:none;border:none;cursor:pointer">删除</button>
        </form>
      </div>`;
    })
    .join('');

  const content = `
    <div class="header">
      <div>
        <h1>管理面板</h1>
        <p>共 ${total} 个文件</p>
      </div>
      <div class="header-actions">
        <a href="/">首页</a>
        <a href="/api/admin/logout">退出</a>
      </div>
    </div>
    ${error ? `<div style="color:var(--color-danger);text-align:center;margin-bottom:14px;font-size:14px">${error}</div>` : ''}
    <div style="margin-bottom:14px">
      <form method="post" action="/api/admin/cleanup" style="display:inline" onsubmit="return confirm('\u786e\u8ba4\u6e05\u7406\u6240\u6709\u8fc7\u671f\u6587\u4ef6\uff1f')">
        <button type="submit" class="btn btn-secondary btn-sm" style="text-decoration:none">清理过期文件</button>
      </form>
    </div>
    <div>${fileRows || '<div style="text-align:center;color:var(--color-ink-2);padding:20px">暂无文件</div>'}</div>
    ${pagination}
    <div style="text-align:center;margin-top:14px">
      ${page > 1 ? `<a href="/admin?page=${page - 1}" style="font-size:13px;margin-right:10px;color:var(--color-accent);text-decoration:none">&larr; 上一页</a>` : ''}
      ${page < totalPages ? `<a href="/admin?page=${page + 1}" style="font-size:13px;color:var(--color-accent);text-decoration:none">下一页 &rarr;</a>` : ''}
    </div>`;
  return layout('管理面板', content);
}

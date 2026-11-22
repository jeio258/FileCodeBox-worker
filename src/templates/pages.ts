import type { FileRecord } from '../types';
import { escapeHtml, formatFileSize } from '../utils';
import { layout } from './layout';

// ===================== 片段 =====================

const ACTIONS = '<div class="header-actions"><a href="/">上传</a><a href="/admin">管理</a></div>';
const ACTIONS_ADMIN_ONLY = '<div class="header-actions"><a href="/admin">管理</a></div>';

/** 页头：标题 + 可选副标题 + 操作区 */
function pageHeader(title: string, subtitle?: string, actions = ACTIONS): string {
  return `<div class="header">
      <div>
        <h1>${title}</h1>${subtitle ? `\n        <p>${subtitle}</p>` : ''}
      </div>
      ${actions}
    </div>`;
}

const field = (label: string, input: string): string =>
  `<div class="input-group"><label>${label}</label>${input}</div>`;

const twoCols = (a: string, b: string): string => `<div class="row-2">${a}${b}</div>`;

const metaRow = (...items: string[]): string =>
  `<div class="meta-row">${items.map((i) => `<span>${i}</span>`).join('')}</div>`;

const sectionTitle = (text: string): string => `<div class="section-title">${text}</div>`;

/** 分享右栏：取件码卡 + 二维码（取件页与上传结果页共用） */
function shareRightPanel(code: string, shareUrl: string): string {
  return `
    <div class="share-right">
      <div class="code-card" onclick="codeCopy(this,'${escapeHtml(code)}')">
        <div class="code-label">取件码</div>
        <div class="code-value">${escapeHtml(code)}</div>
        <div class="click-hint">点击复制</div>
      </div>
      <div class="share-divider"></div>
      <img src="/qrcode/${code}" alt="QR Code" class="qr-img" loading="lazy">
      <div class="qr-title">扫码快速分享</div>
      <button class="btn btn-secondary share-link-btn" data-copy="${escapeHtml(shareUrl)}" onclick="codeCopy(this, this.dataset.copy)">复制分享链接</button>
    </div>`;
}

const shareGrid = (left: string, code: string, shareUrl: string): string =>
  `<div class="share-grid"><div class="share-left">${left}</div>${shareRightPanel(code, shareUrl)}</div>`;

// ===================== 首页 =====================

export function homePage(opts: { chunkThreshold: number }): string {
  const content = `
    ${pageHeader('FileCodeBox', '像取快递一样取文件', ACTIONS_ADMIN_ONLY)}

    <form action="/r" method="get" class="pickup-form">
      ${sectionTitle('取件')}
      <div class="row">
        <input type="text" name="code" class="input pickup-input" placeholder="输入 4 位取件码" maxlength="4" required autocomplete="off" inputmode="numeric" pattern="[0-9]{4}">
        <button type="submit" class="btn btn-warm btn-pickup">取件</button>
      </div>
    </form>

    ${sectionTitle('上传新内容')}

    <div class="tabs">
      <button class="tab active" data-tab="file" onclick="switchTab('file')">文件</button>
      <button class="tab" data-tab="text" onclick="switchTab('text')">文本</button>
    </div>

    <div id="tab-file" class="tab-panel active">
      <form id="uploadForm" onsubmit="handleUpload(event)">
        ${field('选择文件', '<input type="file" name="file" id="fileInput" required class="input">')}
        ${twoCols(
          field('最大下载次数', '<input type="number" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限">'),
          field('过期天数', '<input type="number" name="expire_days" min="1" max="365" value="7" class="input" placeholder="7">'),
        )}
        ${field('自定义取件码 <span class="hint">（可选，留空自动生成）</span>', '<input type="text" name="code" class="input" placeholder="4 位数字取件码" maxlength="4" inputmode="numeric" pattern="[0-9]{0,4}">')}
        <div class="upload-progress" id="uploadProgress"><div class="upload-progress-bar" id="uploadProgressBar"></div></div>
        <div class="upload-status" id="uploadStatus"></div>
        <button type="submit" id="submitBtn" class="btn btn-primary">上传并获取取件码</button>
      </form>
    </div>

    <div id="tab-text" class="tab-panel">
      <form action="/api/upload/text" method="post" onsubmit="var b=document.getElementById('textSubmitBtn');b.disabled=true;b.textContent='保存中\u2026'">
        ${field('文本内容', '<textarea name="text" class="input" placeholder="粘贴或输入要分享的文本内容\u2026" required></textarea>')}
        ${twoCols(
          field('最大查看次数', '<input type="number" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限">'),
          field('过期天数', '<input type="number" name="expire_days" min="1" max="365" value="7" class="input" placeholder="7">'),
        )}
        ${field('自定义取件码 <span class="hint">（可选，留空自动生成）</span>', '<input type="text" name="code" class="input" placeholder="4 位数字取件码" maxlength="4" inputmode="numeric" pattern="[0-9]{0,4}">')}
        <button type="submit" id="textSubmitBtn" class="btn btn-primary">保存并获取取件码</button>
      </form>
    </div>

    <script>
    var CHUNK_THRESHOLD = ${opts.chunkThreshold};

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name) });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active') });
      document.getElementById('tab-' + name).classList.add('active');
    }

    function resetUpload(btn, progress, status, progressBar) {
      btn.disabled = false;
      btn.textContent = '\u4e0a\u4f20\u5e76\u83b7\u53d6\u53d6\u4ef6\u7801';
      progress.style.display = 'none';
      status.style.display = 'none';
      progressBar.style.width = '0%';
    }

    function handleUpload(e) {
      e.preventDefault();
      var file = document.getElementById('fileInput').files[0];
      if (!file) return;

      var ui = {
        btn: document.getElementById('submitBtn'),
        progress: document.getElementById('uploadProgress'),
        progressBar: document.getElementById('uploadProgressBar'),
        status: document.getElementById('uploadStatus')
      };
      var opts = {
        code: document.querySelector('[name="code"]').value || '',
        maxDownloads: document.querySelector('[name="max_downloads"]').value || '-1',
        expireDays: document.querySelector('[name="expire_days"]').value || '7'
      };
      var reset = function () { resetUpload(ui.btn, ui.progress, ui.status, ui.progressBar) };

      // 超过平台单请求上限（免费计划 100MB）走分片上传
      if (file.size > CHUNK_THRESHOLD) return chunkUpload(file, opts, ui, reset);

      ui.btn.disabled = true;
      ui.btn.textContent = '\u4e0a\u4f20\u4e2d\u2026';
      ui.progress.style.display = 'block';
      ui.status.style.display = 'block';
      ui.status.textContent = '\u4e0a\u4f20\u4e2d 0%';

      // XMLHttpRequest 才有原生上传进度
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?code=' + encodeURIComponent(opts.code) +
        '&max_downloads=' + encodeURIComponent(opts.maxDownloads) +
        '&expire_days=' + encodeURIComponent(opts.expireDays));
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) return;
        var pct = Math.round(event.loaded / event.total * 100);
        ui.progressBar.style.width = pct + '%';
        ui.status.textContent = '\u4e0a\u4f20\u4e2d ' + pct + '%';
      };
      xhr.onload = function () {
        try {
          var data = JSON.parse(xhr.responseText);
          if (!data.code) return alert(data.error || '\u4e0a\u4f20\u5931\u8d25'), reset();
          ui.status.textContent = '\u4e0a\u4f20\u5b8c\u6210\uff0c\u8df3\u8f6c\u4e2d\u2026';
          window.location.href = '/r/' + data.code;
        } catch (err) { alert('\u4e0a\u4f20\u5931\u8d25'); reset(); }
      };
      xhr.onerror = function () { alert('\u4e0a\u4f20\u5931\u8d25\uff1a\u7f51\u7edc\u9519\u8bef'); reset(); };
      xhr.send(file);
    }

    // 分片上传：init → 并发 4 片 put（单片重试 3 次）→ complete
    function chunkUpload(file, opts, ui, reset) {
      var CHUNK = 30 * 1024 * 1024;
      var CONCURRENCY = 4;
      var totalChunks = Math.ceil(file.size / CHUNK);
      var uploadedBytes = 0;
      var failed = [];

      ui.btn.disabled = true;
      ui.btn.textContent = '\u5206\u7247\u4e0a\u4f20\u4e2d\u2026';
      ui.progress.style.display = 'block';
      ui.status.style.display = 'block';
      ui.status.textContent = '\u5206\u7247\u4e0a\u4f20 0/' + totalChunks;

      function updateProgress() {
        var pct = Math.round(uploadedBytes / file.size * 100);
        ui.progressBar.style.width = pct + '%';
        ui.status.textContent = '\u5206\u7247\u4e0a\u4f20\u4e2d ' + Math.round(uploadedBytes / 1048576) +
          '/' + Math.round(file.size / 1048576) + ' MB (' + pct + '%)';
      }

      function putChunk(uploadId, index) {
        var slice = file.slice(index * CHUNK, Math.min((index + 1) * CHUNK, file.size));
        return fetch('/api/upload/chunk/' + uploadId + '/' + index, { method: 'PUT', body: slice })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }) })
          .then(function (res) {
            if (!res.ok) throw new Error(res.j.error || '\u5206\u7247\u4e0a\u4f20\u5931\u8d25');
            uploadedBytes += slice.size;
            updateProgress();
          });
      }

      // 并发池：同时跑 CONCURRENCY 个分片，失败片最多重试 3 次
      function runPool(uploadId, indexes) {
        var next = 0;
        var retry = {};
        function worker() {
          if (next >= indexes.length) return Promise.resolve();
          var idx = indexes[next++];
          return putChunk(uploadId, idx).catch(function () {
            retry[idx] = (retry[idx] || 0) + 1;
            if (retry[idx] <= 3) { indexes.push(idx); return worker(); }
            failed.push(idx);
          }).then(worker);
        }
        return Promise.all(Array.from({ length: Math.min(CONCURRENCY, indexes.length) }, worker));
      }

      fetch('/api/upload/chunk/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          total_chunks: totalChunks,
          mime_type: file.type || 'application/octet-stream',
          code: opts.code,
          max_downloads: opts.maxDownloads,
          expire_days: opts.expireDays
        })
      })
        .then(function (r) { return r.json(); })
        .then(function (init) {
          if (!init.upload_id) throw new Error(init.error || '\u521d\u59cb\u5316\u5931\u8d25');
          var all = Array.from({ length: totalChunks }, function (_, i) { return i; });
          return runPool(init.upload_id, all).then(function () {
            if (failed.length) throw new Error('\u6709 ' + failed.length + ' \u7247\u4e0a\u4f20\u5931\u8d25');
            ui.status.textContent = '\u5408\u5e76\u4e2d\u2026';
            return fetch('/api/upload/chunk/complete/' + init.upload_id, { method: 'POST' }).then(function (r) { return r.json(); });
          });
        })
        .then(function (res) {
          if (!res.code) throw new Error(res.error || '\u5408\u5e76\u5931\u8d25');
          window.location.href = '/r/' + res.code;
        })
        .catch(function (e) {
          ui.status.textContent = e.message || '\u5206\u7247\u4e0a\u4f20\u5931\u8d25';
          reset();
        });
    }
    </script>`;
  return layout('FileCodeBox', content);
}

// ===================== 取件页 =====================

export function retrievePage(code?: string): string {
  const content = `
    ${pageHeader('取件', '输入取件码下载文件')}
    <form action="/r" method="get">
      ${field('取件码', `<input type="text" name="code" value="${escapeHtml(code ?? '')}" class="input pickup-code" placeholder="输入 4 位数字取件码" maxlength="4" required inputmode="numeric" pattern="[0-9]{4}" autofocus>`)}
      <button type="submit" class="btn btn-primary">取件</button>
    </form>`;
  return layout('取件', content);
}

// ===================== 文件 / 文本取件页 =====================

export function filePage(file: FileRecord, baseUrl: string): string {
  const shareUrl = `${baseUrl}/r/${file.code}`;
  const expireDate = new Date(file.expire_at);
  const expireStr =
    expireDate.getTime() - Date.now() > 365 * 86400000
      ? '永久有效'
      : `过期: ${expireDate.toLocaleDateString('zh-CN')}`;
  const dlInfo =
    file.max_downloads < 0
      ? `已下载 ${file.download_count} 次`
      : `已下载 ${file.download_count}/${file.max_downloads} 次`;
  const meta = metaRow(formatFileSize(file.size), dlInfo, expireStr);

  // 文本分享：内容由客户端拉取（含查看计数与超时处理）
  if (file.is_text === 1) {
    const left = `
        ${pageHeader('取件')}
        <div class="share-title">文本</div>
        <div class="command-box">
          <div class="command-text" id="textContent">加载中…</div>
          <button class="btn-copy-cmd" id="copyAllBtn" hidden onclick="copyAll(this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>复制全文</span>
          </button>
        </div>
        ${meta}
        <script>
        function copyAll(el) {
          navigator.clipboard.writeText(window.__shareText || '').then(function () {
            var s = el.querySelector('span');
            s.textContent = '已复制';
            setTimeout(function () { s.textContent = '复制全文'; }, 1500);
          });
        }
        (function () {
          var el = document.getElementById('textContent');
          var ctrl = new AbortController();
          var timer = setTimeout(function () { ctrl.abort(); }, 8000);
          function fail(msg) { clearTimeout(timer); el.textContent = msg; el.style.color = 'var(--color-danger)'; }
          fetch('/api/text/${file.code}', { signal: ctrl.signal })
            .then(function (r) {
              clearTimeout(timer);
              if (r.status === 403) { fail('该内容已达最大查看次数。'); return null; }
              if (r.status === 404) { fail('内容不存在或已被清理。'); return null; }
              if (!r.ok) { fail('内容加载失败，请稍后重试。'); return null; }
              return r.text();
            })
            .then(function (t) {
              if (t === null) return;
              window.__shareText = t;
              el.textContent = t;
              document.getElementById('copyAllBtn').hidden = false;
            })
            .catch(function (err) {
              if (err.name === 'AbortError') fail('加载超时，请刷新重试。');
              else fail('内容加载失败，请稍后重试。');
            });
        })();
        </script>`;
    return layout('取件', shareGrid(left, file.code, shareUrl), true, true);
  }

  const left = `
        ${pageHeader('取件')}
        <div class="share-title">${escapeHtml(file.filename)}</div>
        <div class="command-box center-box">
          <div class="file-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
          </div>
          <a href="/api/download/${file.code}" class="btn btn-primary btn-download">下载文件</a>
        </div>
        ${meta}`;
  return layout('取件', shareGrid(left, file.code, shareUrl), true, true);
}

// ===================== 错误页 / 登录页 =====================

export function errorPage(title: string, message: string): string {
  return layout(
    title,
    `<div class="header"><h1>${escapeHtml(title)}</h1></div>
    <p class="text-center">${escapeHtml(message)}</p>
    <a href="/" class="btn btn-secondary mt-16">返回</a>`,
  );
}

export function adminLoginPage(error?: string): string {
  return layout(
    '管理员登录',
    `<div class="header"><h1>管理员登录</h1><p>FileCodeBox 后台管理</p></div>
    ${error ? `<div class="form-error">${escapeHtml(error)}</div>` : ''}
    <form action="/admin/login" method="post">
      ${field('密码', '<input type="password" name="password" class="input" placeholder="输入管理员密码" required autofocus>')}
      <button type="submit" class="btn btn-primary">登录</button>
    </form>
    <div class="text-center mt-16"><a href="/" class="back-link">&larr; 返回首页</a></div>`,
  );
}

// ===================== 管理面板 =====================

const SORT_LABELS: Record<string, string> = {
  newest: '最新上传',
  oldest: '最早上传',
  largest: '文件最大',
  smallest: '文件最小',
  mostDownloaded: '下载最多',
  leastDownloaded: '下载最少',
};

interface Filters {
  keyword: string;
  dateFrom: string;
  dateTo: string;
  sort: string;
}

export function adminPanel(files: FileRecord[], total: number, page: number, filters: Filters): string {
  const totalPages = Math.ceil(total / 50);

  const rows = files
    .map((f) => {
      const expired = new Date(f.expire_at).getTime() < Date.now();
      return `<div class="file-list-item ${expired ? 'expired' : ''}">
        <span class="fname">${escapeHtml(f.filename)}</span>
        <span class="fmeta">${escapeHtml(f.code)}</span>
        <span class="fmeta">${formatFileSize(f.size)}</span>
        <span class="fmeta">${f.download_count}次</span>
        <span class="fmeta">${f.expire_at.slice(0, 10)}</span>
        <form method="post" action="/admin/delete/${f.id}" class="inline-form" onsubmit="return confirm('确认删除？')">
          <button type="submit" class="btn-danger">删除</button>
        </form>
      </div>`;
    })
    .join('');

  // 分页链接保留当前筛选状态
  const pageUrl = (p: number) => {
    const qs = new URLSearchParams({ page: String(p) });
    if (filters.keyword) qs.set('keyword', filters.keyword);
    if (filters.dateFrom) qs.set('date_from', filters.dateFrom);
    if (filters.dateTo) qs.set('date_to', filters.dateTo);
    if (filters.sort !== 'newest') qs.set('sort', filters.sort);
    return `/admin?${qs}`;
  };

  const sortOptions = Object.entries(SORT_LABELS)
    .map(([k, v]) => `<option value="${k}"${k === filters.sort ? ' selected' : ''}>${v}</option>`)
    .join('');

  const content = `
    <div class="header">
      <div>
        <h1>管理面板</h1>
        <p>共 ${total} 个文件</p>
      </div>
      <div class="header-actions">
        <a href="/">首页</a>
        <a href="/admin/logout">退出</a>
      </div>
    </div>

    <form method="get" action="/admin" class="filter-bar">
      <div class="input-group filter-field grow">
        <label>关键词</label>
        <input type="text" name="keyword" class="input" value="${escapeHtml(filters.keyword)}" placeholder="文件名搜索">
      </div>
      <div class="input-group filter-field">
        <label>起始日期</label>
        <input type="date" name="date_from" class="input" value="${escapeHtml(filters.dateFrom)}" min="2020-01-01">
      </div>
      <div class="input-group filter-field">
        <label>截止日期</label>
        <input type="date" name="date_to" class="input" value="${escapeHtml(filters.dateTo)}" min="2020-01-01">
      </div>
      <div class="input-group filter-field">
        <label>排序</label>
        <select name="sort" class="input">${sortOptions}</select>
      </div>
      <button type="submit" class="btn btn-primary btn-filter">筛选</button>
      ${filters.keyword || filters.dateFrom || filters.dateTo || filters.sort !== 'newest'
        ? '<a href="/admin" class="btn btn-secondary btn-filter">重置</a>'
        : ''}
    </form>

    <div class="cleanup-bar">
      <form method="post" action="/admin/cleanup" class="cleanup-form" onsubmit="return confirm('确认清理所有过期文件？')">
        <button type="submit" class="btn btn-secondary btn-sm">清理过期文件</button>
      </form>
    </div>

    <div>${rows || '<div class="empty-hint">暂无文件</div>'}</div>
    ${totalPages > 1 ? `<div class="pagination-hint">第 ${page}/${totalPages} 页 &middot; 共 ${total} 个文件</div>` : ''}
    <div class="pagination">
      ${page > 1 ? `<a href="${pageUrl(page - 1)}" class="page-link">&larr; 上一页</a>` : ''}
      ${page < totalPages ? `<a href="${pageUrl(page + 1)}" class="page-link">下一页 &rarr;</a>` : ''}
    </div>`;
  return layout('管理面板', content, true, true);
}

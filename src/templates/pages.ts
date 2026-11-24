import type { FileRecord } from '../types';
import { CHUNK_SIZE, MAX_TEXT_BYTES, escapeHtml, formatFileSize } from '../utils';
import { layout } from './layout';

/** layout 不再包卡片，页面自行决定卡片数量（首页两张，其余一张） */
const card = (inner: string) => `<div class="card">${inner}</div>`;

// ===================== 片段 =====================

/** 页头三件套。发件带 ?send=1 让首页把焦点放到发件区，取件就是回主页 */
function pageNav(): string {
  return `<a href="/?send=1">发件</a>
        <a href="/">取件</a>
        <a href="/admin">管理</a>`;
}

function pageHeader(title: string, subtitle?: string, actions = pageNav()): string {
  return `<div class="header">
      <div>
        <h1>${escapeHtml(title)}</h1>${subtitle ? `\n        <p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      <div class="header-actions">${actions}</div>
    </div>`;
}

/** 悬浮提示：纯 CSS + tabindex，无需 JS，也不受 CSP 影响 */
function tip(text: string): string {
  return `<span class="tip" tabindex="0" role="note" aria-label="${escapeHtml(text)}">?<span class="tip-bubble" role="tooltip">${escapeHtml(text)}</span></span>`;
}

/** 有效期选择器：后端 resolveExpire 支持 day/hour/minute/count/forever */
function expireControl(o: {
  valueId: string;
  styleId: string;
  /** 文本表单走原生 POST，需要 name；文件表单由 JS 读值，留空 */
  names?: { value: string; style: string };
  days: number;
}): string {
  const valueName = o.names ? ` name="${o.names.value}"` : '';
  const styleName = o.names ? ` name="${o.names.style}"` : '';
  return `
            <div class="expire-control" data-style="day">
              <input type="number" id="${o.valueId}"${valueName} class="input expire-value" min="1" value="${o.days}" aria-label="有效期数值">
              <select id="${o.styleId}"${styleName} class="input expire-unit" aria-label="有效期单位">
                <option value="day">天</option>
                <option value="hour">小时</option>
                <option value="minute">分钟</option>
                <option value="count">次后失效</option>
                <option value="forever">永久</option>
              </select>
              <div class="stepper">
                <button type="button" data-step="1" tabindex="-1" aria-label="增加">▲</button>
                <button type="button" data-step="-1" tabindex="-1" aria-label="减少">▼</button>
              </div>
            </div>`;
}

/**
 * 四格分离输入。真实表单字段是末尾那个隐藏 input（name 可选），
 * 四格只负责输入体验，值由 codeGroupsScript() 同步进去。
 */
function codeBoxes(o: {
  groupId: string;
  hiddenId: string;
  name?: string;
  autofocus?: boolean;
  /** 填满四位后自动提交所在表单（只给取件组用，发件表单不能自动提交） */
  autosubmit?: boolean;
  ariaPrefix?: string;
}): string {
  const aria = o.ariaPrefix || '取件码';
  const nameAttr = o.name ? ` name="${o.name}"` : '';
  const boxes = [1, 2, 3, 4]
    .map(
      (n) =>
        `        <input class="code-box" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off"${
          o.autofocus && n === 1 ? ' autofocus' : ''
        } aria-label="${aria}第 ${n} 位">`,
    )
    .join('\n');
  return `
      <div class="code-boxes" id="${o.groupId}" data-code-target="${o.hiddenId}"${o.autosubmit ? ' data-autosubmit' : ''}>
${boxes}
      </div>
      <input type="hidden"${nameAttr} id="${o.hiddenId}">`;
}

/**
 * 四格取件码通用逻辑：自动前进、退格回退、方向键、覆盖输入、粘贴分发，
 * 并把合并值同步进各自的隐藏字段（页面里可能有多组：取件 / 文件 / 文本）。
 */
function codeGroupsScript(): string {
  return `
    <script>
    function codeGroupBoxes(group) {
      return Array.prototype.slice.call(group.querySelectorAll('.code-box'));
    }

    function syncCodeGroup(group) {
      var boxes = codeGroupBoxes(group);
      var hidden = document.getElementById(group.getAttribute('data-code-target'));
      if (!hidden) return;
      hidden.value = boxes.map(function (b) { return b.value; }).join('');
      boxes.forEach(function (b) { b.classList.toggle('filled', !!b.value); });
      autoSubmitPickup(group, hidden.value);
    }

    // 四位填满即取件；只认带 data-autosubmit 的那组，发件表单的自定义码不会误触发
    function autoSubmitPickup(group, value) {
      if (!group.hasAttribute('data-autosubmit') || !/^\\d{4}$/.test(value)) return;
      var form = group.closest('form');
      if (!form || form.dataset.submitting === '1') return;
      form.dataset.submitting = '1';
      group.classList.add('is-complete');
      setTimeout(function () {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }, 220);
    }

    function initCodeGroups() {
      document.querySelectorAll('.code-boxes[data-code-target]').forEach(function (group) {
        var boxes = codeGroupBoxes(group);
        boxes.forEach(function (b, i) {
          b.addEventListener('input', function () {
            b.value = (b.value || '').replace(/\\D/g, '').slice(-1);
            if (b.value && i < boxes.length - 1) boxes[i + 1].focus();
            syncCodeGroup(group);
          });
          b.addEventListener('keydown', function (e) {
            // maxlength=1 会让浏览器直接拒绝在已填格中再输入字符（必须先删），
            // 这里拦下数字键做「覆盖输入」
            if (/^[0-9]$/.test(e.key) && b.value) {
              e.preventDefault();
              b.value = e.key;
              if (i < boxes.length - 1) boxes[i + 1].focus();
              syncCodeGroup(group);
              return;
            }
            if (e.key === 'Backspace' && !b.value && i > 0) {
              e.preventDefault();
              boxes[i - 1].value = '';
              boxes[i - 1].focus();
              syncCodeGroup(group);
            } else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
            else if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
          });
          b.addEventListener('paste', function (e) {
            var text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\\D/g, '').slice(0, 4);
            if (!text) return;
            e.preventDefault();
            text.split('').forEach(function (ch, j) { if (boxes[j]) boxes[j].value = ch; });
            boxes[Math.min(text.length, boxes.length - 1)].focus();
            syncCodeGroup(group);
          });
        });
      });
    }

    function submitPickup(e) {
      var hidden = document.getElementById('pickupCode');
      if (!hidden || !/^\\d{4}$/.test(hidden.value)) {
        e.preventDefault();
        var boxes = document.querySelectorAll('#pickupBoxes .code-box');
        for (var i = 0; i < boxes.length; i++) {
          if (!boxes[i].value) { boxes[i].focus(); break; }
        }
        return false;
      }
      return true;
    }

    document.addEventListener('DOMContentLoaded', initCodeGroups);
    </script>`;
}

// ===================== 首页 =====================

export interface HomeOptions {
  /** 超过它就转分片上传（min(配置上限, 平台单请求上限)） */
  chunkThreshold: number;
  /** 当前生效的单文件上限，前端据此拦截超限文件 */
  maxFileSize: number;
  defaultExpireDays: number;
  /** 开启人机校验时渲染 widget 的站点键；空串表示关闭 */
  turnstileSiteKey?: string;
}

export function homePage(opts: HomeOptions): string {
  const days = opts.defaultExpireDays > 0 ? opts.defaultExpireDays : 7;
  const maxBytes = opts.maxFileSize > 0 ? opts.maxFileSize : opts.chunkThreshold;

  // ① 标题 + 管理入口 + 取件
  const pickupCard = `
    ${pageHeader('FileCodeBox', '像取快递一样取文件', '<a href="/admin">管理</a>')}
    <form action="/r" method="get" class="pickup-form" onsubmit="return submitPickup(event)">
${codeBoxes({ groupId: 'pickupBoxes', hiddenId: 'pickupCode', name: 'code', autofocus: true, autosubmit: true })}
      <button type="submit" class="btn btn-warm btn-auto">取件</button>
    </form>`;

  // ② 发件
  const sendCard = `
    <div class="tabs">
      <button class="tab active" data-tab="file" onclick="switchTab('file')">文件</button>
      <button class="tab" data-tab="text" onclick="switchTab('text')">文本</button>
    </div>

    <div id="tab-file" class="tab-panel active">
      <form id="uploadForm" onsubmit="return handleUpload(event)">
        <div class="input-group">
          <div class="dz" id="dropZone" tabindex="0" role="button" aria-label="点击或拖拽文件上传" data-max-bytes="${maxBytes}">
            <span class="dz-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5"/><path d="m7 10 5-5 5 5"/><path d="M5 19h14"/></svg></span>
            <span class="dz-title">点击选择，或拖拽文件到此处</span>
            <span class="dz-hint">支持直接粘贴 · 单个文件上限 ${escapeHtml(formatFileSize(maxBytes))}</span>
            <input type="file" name="file" id="fileInput" class="dz-input" multiple>
          </div>
          <div class="file-chips" id="fileList"></div>
          <p class="upload-notice" id="uploadNotice" role="alert" hidden></p>
        </div>
        <details class="extra">
          <summary>额外发件设置</summary>
          <div class="extra-body">
            <div class="field-row">
              <div class="input-group">
                <label>有效期 ${tip('有效期后文件将被销毁')}</label>
${expireControl({ valueId: 'fileExpireValue', styleId: 'fileExpireStyle', days })}
              </div>
              <div class="input-group">
                <label>最大下载次数 ${tip('设置为 -1 则不限制次数')}</label>
                <input type="number" id="fileMaxDownloads" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限">
              </div>
            </div>
            <div class="input-group">
              <label>自定义取件码 <span class="hint">（可选，留空自动生成）</span></label>
${codeBoxes({ groupId: 'fileCodeBoxes', hiddenId: 'fileCode', name: 'code' })}
            </div>
          </div>
        </details>
        <div class="upload-progress" id="uploadProgress"><div class="upload-progress-bar" id="uploadProgressBar"></div></div>
        <div class="upload-status" id="uploadStatus"></div>
        <div class="progress-meta" id="uploadMeta" hidden></div>
        ${opts.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(opts.turnstileSiteKey)}" data-size="flexible"></div>` : ''}
        <button type="submit" id="submitBtn" class="btn btn-primary">发件并获取取件码</button>
      </form>
    </div>

    <div id="tab-text" class="tab-panel">
      <form action="/api/upload/text" method="post" onsubmit="return prepareTextSubmit(event)">
        <input type="hidden" name="cf-turnstile-response" id="textTurnstileToken">
        <div class="input-group">
          <textarea name="text" id="textInput" class="input" placeholder="粘贴或输入要分享的文本内容…" required oninput="updateTextBytes(this)"></textarea>
          <div class="progress-meta"><span id="textBytes">0 B</span><span>上限 512 KB</span></div>
        </div>
        <details class="extra">
          <summary>额外发件设置</summary>
          <div class="extra-body">
            <div class="field-row">
              <div class="input-group">
                <label>有效期 ${tip('有效期后内容将被销毁')}</label>
${expireControl({ valueId: 'textExpireValue', styleId: 'textExpireStyle', names: { value: 'expire_value', style: 'expire_style' }, days })}
              </div>
              <div class="input-group">
                <label>最大查看次数 ${tip('设置为 -1 则不限制次数')}</label>
                <input type="number" id="textMaxDownloads" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限">
              </div>
            </div>
            <div class="input-group">
              <label>自定义取件码 <span class="hint">（可选，留空自动生成）</span></label>
${codeBoxes({ groupId: 'textCodeBoxes', hiddenId: 'textCode', name: 'code' })}
            </div>
          </div>
        </details>
        <button type="submit" id="textSubmitBtn" class="btn btn-primary">发件并获取取件码</button>
      </form>
    </div>

    <script>
    var CHUNK_THRESHOLD = ${opts.chunkThreshold};
    var CHUNK_SIZE = ${CHUNK_SIZE};
    var MAX_TEXT_BYTES = ${MAX_TEXT_BYTES};
    var pendingFiles = [];

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(function (t) {
        t.classList.toggle('active', t.getAttribute('data-tab') === name);
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      var panel = document.getElementById('tab-' + name);
      if (panel) panel.classList.add('active');
    }

    function fmtBytes(n) {
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
      return Math.round(n) + ' B';
    }

    // ---- 文件选择：点击 / 拖拽 / 粘贴 ----
    // 上限由服务端写进 dropzone 的 data-max-bytes，前端写死数字会在后台改设置后失真
    function maxBytes() {
      var dz = document.getElementById('dropZone');
      var n = dz ? parseInt(dz.getAttribute('data-max-bytes'), 10) : 0;
      return Number.isFinite(n) && n > 0 ? n : Infinity;
    }

    function notice(msg) {
      var el = document.getElementById('uploadNotice');
      if (!el) return;
      el.textContent = msg || '';
      el.hidden = !msg;
    }

    function overLimit() {
      return pendingFiles.some(function (f) { return f.size > maxBytes(); });
    }

    // 超限文件允许留在列表里（否则用户不知道被丢了哪个），但标红并在提交时拦下
    function reportOverLimit() {
      if (!overLimit()) { notice(''); return false; }
      notice('文件超过 ' + fmtBytes(maxBytes()) + ' 上限，点击发件不会开始上传');
      return true;
    }

    function setFiles(list) {
      pendingFiles = Array.prototype.slice.call(list || []);
      renderChips();
      reportOverLimit();
    }

    function renderChips() {
      var box = document.getElementById('fileList');
      if (!box) return;
      box.textContent = '';
      pendingFiles.forEach(function (file, idx) {
        var over = file.size > maxBytes();
        var chip = document.createElement('div');
        chip.className = over ? 'file-chip chip-over' : 'file-chip';
        var name = document.createElement('span');
        name.className = 'chip-name';
        name.textContent = file.name;
        var size = document.createElement('span');
        size.className = 'chip-size';
        size.textContent = over ? fmtBytes(file.size) + ' · 超上限' : fmtBytes(file.size);
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'chip-remove';
        rm.setAttribute('aria-label', '移除 ' + file.name);
        rm.textContent = '×';
        rm.onclick = function () {
          pendingFiles.splice(idx, 1);
          renderChips();
          reportOverLimit();
        };
        chip.appendChild(name); chip.appendChild(size); chip.appendChild(rm);
        box.appendChild(chip);
      });
    }

    function initDropZone() {
      var dz = document.getElementById('dropZone');
      var input = document.getElementById('fileInput');
      if (!dz || !input) return;
      dz.addEventListener('click', function (e) { if (e.target !== input) input.click(); });
      dz.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.setAttribute('data-dragging', 'true'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.removeAttribute('data-dragging'); });
      });
      dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files.length) setFiles(e.dataTransfer.files);
      });
      input.addEventListener('change', function () {
        if (input.files.length) setFiles(input.files);
        input.value = '';
      });
      // 关闭浏览器把拖入的图片直接导航走
      ['dragover', 'drop'].forEach(function (ev) {
        window.addEventListener(ev, function (e) { e.preventDefault(); });
      });
      window.addEventListener('paste', function (e) {
        var files = e.clipboardData && e.clipboardData.files;
        if (files && files.length) { e.preventDefault(); setFiles(files); }
      });
    }

    // ---- 有效期选择器 ----
    function bindExpire(valueId, styleId, maxId) {
      var value = document.getElementById(valueId);
      var style = document.getElementById(styleId);
      var max = maxId ? document.getElementById(maxId) : null;
      if (!style || !value) return;
      var control = style.closest('.expire-control');

      function sync() {
        var m = style.value;
        if (control) control.setAttribute('data-style', m);
        value.disabled = (m === 'forever');
        value.required = (m !== 'forever');
        // 按次数失效时，最大下载次数由有效期数值决定，避免两个字段互相矛盾
        if (max) {
          if (m === 'count') { max.value = value.value; max.disabled = true; }
          else { max.disabled = false; if (max.value === '') max.value = '-1'; }
        }
      }
      style.addEventListener('change', sync);
      value.addEventListener('input', function () {
        if (max && style.value === 'count') max.value = value.value;
      });
      if (control) {
        control.querySelectorAll('.stepper button').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var step = parseInt(btn.getAttribute('data-step'), 10);
            var n = parseInt(value.value, 10);
            if (!Number.isFinite(n)) n = 1;
            value.value = String(Math.max(1, n + step));
            value.dispatchEvent(new Event('input', { bubbles: true }));
          });
        });
      }
      sync();
    }

    // ---- 上传参数（普通上传走 query，分片上传走 init 的 JSON body） ----
    function uploadParams() {
      var style = document.getElementById('fileExpireStyle');
      var value = document.getElementById('fileExpireValue');
      var max = document.getElementById('fileMaxDownloads');
      return {
        expire_style: style ? style.value : 'day',
        expire_value: value && value.value ? value.value : '7',
        max_downloads: max && max.value ? max.value : '-1'
      };
    }

    function queryOf(p) {
      return Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
    }

    function fetchJson(url, init) {
      return fetch(url, init).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (r.ok && j) return j;
          throw new Error((j && (j.error || j.msg)) || ('请求失败（HTTP ' + r.status + '）'));
        });
      });
    }

    function turnstileToken() {
      return (window.turnstile && window.turnstile.getResponse && window.turnstile.getResponse()) || '';
    }

    function uploadOne(file, params, code, onProgress, reserved) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload?' + queryOf(params) + '&code=' + encodeURIComponent(code || '') + (reserved ? '&reserved=1' : ''));
        xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        var token = turnstileToken();
        if (token) xhr.setRequestHeader('X-Turnstile-Token', token);
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded, e.total); };
        xhr.onload = function () {
          var data = null;
          try { data = JSON.parse(xhr.responseText); } catch (err) { data = null; }
          if (xhr.status >= 200 && xhr.status < 300 && data && data.code) resolve(data);
          else reject(new Error((data && data.error) || ('上传失败（HTTP ' + xhr.status + '）')));
        };
        xhr.onerror = function () { reject(new Error('网络错误')); };
        xhr.send(file);
      });
    }

    // ---- 分片上传（大文件） ----
    // 超过阈值的文件切开逐片 PUT（分片序号 0 基），服务端把它们流进同一个 R2 multipart
    // 会话，complete 时合成一个对象 —— 仍然只有一个取件码
    function putPart(s, file, n, attempt, onLoaded) {
      var start = n * s.chunk_size;
      var blob = file.slice(start, Math.min(start + s.chunk_size, file.size));
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/upload/chunk/' + s.upload_id + '/' + n);
        var token = turnstileToken();
        if (token) xhr.setRequestHeader('X-Turnstile-Token', token);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onLoaded(n, e.loaded); };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) { onLoaded(n, blob.size); resolve(); return; }
          var msg = '';
          try { msg = JSON.parse(xhr.responseText).error; } catch (err) { msg = ''; }
          reject(new Error(msg || ('分片 ' + (n + 1) + ' 上传失败（HTTP ' + xhr.status + '）')));
        };
        xhr.onerror = function () { reject(new Error('分片 ' + (n + 1) + ' 网络错误')); };
        xhr.send(blob);
      }).catch(function (e) {
        // 弱网下只重传这一片，不用整个文件重来
        if (attempt < 2) return putPart(s, file, n, attempt + 1, onLoaded);
        throw e;
      });
    }

    // 3 路并发，进度是所有在飞片的字节之和（否则会来回跳）
    function runPartPool(s, file, todo, base, onProgress) {
      var queue = todo.slice();
      var live = {};
      var finished = 0;
      var bail = null;
      function partSize(n) {
        var start = n * s.chunk_size;
        return Math.min(start + s.chunk_size, file.size) - start;
      }
      function report() {
        var bytes = base;
        for (var k in live) bytes += live[k];
        onProgress(bytes, file.size, '分片 ' + finished + '/' + s.total_chunks);
      }
      function onLoaded(n, bytes) {
        if (live[n] === bytes) return;
        live[n] = bytes;
        report();
      }
      function worker() {
        // 一片彻底失败后不再取新片：继续传只是白耗上行带宽
        if (bail || !queue.length) return Promise.resolve();
        var n = queue.shift();
        return putPart(s, file, n, 0, onLoaded).then(function () {
          live[n] = partSize(n);
          finished += 1;
          report();
          return worker();
        }, function (e) {
          if (!bail) bail = e;
        });
      }
      report();
      var workers = [];
      var lanes = Math.min(3, queue.length);
      for (var i = 0; i < lanes; i++) workers.push(worker());
      return Promise.all(workers).then(function () { if (bail) throw bail; });
    }

    // 正在飞的会话，页面被关掉时用 keepalive 兜底 abort
    var liveChunks = {};
    function abortLiveChunks() {
      Object.keys(liveChunks).forEach(function (id) {
        fetch('/api/upload/chunk/abort/' + encodeURIComponent(id), { method: 'POST', keepalive: true }).catch(function () {});
      });
    }
    window.addEventListener('pagehide', abortLiveChunks);

    function chunkUpload(file, params, code, onProgress, reserved) {
      var handle = '';
      return fetchJson('/api/upload/chunk/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          total_chunks: Math.ceil(file.size / CHUNK_SIZE),
          mime_type: file.type || 'application/octet-stream',
          code: code || '',
          reserved: Boolean(reserved),
          expire_style: params.expire_style,
          expire_value: params.expire_value,
          max_downloads: params.max_downloads
        })
      }).then(function (s) {
        handle = s.upload_id;
        if (!handle) throw new Error('初始化失败');
        liveChunks[handle] = true;
        var indexes = [];
        for (var n = 0; n < s.total_chunks; n++) indexes.push(n);
        // 先问服务端已经收到哪些片，续传时不白传
        return fetchJson('/api/upload/chunk/status/' + encodeURIComponent(handle))
          .catch(function () { return null; })
          .then(function (st) {
            var got = {};
            ((st && st.received) || []).forEach(function (n) { got[n] = true; });
            var todo = indexes.filter(function (n) { return !got[n]; });
            var base = 0;
            Object.keys(got).forEach(function (k) {
              var start = Number(k) * s.chunk_size;
              base += Math.min(start + s.chunk_size, file.size) - start;
            });
            return runPartPool(s, file, todo, base, onProgress);
          })
          .then(function () {
            return fetchJson('/api/upload/chunk/complete/' + encodeURIComponent(handle), { method: 'POST' })
              .then(function (r) { delete liveChunks[handle]; return r; });
          });
      }).catch(function (e) {
        // 传败了要自己 abort：未完成的分片不是对象，后台「清理过期文件」也扫不到，
        // 留着就一直占存储
        if (!handle) throw e;
        delete liveChunks[handle];
        return fetchJson('/api/upload/chunk/abort/' + encodeURIComponent(handle), { method: 'POST' })
          .catch(function () {})
          .then(function () { throw e; });
      });
    }

    // 图片在浏览器端生成缩略图（≤128KB webp），失败不影响主上传
    function uploadThumb(file, code) {
      if (!/^image\\//.test(file.type || '')) return Promise.resolve();
      return new Promise(function (resolve) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          var maxEdge = 1024;
          var scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          canvas.toBlob(function (blob) {
            if (!blob || blob.size > 128 * 1024) return resolve();
            fetch('/api/thumb/' + encodeURIComponent(code), { method: 'POST', body: blob })
              .catch(function () {})
              .then(resolve);
          }, 'image/webp', 0.82);
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(); };
        img.src = url;
      });
    }

    function sendOne(file, params, code, onProgress, reserved) {
      if (file.size > CHUNK_THRESHOLD) return chunkUpload(file, params, code, onProgress, reserved);
      return uploadOne(file, params, code, onProgress, reserved);
    }

    function handleUpload(e) {
      e.preventDefault();
      if (!pendingFiles.length) { notice('请先选择文件'); return false; }
      if (reportOverLimit()) return false;
      notice('');

      var btn = document.getElementById('submitBtn');
      var wrap = document.getElementById('uploadProgress');
      var bar = document.getElementById('uploadProgressBar');
      var status = document.getElementById('uploadStatus');
      var meta = document.getElementById('uploadMeta');
      var hiddenCode = document.getElementById('fileCode');
      var custom = hiddenCode ? hiddenCode.value.trim() : '';
      var files = pendingFiles.slice();
      var params = uploadParams();

      btn.disabled = true;
      btn.textContent = '上传中…';
      wrap.style.display = 'block';
      meta.hidden = false;

      var token = turnstileToken();
      var codesPromise;
      if (files.length > 1) {
        if (custom) notice('多文件上传时忽略自定义取件码');
        codesPromise = fetchJson('/api/codes/' + files.length)
          .then(function (r) { return r.codes; })
          .catch(function () { return files.map(function () { return ''; }); });
      } else {
        codesPromise = Promise.resolve([custom]);
      }

      codesPromise
        .then(function (codes) {
          var results = [];
          var chain = Promise.resolve();
          files.forEach(function (file, idx) {
            chain = chain.then(function () {
              btn.textContent = '上传中 ' + (idx + 1) + '/' + files.length + '…';
              return sendOne(file, params, codes[idx] || '', function (loaded, total, extra) {
                var pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
                bar.style.width = pct + '%';
                status.style.display = 'block';
                status.textContent = '第 ' + (idx + 1) + '/' + files.length + ' 个：' + pct + '%' + (extra ? ' · ' + extra : '');
                meta.textContent = fmtBytes(loaded) + ' / ' + fmtBytes(total);
              }, files.length > 1).then(function (data) {
                results.push(data);
                return uploadThumb(file, data.code);
              });
            });
          });
          return chain.then(function () { return results; });
        })
        .then(function (results) {
          if (results.length === 1) {
            status.textContent = '上传完成，跳转中…';
            window.location.href = '/r/' + results[0].code;
            return;
          }
          bar.style.width = '100%';
          status.textContent = '全部完成：' + results.length + ' 个文件';
          meta.hidden = true;
          var box = document.getElementById('fileList');
          box.textContent = '';
          results.forEach(function (r) {
            var a = document.createElement('a');
            a.className = 'batch-link';
            a.href = '/r/' + r.code;
            a.textContent = r.code + ' · ' + r.filename;
            box.appendChild(a);
          });
          btn.disabled = false;
          btn.textContent = '发件并获取取件码';
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = '发件并获取取件码';
          wrap.style.display = 'none';
          meta.hidden = true;
          status.textContent = '上传中断';
          notice((err && err.message) || '上传失败');
        });
      return false;
    }

    // ---- 文本分享 ----
    function updateTextBytes(el) {
      var out = document.getElementById('textBytes');
      if (out) out.textContent = fmtBytes(new TextEncoder().encode(el.value).length);
    }

    function prepareTextSubmit(e) {
      var el = document.getElementById('textTurnstileToken');
      if (el) el.value = turnstileToken();
      var el = document.getElementById('textInput');
      var bytes = el ? new TextEncoder().encode(el.value).length : 0;
      if (bytes > MAX_TEXT_BYTES) {
        e.preventDefault();
        alert('文本过长，最大支持 512KB（当前 ' + fmtBytes(bytes) + '）');
        return false;
      }
      var b = document.getElementById('textSubmitBtn');
      if (b) { b.disabled = true; b.textContent = '保存中…'; }
      return true;
    }

    // 浏览器后退会从 bfcache 恢复表单页：按钮/进度条可能还停在「上传中」，必须一起还原
    window.addEventListener('pageshow', function () {
      var b = document.getElementById('textSubmitBtn');
      if (b) { b.disabled = false; b.textContent = '发件并获取取件码'; }
      var ub = document.getElementById('submitBtn');
      if (ub) { ub.disabled = false; ub.textContent = '发件并获取取件码'; }
      var wrap = document.getElementById('uploadProgress');
      if (wrap) wrap.style.display = 'none';
      var bar = document.getElementById('uploadProgressBar');
      if (bar) bar.style.width = '0%';
      var meta = document.getElementById('uploadMeta');
      if (meta) meta.hidden = true;
      var status = document.getElementById('uploadStatus');
      if (status) status.textContent = '';
    });

    document.addEventListener('DOMContentLoaded', function () {
      initDropZone();
      bindExpire('fileExpireValue', 'fileExpireStyle', 'fileMaxDownloads');
      bindExpire('textExpireValue', 'textExpireStyle', 'textMaxDownloads');
      // 页头「发件」带 ?send=1 回主页：默认焦点在取件框上，这里把视线挪到发件区
      if (/[?&]send=1/.test(location.search)) {
        var dz = document.getElementById('dropZone');
        if (dz) { dz.scrollIntoView({ block: 'center' }); dz.focus(); }
      }
    });
    </script>
${codeGroupsScript()}`;

  return layout('FileCodeBox', card(pickupCard) + card(sendCard));
}

// ===================== 取件页 =====================

/**
 * 取件页：查无此码 / 码为空时的落地页。
 * 不回填失败的码 —— 四格留空并提示重新输入，语义与提示文案一致。
 */
export function retrievePage(code?: string): string {
  const content = `
    ${pageHeader('取件', '输入取件码下载文件')}
    ${code ? `<div class="code-empty-tip">取件码 ${escapeHtml(code)} 不存在或已过期，请重新输入</div>` : ''}
    <form action="/r" method="get" class="pickup-form pickup-form--stack" onsubmit="return submitPickup(event)">
${codeBoxes({ groupId: 'pickupBoxes', hiddenId: 'pickupCode', name: 'code', autofocus: true, autosubmit: true })}
      <button type="submit" class="btn btn-primary btn-auto">取件</button>
    </form>
    ${codeGroupsScript()}`;
  return layout('取件', card(content));
}

// ===================== 文件 / 文本取件页 =====================

/** 元信息行：大小 / 下载次数 / 过期时间 */
function fileMeta(file: FileRecord): string {
  const expireDate = new Date(file.expireAt);
  const expireStr =
    expireDate.getTime() - Date.now() > 365 * 86400000
      ? '永久有效'
      : `过期: ${expireDate.toLocaleDateString('zh-CN')}`;
  const dlInfo =
    file.maxDownloads < 0
      ? `已下载 ${file.downloadCount} 次`
      : `已下载 ${file.downloadCount}/${file.maxDownloads} 次`;
  return `<div class="meta-row">
            <span>${formatFileSize(file.size)}</span>
            <span>${dlInfo}</span>
            <span>${expireStr}</span>
          </div>`;
}

function fileIconSvg(): string {
  return `<div class="file-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
          </div>`;
}

/** 分享右栏：取件码卡 + 二维码 */
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

function shareGrid(left: string, code: string, shareUrl: string): string {
  return `<div class="share-grid"><div class="share-left">${left}</div>${shareRightPanel(code, shareUrl)}</div>`;
}

export function filePage(file: FileRecord, baseUrl: string): string {
  const shareUrl = `${baseUrl}/r/${file.code}`;

  // 文本分享：内容由客户端拉取（含查看计数与超时处理）
  if (file.isText) {
    const left = `
        ${pageHeader('取件')}
        <div class="share-title">${escapeHtml(file.filename)}</div>
        <div class="command-box">
          <div class="command-text" id="textContent">加载中…</div>
          <button class="btn-copy-cmd" id="copyAllBtn" hidden onclick="copyAllText(this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>复制全文</span>
          </button>
        </div>
        ${fileMeta(file)}
        <script>
        function copyAllText(el) {
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
          function fail(msg) {
            clearTimeout(timer);
            el.textContent = msg;
            el.style.color = 'var(--color-danger)';
          }
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
    return layout('取件', card(shareGrid(left, file.code, shareUrl)), true, true);
  }

  const left = `
        ${pageHeader('取件')}
        <div class="share-title">${escapeHtml(file.filename)}</div>
        <div class="command-box" style="align-items:center;justify-content:center">
          ${file.hasThumb ? `<img class="thumb" src="/api/thumb/${file.code}" alt="预览" loading="lazy">` : fileIconSvg()}
          <a href="/api/download/${file.code}" class="btn btn-primary btn-auto">下载文件</a>
        </div>
        ${fileMeta(file)}`;
  return layout('取件', card(shareGrid(left, file.code, shareUrl)), true, true);
}

// ===================== 错误页 / 登录页 =====================

export function errorPage(title: string, message: string): string {
  // 两处都会回显到 HTML：message 可能来自后端异常文本，必须转义
  const content = `
    <div class="header"><h1>${escapeHtml(title)}</h1></div>
    <p style="text-align:center">${escapeHtml(message)}</p>
    <a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>`;
  return layout(escapeHtml(title), card(content));
}

export function adminLoginPage(error?: string): string {
  const content = `
    ${pageHeader('管理员登录', 'FileCodeBox 后台管理', '<a href="/">首页</a>')}
    ${error ? `<div style="color:var(--color-danger);text-align:center;margin-bottom:16px;font-size:14px">${escapeHtml(error)}</div>` : ''}
    <form action="/admin/login" method="post">
      <div class="input-group"><label>密码</label><input type="password" name="password" class="input" placeholder="输入管理员密码" required autofocus></div>
      <button type="submit" class="btn btn-primary">登录</button>
    </form>`;
  return layout('管理员登录', card(content));
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

export function adminPanel(
  files: FileRecord[],
  total: number,
  page: number,
  filters: Filters,
  storage?: { used: number; limit: number },
): string {
  const totalPages = Math.ceil(total / 50);

  const rows = files
    .map((f) => {
      const expired = new Date(f.expireAt).getTime() < Date.now();
      return `<div class="file-list-item ${expired ? 'expired' : ''}">
        <span class="tag">${f.isText ? '文本' : '文件'}</span>
        <a class="fname" href="/r/${escapeHtml(f.code)}" title="打开取件页">${escapeHtml(f.filename)}</a>
        <span class="fmeta">${escapeHtml(f.code)}</span>
        <span class="fmeta">${formatFileSize(f.size)}</span>
        <span class="fmeta">${f.downloadCount}次</span>
        <span class="fmeta">${f.expireAt.slice(0, 10)}</span>
        <form method="post" action="/admin/delete/${f.id}" style="display:inline;margin-left:6px" onsubmit="return confirm('确认删除？')">
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

  const filtered = filters.keyword || filters.dateFrom || filters.dateTo || filters.sort !== 'newest';

  const content = `
    ${pageHeader(
      '管理面板',
      `共 ${total} 个文件${
        storage
          ? storage.limit > 0
            ? ` · 已用 ${formatFileSize(storage.used)} / 上限 ${formatFileSize(storage.limit)}`
            : ` · 已用 ${formatFileSize(storage.used)}（不限总量）`
          : ''
      }`,
      '<a href="/">首页</a><a href="/admin/settings">设置</a><a href="/admin/logout">退出</a>',
    )}

    <div class="toolbar">
      <form method="get" action="/admin" class="filter-bar">
      <div class="input-group grow">
        <label>关键词</label>
        <input type="text" name="keyword" class="input" value="${escapeHtml(filters.keyword)}" placeholder="文件名搜索">
      </div>
      <div class="input-group">
        <label>起始日期</label>
        <input type="date" name="date_from" class="input" value="${escapeHtml(filters.dateFrom)}" min="2020-01-01">
      </div>
      <div class="input-group">
        <label>截止日期</label>
        <input type="date" name="date_to" class="input" value="${escapeHtml(filters.dateTo)}" min="2020-01-01">
      </div>
      <div class="input-group">
        <label>排序</label>
        <select name="sort" class="input">${sortOptions}</select>
      </div>
      <button type="submit" class="btn btn-primary">筛选</button>
        ${filtered ? '<a href="/admin" class="btn btn-secondary">重置</a>' : ''}
      </form>
      <form method="post" action="/admin/cleanup" class="cleanup-form" onsubmit="return confirm('确认清理所有过期文件？')">
        <button type="submit" class="btn btn-secondary">清理过期文件</button>
      </form>
    </div>

    <div>${rows || '<div class="empty-hint">暂无文件</div>'}</div>
    ${totalPages > 1 ? `<div class="pagination">第 ${page}/${totalPages} 页 &middot; 共 ${total} 个文件</div>` : ''}
    <div class="pagination">
      ${page > 1 ? `<a href="${pageUrl(page - 1)}">&larr; 上一页</a>` : ''}
      ${page < totalPages ? `<a href="${pageUrl(page + 1)}">下一页 &rarr;</a>` : ''}
    </div>`;
  return layout('管理面板', card(content), true, true);
}


// ===================== 系统设置页 =====================

export interface SettingsInput {
  config: {
    maxSize: number;
    defaultExpireDays: number;
    openUpload: boolean;
    maxTotalStorage: number;
    turnstileEnabled: boolean;
  };
  used: number;
  turnstileReady: boolean;
  varsMaxSize: number;
}

export function adminSettingsPage(o: SettingsInput, saved = false): string {
  const mb = (bytes: number) => (bytes > 0 ? String(Math.round((bytes / 1048576) * 100) / 100) : '');
  const content = `
    <div class="header">
      <div>
        <h1>系统设置</h1>
        <p>保存后立即生效，无需重新部署</p>
      </div>
      <div class="header-actions">
        <a href="/">首页</a>
        <a href="/admin">文件</a>
        <a href="/admin/logout">退出</a>
      </div>
    </div>
    ${saved ? '<div class="form-success">已保存</div>' : ''}
    <form method="post" action="/admin/settings">
      <div class="input-group">
        <label>单文件上限（MB）</label>
        <input type="number" name="maxFileSizeMb" class="input" min="0.1" step="0.1" value="${mb(o.config.maxSize)}">
        <div class="hint">清空或非法值将保持当前值；部署变量值为 ${mb(o.varsMaxSize)} MB</div>
      </div>
      <div class="input-group">
        <label>默认有效期（天）</label>
        <input type="number" name="defaultExpireDays" class="input" min="1" max="3650" value="${o.config.defaultExpireDays}">
      </div>
      <div class="input-group">
        <label>全站总占用上限（MB）</label>
        <input type="number" name="maxTotalStorageMb" class="input" min="0" step="0.1" value="${mb(o.config.maxTotalStorage)}" placeholder="0 = 不限制">
        <div class="hint">当前已用 ${formatFileSize(o.used)}；超限时新上传返回 507</div>
      </div>
      <div class="input-group">
        <label class="check-line"><input type="checkbox" name="openUpload" value="1"${o.config.openUpload ? ' checked' : ''}> 允许游客上传</label>
      </div>
      <div class="input-group">
        <label class="check-line"><input type="checkbox" name="turnstileEnabled" value="1"${o.config.turnstileEnabled ? ' checked' : ''}${o.turnstileReady ? '' : ' disabled'}> 上传需要人机校验（Turnstile）</label>
        <div class="hint">${o.turnstileReady ? '已配置站点键与密钥' : '未配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET，暂不可开启'}</div>
      </div>
      <button type="submit" class="btn btn-primary">保存设置</button>
    </form>`;
  return layout('系统设置', card(content), true, true);
}

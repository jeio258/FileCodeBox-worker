/**
 * 首页内联脚本（独立成文件后由 /static/home.js 提供，可被浏览器与 CDN 长缓存）。
 * 运行期配置从 window.__fcb 读取，避免把阈值写死进可缓存的静态资源。
 */

export const HOME_SCRIPT = `
    var CFG = window.__fcb || {};
    var CHUNK_THRESHOLD = CFG.chunkThreshold || 104857600;
    var CHUNK_SIZE = CFG.chunkSize || 31457280;
    var MAX_TEXT_BYTES = CFG.maxTextBytes || 524288;
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
`;

/** 四格取件码逻辑（首页与取件页共用） */
export const CODE_GROUPS_SCRIPT = `

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
  ;
`;

/** 首页脚本 = 上传逻辑 + 四格码逻辑 */
export const HOME_JS = `${HOME_SCRIPT}\n${CODE_GROUPS_SCRIPT}`;

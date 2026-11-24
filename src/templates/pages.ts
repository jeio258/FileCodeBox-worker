import type { FileRecord } from '../types';
import { CHUNK_SIZE, MAX_TEXT_BYTES, escapeHtml, formatFileSize } from '../utils';
import { layout } from './layout';
import { CODE_GROUPS_SCRIPT, HOME_JS } from './home-script';

/** layout 不再包卡片，页面自行决定卡片数量（首页两张，其余一张） */
const card = (inner: string) => `<div class="card">${inner}</div>`;

/** 内容哈希：静态脚本改内容自动换 URL，配合 immutable 缓存 */
function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

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
/** 四格码脚本内联包装（取件页用；首页随 HOME_JS 走外部文件） */
function codeGroupsScript(): string {
  return `<script>${CODE_GROUPS_SCRIPT}</script>`;
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
    window.__fcb = {
      chunkThreshold: ${opts.chunkThreshold},
      chunkSize: ${CHUNK_SIZE},
      maxTextBytes: ${MAX_TEXT_BYTES}
    };
    </script>
    <script src="/static/home.js?v=${hashOf(HOME_JS)}" defer></script>
`;

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
          var LOAD_FAIL = '内容加载失败，请稍后重试。';
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
              if (!r.ok) { fail(LOAD_FAIL); return null; }
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
              else fail(LOAD_FAIL);
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

const ADMIN_TITLE = '管理面板';

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
      ADMIN_TITLE,
      `共 ${total} 个文件${
        storage
          ? storage.limit > 0
            ? ` · 已用 ${formatFileSize(storage.used)} / 上限 ${formatFileSize(storage.limit)}`
            : ` · 已用 ${formatFileSize(storage.used)}（不限总量）`
          : ''
      }`,
      '<a href="/">首页</a><a href="/admin/settings">设置</a><a href="/admin/logout">退出</a>',
    )}

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
      <button type="submit" class="btn btn-secondary cleanup-btn" formaction="/admin/cleanup" formmethod="post"
        onclick="return confirm('确认清理所有过期文件？')">清理过期文件</button>
    </form>

    <div>${rows || '<div class="empty-hint">暂无文件</div>'}</div>
    ${totalPages > 1 ? `<div class="pagination">第 ${page}/${totalPages} 页 &middot; 共 ${total} 个文件</div>` : ''}
    <div class="pagination">
      ${page > 1 ? `<a href="${pageUrl(page - 1)}">&larr; 上一页</a>` : ''}
      ${page < totalPages ? `<a href="${pageUrl(page + 1)}">下一页 &rarr;</a>` : ''}
    </div>`;
  return layout(ADMIN_TITLE, card(content), true, true);
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
}

export function adminSettingsPage(o: SettingsInput, saved = false): string {
  // 表单输入用 MB 数值（保留两位小数），与展示用的 formatFileSize 职责不同，勿合并
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
        <div class="hint">清空或非法值将保持当前值</div>
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

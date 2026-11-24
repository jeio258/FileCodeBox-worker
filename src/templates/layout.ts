import { STYLE } from './style';

/** CSS 内容哈希：改样式自动换 URL，不依赖手工递增 style.css?v=N */
const STYLE_VERSION = (() => {
  let h = 2166136261;
  for (let i = 0; i < STYLE.length; i++) {
    h ^= STYLE.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
})();

/**
 * 通用 HTML 布局包装器：只负责容器宽度与页脚。
 * 卡片由页面自己包（首页是两张，其余页面一张），所以这里不再套 .card。
 * wide=true 时容器放宽到 720px（取件/分享/管理面板双栏布局用）。
 */
export function layout(title: string, content: string, showFooter = true, wide = false): string {
  const footer = showFooter
    ? `<div class="footer">
        <a href="/">FileCodeBox</a> · 安全临时文件分享
        <a href="https://github.com/jeio258/FileCodeBox-worker" target="_blank" rel="noopener" class="github-link">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          GitHub
        </a>
      </div>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="icon" href="https://q1.qlogo.cn/g?b=qq&nk=2847495839&s=640">
  <link rel="preconnect" href="https://t.alcy.cc" crossorigin>
  <link rel="dns-prefetch" href="https://t.alcy.cc">
  <link rel="stylesheet" href="/static/style.css?v=${STYLE_VERSION}">
</head>
<body>
  <div class="container${wide ? ' container-wide' : ''}">
    ${content}
    ${footer}
  </div>
  <script>
  // 首屏完成后（空闲）再加载外部随机图背景：它不参与 FCP/Load 关键路径
  (function () {
    function paint() { document.body.classList.add('bg-ready'); }
    if ('requestIdleCallback' in window) requestIdleCallback(paint, { timeout: 2000 });
    else setTimeout(paint, 600);
  })();
  // 统一复制反馈：取件码卡（.click-hint）与普通按钮/文本两类目标
  function codeCopy(el, t) {
    navigator.clipboard.writeText(t).then(function () {
      var hint = el.querySelector('.click-hint');
      var target = hint || el.querySelector('span') || el;
      var prev = hint ? '点击复制' : target.textContent;
      target.textContent = '已复制';
      setTimeout(function () { target.textContent = prev; }, 1500);
    });
  }
  </script>
</body>
</html>`;
}

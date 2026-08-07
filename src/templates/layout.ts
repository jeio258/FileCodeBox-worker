import { STYLE } from './style';

/**
 * 通用 HTML 布局包装器
 */
export function layout(title: string, content: string, nav = '', showFooter = true): string {
  const footer = showFooter
    ? '<div class="footer"><a href="/">FileCodeBox</a> · 安全临时文件分享</div>'
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600&family=JetBrains+Mono:wght@400;500&family=LXGW+Wenkai&display=swap" rel="stylesheet">
  <style>${STYLE}</style>
</head>
<body>
  <div class="container">
    ${nav}
    <div class="card">${content}</div>
    ${footer}
  </div>
</body>
</html>`;
}

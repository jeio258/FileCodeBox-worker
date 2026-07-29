import { STYLE } from './style';

/**
 * 通用 HTML 布局包装器
 */
export function layout(title: string, content: string, nav = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${STYLE}</style>
</head>
<body>
  <div class="container">
    ${nav}
    <div class="card">${content}</div>
  </div>
</body>
</html>`;
}

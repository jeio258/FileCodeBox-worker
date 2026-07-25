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

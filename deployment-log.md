# FileCodeBox-Worker 部署日志

## 10.12 - 性能优化：移除 Google Fonts

### 优化内容
1. **移除 Google Fonts 外部依赖**
   - 删除 `fonts.googleapis.com` 和 `fonts.gstatic.com` 请求
   - 使用系统字体栈替代
   - 减少 3 个外部 HTTP 请求

2. **更新字体栈定义**
   - 原: `"Inter", "PingFang SC", "Noto Sans SC", "Microsoft YaHei"`
   - 新: `"PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, system-ui, sans-serif"`

3. **CSS 缓存版本更新**
   - `style.css?v=2` → `style.css?v=4`

### 性能提升

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 首字节 | 2128ms | 965ms | **55%** |
| TLS 握手 | 1859ms | 704ms | **62%** |
| 外部请求 | 5 个 | 2 个 | -60% |
| HTML 大小 | 8658 bytes | 8084 bytes | -7% |

### 修改文件
- `src/templates/layout.ts`: 移除 Google Fonts 链接
- `src/templates/style.ts`: 更新字体栈定义

### 保持不变的
- ✅ `style.ts` 样式代码（仅修改字体变量）
- ✅ `pages.ts` 页面模板
- ✅ CSP 策略（移除 fonts.googleapis.com 相关规则）

### 提交记录
- `334bf96`: perf: 移除 Google Fonts 外部依赖，使用系统字体栈
- `95176b7`: perf: 优化数据库查询

### 部署状态
- ✅ 自定义域名: https://filebox.994613.xyz/
- ✅ workers.dev: https://filecodebox.ksu.workers.dev/

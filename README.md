# FileCodeBox Worker

> 像取快递一样取文件 — Cloudflare Workers 重写版

基于 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Cloudflare Workers 移植版，无需服务器，免费部署在 Cloudflare 边缘网络。

## ✨ 功能

- 📤 **上传文件** — 获取 4 位取件码
- 📥 **取件下载** — 输入取件码下载文件
- 🔐 **管理面板** — 查看/删除/清理文件
- ⏰ **自动过期** — 文件到期自动清理
- 🎨 **美观界面** — 紫色渐变现代设计

## 📦 一键部署

### 1. 准备工作

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
- 安装 [Node.js 18+](https://nodejs.org/)

### 2. 安装 Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 3. 创建资源

```bash
# 克隆项目
git clone https://github.com/YOUR_USERNAME/FileCodeBox-worker.git
cd FileCodeBox-worker

# 安装依赖
npm install

# 创建 KV 命名空间（复制返回的 ID）
wrangler kv namespace create FILE_STORE

# 创建 D1 数据库（复制返回的 ID 和名称）
wrangler d1 create filecodebox-db
```

### 4. 配置 wrangler.jsonc

将第 3 步获得的 KV ID 和 D1 ID 填入 `wrangler.jsonc`：

```jsonc
{
  "kv_namespaces": [{
    "binding": "FILE_STORE",
    "id": "你的KV_ID"
  }],
  "d1_databases": [{
    "binding": "DB",
    "database_name": "filecodebox-db",
    "database_id": "你的D1_ID"
  }]
}
```

### 5. 部署

```bash
wrangler deploy
```

### 6. 绑定自定义域名（可选）

在 Cloudflare Dashboard → Workers & Pages → filecodebox → Triggers → Routes：

添加路由：`your-domain.com/*`

## 🧑‍💻 使用

| 页面 | 说明 |
|------|------|
| 首页 `/` | 上传文件 + 输入取件码 |
| 取件 `/r/XXXX` | 文件详情 + 下载 |
| 管理 `/admin` | 管理员登录，默认密码 `admin123` |

## ⚙️ 环境变量

在 `wrangler.jsonc` 的 `vars` 中修改：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMIN_PASSWORD` | `admin123` | 管理员密码 |
| `MAX_FILE_SIZE` | `104857600` | 最大文件大小 (100MB) |
| `DEFAULT_EXPIRE_DAYS` | `7` | 默认过期天数 |

## 📁 项目结构

```
FileCodeBox-worker/
├── src/
│   └── index.ts          # 主程序（Hono + D1 + KV）
├── wrangler.jsonc        # Cloudflare 配置
└── package.json
```

## 🔧 技术栈

- **框架**: Hono
- **数据库**: Cloudflare D1 (SQLite)
- **存储**: Cloudflare KV
- **部署**: Cloudflare Workers

## 📄 许可

MIT License

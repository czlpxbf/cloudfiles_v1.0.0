# ☁️ Cloudfiles — 部署即存储

> 把 Cloudflare Pages 当成私人云盘用。上传一个文件 = 部署一次。完全免费，零服务器。

[![Stack](https://img.shields.io/badge/Stack-Vue%203%2FHono%2FD1%2FKV-blue)](https://cloudfiles-web.pages.dev)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

<p align="center">
  <img src="https://img.shields.io/badge/Deploy_as_Storage-⚡-orange" alt="Deploy as Storage" />
</p>

---

## 🧠 核心理念

传统云盘 = 买存储空间。**Cloudfiles = 文件即部署**。

每次上传一个文件，背后实际上是创建了一个 Cloudflare Pages 部署。文件的每个版本都是一个独立的部署 URL，永久可访问。没有存储费用，没有服务器维护，靠 Cloudflare 的全球 CDN 分发。

## ✨ 功能

- **📤 上传**：直传（≤24MiB）+ 分片上传（>24MiB），支持断点续传
- **📥 下载**：Worker 代理下载，绕开 Pages 子域名传播延迟
- **🎬 视频播放**：mp4/webm 直出播放，分片自动拼接
- **📊 进度条**：上传/下载均有实时进度 + 阶段状态 + 速度显示
- **📂 文件管理**：文件夹创建、移动、重命名、删除
- **🔄 版本管理**：同名上传自动生成新版本，可命名/清理
- **🔗 分享链接**：生成公开链接，免登录访问
- **🔍 搜索**：文件名 + 版本别名全文搜索
- **🌐 自定义域名**：绑定任何 Cloudflare 管理的域名，速度 10x

## 🏗️ 架构

```
┌─────────────────────────────────────────┐
│               浏览器 (Vue 3)             │
│   blake3 hash · base64 编码 · 分片上传    │
└────────────┬────────────────────────────┘
             │ HTTPS
┌────────────▼────────────────────────────┐
│     Cloudflare Pages (Worker _worker.js) │
│     Hono 路由 · JWT 鉴权 · 流式透传       │
│     /api/upload  /api/files  /api/auth    │
└────┬──────────────┬──────────────┬──────┘
     │              │              │
┌────▼────┐  ┌──────▼──────┐  ┌──▼──────────────────┐
│   D1    │  │     KV      │  │  Pages API           │
│  文件树  │  │  分片元数据  │  │  assets/upload       │
│  版本    │  │  上传会话   │  │  upsert-hashes        │
│  用户    │  │             │  │  deployments          │
└─────────┘  └─────────────┘  └──────────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  cf-{user}-data      │
                          │  pages.dev 部署       │
                          │  (实际文件存储)        │
                          └─────────────────────┘
```

### 关键技术决策

| 问题 | 方案 | 原因 |
|------|------|------|
| 大文件 hash 计算 | 浏览器端 (blake3 + base64) | Worker CPU 限制 10ms，大文件必然超时 |
| Worker 上传 | 流式透传 (body 原样转发) | CPU ≈ 0，彻底规避 10ms 限制 |
| 分片暂存 | 浏览器直传 + KV 记 hash 元数据 | 不为二进制内容消耗 KV 空间 |
| 下载 | Worker 代理端点 | 绕开 Pages 子域名传播延迟 (数小时) |
| 断点续传 | localStorage + /api/upload/status | 浏览器刷新后自动恢复 |

## 📁 项目结构

```
cloudfiles/
├── apps/
│   ├── api/                     # Cloudflare Worker (Hono)
│   │   ├── src/
│   │   │   ├── app.ts           # 路由组装 + CORS + 静态服务
│   │   │   ├── env.ts           # 环境类型定义
│   │   │   ├── db.ts            # Repo 接口 + D1/Memory 实现
│   │   │   ├── index.ts         # Worker 入口
│   │   │   └── features/
│   │   │       ├── auth.ts      # 注册/登录/me (含 Pages 项目自动创建)
│   │   │       ├── files.ts     # 文件系统 (list/mkdir/rm/mv)
│   │   │       ├── upload.ts    # 上传 (直传 + 分片 + CLI 注册)
│   │   │       ├── versions.ts  # 版本管理 + 下载 + 播放 + 搜索
│   │   │       ├── shares.ts    # 分享链接
│   │   │       ├── storage.ts   # 存储适配器工厂
│   │   │       └── context.ts   # 数据库上下文
│   │   ├── migrations/
│   │   │   ├── 0001_init.sql    # 初始表 (users/files/versions/chunks/...)
│   │   │   └── 0002_upload_sessions.sql
│   │   └── wrangler.toml
│   └── web/                     # 前端 SPA (Vue 3 + Vite)
│       └── src/
│           ├── App.vue
│           ├── api/client.ts    # API 客户端 + 上传/下载封装
│           ├── components/
│           │   └── UploadProgressBar.vue
│           └── views/
│               ├── LoginView.vue
│               ├── DriveView.vue    # 文件管理主界面
│               └── PlayerView.vue   # 视频播放器
├── packages/
│   └── shared/                  # 前后端共享代码
│       └── src/
│           ├── schema.ts        # Zod 校验
│           ├── crypto.ts        # PBKDF2 + JWT
│           ├── storage.ts       # PagesDeployAdapter (核心)
│           ├── capabilities.ts  # 文件类型支持
│           └── config.ts        # 配置常量
└── scripts/
    ├── deploy-web.mjs           # 前端部署脚本
    └── build-worker.mjs         # Worker 打包脚本
```

## 🚀 部署

### 前置条件

1. Cloudflare 账号 (Free 计划即可)
2. Wrangler CLI: `npm install -g wrangler`
3. [可选] 一个 Cloudflare 管理的域名 (自定义域名)

### 1. 创建 Cloudflare 资源

```bash
# D1 数据库
wrangler d1 create cloudfiles-db

# KV 命名空间
wrangler kv:namespace create cloudfiles-kv

# Pages 项目
wrangler pages project create cloudfiles-web
```

### 2. 配置 wrangler.toml

编辑 `apps/api/wrangler.toml`，填入你的 D1/KV ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cloudfiles-db"
database_id = "你的D1_ID"

[[kv_namespaces]]
binding = "KV"
id = "你的KV_ID"
```

### 3. 注入密钥

```bash
wrangler secret put JWT_SECRET        # 任意随机字符串 (>32 字符)
wrangler secret put CLOUDFLARE_ACCOUNT_ID  # Cloudflare 账号 ID
wrangler secret put CLOUDFLARE_API_TOKEN   # Pages:Edit 权限的 API Token
wrangler secret put CF_PROJECT_PREFIX      # 用户项目前缀，如 "cf"
wrangler secret put CF_ENV                  # "production"
wrangler secret put CF_ALLOWED_ORIGINS     # 如 "https://cloudfiles-web.pages.dev"
```

### 4. 执行 D1 迁移

```bash
wrangler d1 execute cloudfiles-db --file=apps/api/migrations/0001_init.sql
wrangler d1 execute cloudfiles-db --file=apps/api/migrations/0002_upload_sessions.sql
```

### 5. 部署

```bash
# 构建 shared
cd packages/shared && npx tsc && cd ../..

# 构建前端
cd apps/web && npx vite build && cd ../..

# 部署到 Pages
wrangler pages deploy apps/web/dist --project-name=cloudfiles-web
```

### 6. [可选] 绑定自定义域名

```bash
# 通过 Cloudflare Dashboard 或 API 绑定
curl -X POST "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/cloudfiles-web/domains" \
  -H "Authorization: Bearer {API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"your-domain.com"}'
```

然后在域名 DNS 处添加 CNAME 记录指向 `cloudfiles-web.pages.dev`。

## 🔐 安全

- 密码使用 PBKDF2 (100,000 iterations) + SHA-256 哈希
- JWT 会话 (7 天有效期)
- API Token 通过 wrangler secrets 加密存储
- 上传文件部署在仅用户可知的随机子域名下

### ⚠️ 重要提醒

上传完成后，文件可通过部署 URL 直接访问 (如 `https://abc123.cf-user-data.pages.dev/file.mp4`)。如果不想公开：
- **分享功能**已提供是否公开的控制选项
- 或未来实现 **private deployments** (Pages 访问控制)

## 📊 Cloudflare 免费计划限制

| 限制项 | 值 | 影响 |
|--------|-----|------|
| Pages builds/月 | 500 | 每个文件 = 1 次 build，所有用户共享 |
| Worker CPU | 10ms/请求 | 已通过浏览器端计算 + 流式透传规避 |
| Worker 子请求 | 50/请求 | 单文件播放/下载上限 ~1.2GB (24MiB×50片) |
| Worker 请求/天 | 100,000 | 个人使用足够 |
| D1 行数 | 500 万 | 足够 |
| KV 读取/天 | 100,000 | 足够 |

> 月上传超过 500 文件时可升级到 Pages Pro ($5/月) 消除限制。

## 🧪 测试

```bash
cd apps/api && npx vitest run
```

16 个测试覆盖：认证、文件系统、分享、分片上传全链路、断点续传、超限拒绝。

## 🛠️ 开发

```bash
# 启动 API 本地服务器 (端口 8787)
cd apps/api && npx wrangler dev

# 启动前端开发服务器 (端口 5173, 代理到 8787)
cd apps/web && npx vite
```

## 📝 License

MIT

---

> Built with ❤️ and the spirit of "What if we just use Pages for everything?"

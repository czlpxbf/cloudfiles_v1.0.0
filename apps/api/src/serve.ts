// 本地开发服务器（无需 Cloudflare 环境）：
//   用 MemoryRepo + MemoryAdapter 运行完整 API，前端 Vite proxy 联调
//   运行: npm run serve -w @cloudfiles/api  → http://localhost:8787
import { serve } from '@hono/node-server';
import { MemoryAdapter } from '@cloudfiles/shared';
import { createApp } from './app';

const storage = new MemoryAdapter();
const env = {
  storage, // 注入内存存储（灵魂模拟：部署即存储）
  CLOUDFLARE_ACCOUNT_ID: 'local',
  CLOUDFLARE_API_TOKEN: 'local',
  CF_PROJECT_PREFIX: 'cf',
  JWT_SECRET: 'local-dev-secret-please-change-0123456789',
  CF_ENV: 'development',
} as any;

const app = createApp();

serve({ fetch: (req) => app.fetch(req, env), port: 8787 }, (info) => {
  console.log(`\nCloudfiles API 本地服务已启动: http://localhost:${info.port}`);
  console.log('提示: 数据存储在内存中，重启即清空。\n');
});

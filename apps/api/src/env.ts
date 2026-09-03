// Cloudflare Worker 环境类型
import type { StorageAdapter } from '@cloudfiles/shared';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  // Durable Objects（绕过 Worker 10ms CPU 限制）
  HASH_DO: DurableObjectNamespace;
  MEDIA_DO: DurableObjectNamespace;
  // 生产注入的 secrets
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CF_PROJECT_PREFIX: string;
  JWT_SECRET: string;
  CF_ENV: string;
  /** 允许跨域的 Origin（逗号分隔），如 https://cloudfiles-web.pages.dev */
  CF_ALLOWED_ORIGINS: string;
  /** Pages Functions 静态资源绑定（Advanced mode 下 worker 接管全部请求，须用 ASSETS 服务静态文件） */
  ASSETS?: Fetcher;
  // 测试注入（可选）：不注入则用 Pages 真实现
  storage?: StorageAdapter;
  now?: () => string;
}

export interface AppVariables {
  userId: number;
  username: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

export function cfg(env: Env) {
  return {
    projectPrefix: env.CF_PROJECT_PREFIX || 'cf',
    mainBranch: 'main',
    jwtSecret: env.JWT_SECRET,
    jwtTtlSec: 7 * 24 * 3600,
  };
}

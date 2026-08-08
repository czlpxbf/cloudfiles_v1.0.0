// 存储适配器获取：生产 = PagesDeployAdapter，测试/本地 = 注入的 memory
import { PagesDeployAdapter, type StorageAdapter } from '@cloudfiles/shared';
import type { Env } from '../env';

export function getStorage(env: Env): StorageAdapter {
  if (env.storage) return env.storage; // 测试注入
  return new PagesDeployAdapter({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  });
}

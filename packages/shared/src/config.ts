// @cloudfiles/shared - 配置契约（MASTER_PLAN §5.2）

export interface CloudfilesConfig {
  cloudflare: {
    accountId: string;
    apiToken: string;
    projectPrefix: string; // 用户项目 = {prefix}-{username}-main/data
    mainBranch: string;
  };
  storage: {
    adapter: 'pages'; // Phase 3 扩展 r2/s3
    chunkSizeBytes: number; // 默认 25MiB = Cloudflare Pages 单文件上限（平台边界）
  };
  video: {
    mode: 'hls' | 'dash';
    keepOriginal: boolean;
  };
  features: {
    thumbnails: 'cli' | 'client' | 'none';
    scraper: 'none' | 'tmdb';
    officePreview: boolean;
  };
  auth: {
    jwtSecret: string;
    jwtTtlSec: number;
  };
}

export const DEFAULT_CONFIG: Omit<CloudfilesConfig, 'cloudflare' | 'auth'> = {
  storage: { adapter: 'pages', chunkSizeBytes: 25 * 1024 * 1024 },
  video: { mode: 'hls', keepOriginal: false },
  features: { thumbnails: 'cli', scraper: 'none', officePreview: false },
};

/** 校验配置（fail fast）——占位符/缺失即抛错 */
export function validateConfig(cfg: CloudfilesConfig): void {
  const errs: string[] = [];
  if (!cfg.cloudflare.accountId) errs.push('cloudflare.accountId 缺失');
  if (!cfg.cloudflare.apiToken) errs.push('cloudflare.apiToken 缺失（最小权限: Pages:Edit）');
  if (!cfg.cloudflare.projectPrefix) errs.push('cloudflare.projectPrefix 缺失');
  if (cfg.storage.chunkSizeBytes > 25 * 1024 * 1024) errs.push(`chunkSizeBytes 超过 Pages 单文件上限 25MiB: ${cfg.storage.chunkSizeBytes}`);
  if (!cfg.auth.jwtSecret || cfg.auth.jwtSecret.length < 16) errs.push('auth.jwtSecret 缺失或过短（≥16 字符）');
  if (errs.length > 0) throw new Error(`配置无效:\n  - ${errs.join('\n  - ')}`);
}

// @cloudfiles/shared - 存储适配器（灵魂：部署即存储）
//
// 核心设计：
//   一个逻辑文件 = 一次 Pages deployment（含全部分块/附属文件）
//   URL: https://<deployment-hash>.<project>.pages.dev/<path>
//
// 默认实现 PagesDeployAdapter 使用 Cloudflare Pages Direct Upload API 四步流程：
//   GET  upload-token  →  POST assets/upload（批量传文件） →  POST assets/upsert-hashes →  POST deployments
// 与 wrangler pages deploy 走同一协议，纯 HTTP，无本地依赖。
//
// ⚠️ 关键：文件 hash 必须与 wrangler 一致 —— blake3(base64(内容) + 扩展名).hex.slice(0,32)
//   否则 Cloudflare 无法将上传的资产与 manifest 关联（部署"成功"但访问 404）。

import { blake3 } from '@noble/hashes/blake3';

export interface StoredFile {
  baseUrl: string; // https://<hash>.<project>.pages.dev
  deploymentId: string;
  paths: string[]; // 部署内的相对路径清单（不含 baseUrl）
}

export interface StorageDeployOptions {
  projectName: string;
}

/** 存储后端抽象：核心模块只依赖此接口，可替换为 R2/S3 等（Phase 3） */
export interface StorageAdapter {
  deployFiles(
    files: { path: string; content: Uint8Array }[],
    options: StorageDeployOptions,
  ): Promise<StoredFile>;
  deleteDeployment(projectName: string, deploymentId: string): Promise<void>;
  buildFileUrl(baseUrl: string, path: string): string;
  readonly name: string;
  /** 分片上传：单片资产上传（hash+assets/upload） */
  uploadSingleAsset?(projectName: string, path: string, content: Uint8Array): Promise<{ hash: string; path: string; size: number }>;
  /** 分片上传：用已上传资产创建 deployment */
  createDeploymentFromAssets?(projectName: string, assets: { path: string; hash: string }[]): Promise<StoredFile>;
}

// ============================================================
// PagesDeployAdapter —— 灵魂实现
// ============================================================

interface PagesUploadToken {
  result?: { jwt?: string };
}

interface PagesDeployment {
  result?: { id?: string; url?: string };
}

export interface PagesApiCredential {
  accountId: string;
  apiToken: string;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

/** 带重试的 fetch：对 5xx/网络错误重试（Pages 瞬时故障 503 常见），指数退避 */
async function fetchRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res; // 4xx 不重试（认证/参数错误）
      lastErr = new Error(`HTTP ${res.status}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    } catch (e) {
      lastErr = e; // 网络错误
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('网络请求失败');
}

/** 额外 multipart 字段（如 Pages Functions 的 _worker.bundle） */
export interface DeployExtraField {
  field: string;
  filename: string;
  content: Uint8Array;
}

export class PagesDeployAdapter implements StorageAdapter {
  readonly name = 'pages';

  constructor(private cred: PagesApiCredential) {}

  async deployFiles(
    files: { path: string; content: Uint8Array }[],
    options: StorageDeployOptions,
    extra?: DeployExtraField[],
  ): Promise<StoredFile> {
    if (files.length === 0 && !extra?.length) throw new Error('deployFiles: 文件列表为空');

    // Step 1: 获取 300 秒有效的上传 token
    const tokenRes = await fetchRetry(
      `${CF_API}/accounts/${this.cred.accountId}/pages/projects/${options.projectName}/upload-token`,
      { headers: { Authorization: `Bearer ${this.cred.apiToken}` } },
    );
    if (!tokenRes.ok) throw new Error(`获取 upload-token 失败: HTTP ${tokenRes.status}`);
    const uploadToken = (await tokenRes.json()) as PagesUploadToken;
    const uploadJwt = uploadToken.result?.jwt;
    if (!uploadJwt) throw new Error('upload-token 响应缺少 jwt');

    // Step 2: 上传文件（每批 ≤50MB，JSON 数组）
    const manifest: Record<string, string> = {};
    const BATCH_LIMIT = 48 * 1024 * 1024; // 保守取 48MB 留余量
    let batch: { key: string; value: string; metadata: { contentType: string }; base64: boolean }[] = [];
    let batchBytes = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      // assets/* 为 account 无关的全局端点（与 wrangler 一致）
      const upRes = await fetchRetry(`${CF_API}/pages/assets/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${uploadJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!upRes.ok) throw new Error(`上传文件批次失败: HTTP ${upRes.status} ${await upRes.text()}`);
      batch = [];
      batchBytes = 0;
    };

    for (const f of files) {
      const hash = await pagesFileHash(f.content, f.path);
      // manifest key 必须带前导 /（与 wrangler 一致），否则文件无法被定位 → 404
      manifest[f.path.startsWith('/') ? f.path : `/${f.path}`] = hash;
      const b64 = bytesToBase64(f.content);
      batch.push({ key: hash, value: b64, metadata: { contentType: guessMime(f.path) }, base64: true });
      batchBytes += b64.length;
      if (batchBytes >= BATCH_LIMIT) await flush();
    }
    await flush();

    // Step 3: 声明哈希
    const hashes = Object.values(manifest);
    const upsertRes = await fetchRetry(`${CF_API}/pages/assets/upsert-hashes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${uploadJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
    if (!upsertRes.ok) throw new Error(`upsert-hashes 失败: HTTP ${upsertRes.status}`);

    // Step 4: 创建部署（生产分支）
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('branch', 'main');
    for (const e of extra ?? []) {
      form.append(e.field, new Blob([e.content as BlobPart]), e.filename);
    }
    const depRes = await fetchRetry(
      `${CF_API}/accounts/${this.cred.accountId}/pages/projects/${options.projectName}/deployments`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.cred.apiToken}` }, body: form },
    );
    if (!depRes.ok) throw new Error(`创建 deployment 失败: HTTP ${depRes.status} ${await depRes.text()}`);
    const dep = (await depRes.json()) as PagesDeployment;
    const deploymentId = dep.result?.id;
    const url = dep.result?.url;
    if (!deploymentId || !url) throw new Error('deployment 响应缺少 id/url');

    // 生产 URL 规范化：<hash>.<project>.pages.dev
    const baseUrl = extractProductionUrl(url, options.projectName);
    return { baseUrl, deploymentId, paths: files.map((f) => f.path) };
  }

  async deleteDeployment(projectName: string, deploymentId: string): Promise<void> {
    const res = await fetch(
      `${CF_API}/accounts/${this.cred.accountId}/pages/projects/${projectName}/deployments/${deploymentId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.cred.apiToken}` } },
    );
    if (!res.ok) throw new Error(`删除 deployment ${deploymentId} 失败: HTTP ${res.status}`);
  }

  /**
   * 单资产上传（分片上传用）：获取 jwt → hash → assets/upload 单片
   * 返回 { hash, path, size }，供 createDeployment 引用。CPU 开销仅单片，避免 Worker 超时。
   */
  async uploadSingleAsset(projectName: string, path: string, content: Uint8Array): Promise<{ hash: string; path: string; size: number }> {
    // jwt
    const tokenRes = await fetchRetry(
      `${CF_API}/accounts/${this.cred.accountId}/pages/projects/${projectName}/upload-token`,
      { headers: { Authorization: `Bearer ${this.cred.apiToken}` } },
    );
    if (!tokenRes.ok) throw new Error(`获取 upload-token 失败: HTTP ${tokenRes.status}`);
    const jwt = ((await tokenRes.json()) as PagesUploadToken).result?.jwt;
    if (!jwt) throw new Error('upload-token 响应缺少 jwt');

    const hash = await pagesFileHash(content, path);
    const b64 = bytesToBase64(content);
    const upRes = await fetchRetry(`${CF_API}/pages/assets/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ key: hash, value: b64, metadata: { contentType: guessMime(path) }, base64: true }]),
    });
    if (!upRes.ok) throw new Error(`上传资产失败: HTTP ${upRes.status} ${await upRes.text()}`);
    return { hash, path, size: content.byteLength };
  }

  /**
   * 用已上传的资产清单创建 deployment（分片 finalize 用）：
   * upsert-hashes（一次声明全部）→ POST deployments（manifest 引用）。
   */
  async createDeploymentFromAssets(
    projectName: string,
    assets: { path: string; hash: string }[],
  ): Promise<StoredFile> {
    if (assets.length === 0) throw new Error('createDeploymentFromAssets: 资产列表为空');
    const tokenRes = await fetchRetry(
      `${CF_API}/accounts/${this.cred.accountId}/pages/projects/${projectName}/upload-token`,
      { headers: { Authorization: `Bearer ${this.cred.apiToken}` } },
    );
    if (!tokenRes.ok) throw new Error(`获取 upload-token 失败: HTTP ${tokenRes.status}`);
    const jwt = ((await tokenRes.json()) as PagesUploadToken).result?.jwt;
    if (!jwt) throw new Error('upload-token 响应缺少 jwt');

    const hashes = assets.map((a) => a.hash);
    const upsertRes = await fetchRetry(`${CF_API}/pages/assets/upsert-hashes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
    if (!upsertRes.ok) throw new Error(`upsert-hashes 失败: HTTP ${upsertRes.status}`);

    const manifest: Record<string, string> = {};
    for (const a of assets) manifest[a.path.startsWith('/') ? a.path : `/${a.path}`] = a.hash;
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('branch', 'main');
    const depRes = await fetchRetry(
      `${CF_API}/accounts/${this.cred.accountId}/pages/projects/${projectName}/deployments`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.cred.apiToken}` }, body: form },
    );
    if (!depRes.ok) throw new Error(`创建 deployment 失败: HTTP ${depRes.status} ${await depRes.text()}`);
    const dep = (await depRes.json()) as PagesDeployment;
    const deploymentId = dep.result?.id;
    const url = dep.result?.url;
    if (!deploymentId || !url) throw new Error('deployment 响应缺少 id/url');
    return { baseUrl: extractProductionUrl(url, projectName), deploymentId, paths: assets.map((a) => a.path) };
  }

  buildFileUrl(baseUrl: string, path: string): string {
    return `${baseUrl}/${path}`;
  }
}

// ============================================================
// MemoryAdapter —— 本地测试/开发用（不触网）
// ============================================================

export class MemoryAdapter implements StorageAdapter {
  readonly name = 'memory';
  /** 记录已部署的文件，供测试断言 */
  deployments: Record<string, Record<string, Uint8Array>> = {};
  /** 资产池：hash → { path, content }（uploadSingleAsset 暂存，createDeploymentFromAssets 引用） */
  assetPool: Record<string, { path: string; content: Uint8Array }> = {};
  private counter = 0;

  async deployFiles(
    files: { path: string; content: Uint8Array }[],
    _options: StorageDeployOptions,
  ): Promise<StoredFile> {
    const id = `mem-${++this.counter}`;
    this.deployments[id] = {};
    for (const f of files) this.deployments[id][f.path] = f.content;
    return { baseUrl: `https://${id}.memory.pages.dev`, deploymentId: id, paths: files.map((f) => f.path) };
  }

  async deleteDeployment(_projectName: string, deploymentId: string): Promise<void> {
    delete this.deployments[deploymentId];
  }

  async uploadSingleAsset(_projectName: string, path: string, content: Uint8Array): Promise<{ hash: string; path: string; size: number }> {
    const hash = `mem-${path}-${++this.counter}`;
    this.assetPool[path] = { path, content }; // 以 path 为键（finalize 按 path 匹配，规避 hash 命名差异）
    return { hash, path, size: content.byteLength };
  }

  async createDeploymentFromAssets(_projectName: string, assets: { path: string; hash: string }[]): Promise<StoredFile> {
    const id = `mem-${++this.counter}`;
    this.deployments[id] = {};
    for (const a of assets) {
      const item = this.assetPool[a.path];
      if (item) this.deployments[id][a.path] = item.content;
    }
    return { baseUrl: `https://${id}.memory.pages.dev`, deploymentId: id, paths: assets.map((a) => a.path) };
  }

  buildFileUrl(baseUrl: string, path: string): string {
    return `${baseUrl}/${path}`;
  }

  getContent(baseUrl: string, path: string): Uint8Array | undefined {
    const id = baseUrl.replace('https://', '').replace('.memory.pages.dev', '');
    return this.deployments[id]?.[path];
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * Pages 文件 hash —— 必须与 wrangler 完全一致：
 *   blake3( base64(fileContent) + 去点扩展名 ).hex.slice(0, 32)
 * 这是 Cloudflare 关联"上传资产 ↔ manifest"的键，算法不一致会导致部署成功但访问 404。
 */
export async function pagesFileHash(content: Uint8Array, filename: string): Promise<string> {
  const b64 = bytesToBase64(content);
  const ext = filename.includes('.') ? filename.split('.').pop()! : '';
  const digest = blake3(new TextEncoder().encode(b64 + ext));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    json: 'application/json', txt: 'text/plain', md: 'text/markdown',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t',
    mpd: 'application/dash+xml', m4s: 'video/iso.segment',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
    pdf: 'application/pdf', zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** 规范化生产 URL：https://<random-hash>.<project>.pages.dev → 原样使用 */
export function extractProductionUrl(previewUrl: string, _projectName: string): string {
  try {
    const u = new URL(previewUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return previewUrl;
  }
}

// API 客户端：fetch 封装（自动携带 cookie 会话）
// 基址：构建时注入 VITE_API_BASE（部署到 Pages 时指向 Worker 域名）
const BASE = (import.meta as any).env?.VITE_API_BASE || '';

// ============================================================
// 浏览器端 hash + base64（关键：Worker 免费版 CPU 限 10ms，
// 大文件 blake3/base64 在 Worker 内计算必然超时 → 503。
// 所以 hash 与 base64 全部在浏览器算好，Worker 只透传。）
// ============================================================

/** 分片读取大文件为 Uint8Array */
async function readBytes(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/** 高效 base64（分块 btoa，避免大字符串拼接卡死） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Pages 文件 hash：blake3(base64(内容)+扩展名).hex.slice(0,32)，与 wrangler 一致 */
export async function pagesFileHash(content: Uint8Array, filename: string): Promise<string> {
  const { blake3 } = await import('@noble/hashes/blake3');
  const b64 = bytesToBase64(content);
  const ext = filename.includes('.') ? filename.split('.').pop()! : '';
  const digest = blake3(new TextEncoder().encode(b64 + ext));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export interface FileNode {
  id: number;
  name: string;
  type: 'file' | 'folder';
  createdAt: string;
  modifiedAt: string;
  versions?: { id: number; size: number; createdAt: string; name: string | null; shotAt: string | null; isVideo: boolean; duration: number | null; resolution: string | null }[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: init.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  register: (username: string, password: string) =>
    request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: { id: number; username: string } }>('/api/auth/me'),

  list: (path: string) => request<{ path: string; children: FileNode[] }>(`/api/files/list?path=${encodeURIComponent(path)}`),
  mkdir: (path: string) => request('/api/files/folder', { method: 'POST', body: JSON.stringify({ path }) }),
  remove: (path: string) => request('/api/files/remove', { method: 'POST', body: JSON.stringify({ path }) }),
  move: (src: string, dest: string) => request('/api/files/move', { method: 'POST', body: JSON.stringify({ src, dest }) }),

  uploadSingle: (file: File, remotePath: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('remotePath', remotePath);
    return request<{ ok: boolean; fileId: number; versionId: number }>('/api/upload/single', { method: 'POST', body: form });
  },

  // ============ 分片上传（大文件） ============
  uploadInitiate: (filename: string, remotePath: string, size: number) =>
    request<{ uploadId: string; chunkSize: number; totalChunks: number; filename: string; remotePath: string }>('/api/upload/initiate', {
      method: 'POST',
      body: JSON.stringify({ filename, remotePath, size }),
    }),
  uploadStatus: (uploadId: string) =>
    request<{
      uploadId: string; filename: string; remotePath: string; chunkSize: number;
      totalChunks: number; totalSize: number; uploaded: number[]; status: string;
    }>(`/api/upload/status?uploadId=${encodeURIComponent(uploadId)}`),
  uploadFinalize: (uploadId: string) =>
    request<{ ok: boolean; fileId: number; versionId: number; deployUrl: string; chunkCount: number }>('/api/upload/finalize', {
      method: 'POST',
      body: JSON.stringify({ uploadId }),
    }),

  versions: (path: string) =>
    request<{ path: string; versions: { id: number; size: number; createdAt: string; name: string | null; shotAt: string | null; isVideo: boolean }[] }>(
      `/api/files/versions?path=${encodeURIComponent(path)}`,
    ),
  renameVersion: (filePath: string, createdAt: string, name: string) =>
    request('/api/files/versions/rename', { method: 'POST', body: JSON.stringify({ filePath, createdAt, name }) }),
  cleanVersions: (filePath: string, target?: string) =>
    request('/api/files/versions/clean', { method: 'POST', body: JSON.stringify({ filePath, ...(target ? { target } : {}) }) }),

  download: (path: string, versionId?: number) =>
    request<{ filename: string; versionId: number; baseUrl: string; urls: { index: number; path: string; size: number; url: string }[] }>(
      `/api/files/download?path=${encodeURIComponent(path)}${versionId ? `&versionId=${versionId}` : ''}`,
    ),
  play: (path: string) =>
    request<{ filename: string; protocol: string; manifestUrl: string; library?: string; poster?: string }>(
      `/api/files/play?path=${encodeURIComponent(path)}`,
    ),
  search: (q: string) =>
    request<{ q: string; results: { fileId: number; fileName: string; versionId: number; versionName: string | null; createdAt: string }[] }>(
      `/api/files/search?q=${encodeURIComponent(q)}`,
    ),
};

// ============================================================
// 浏览器端上传（hash+base64 在浏览器算，Worker 只透传 → 规避 10ms CPU 限制）
// ============================================================

export interface UploadProgress {
  loaded: number;
  total: number;
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

/** 用 XHR 上传原始 JSON body（浏览器已算好 hash/base64），实时进度 */
export function uploadJsonWithProgress(
  path: string,
  body: string,
  onProgress: (p: UploadProgress) => void,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, '网络错误')));
    xhr.addEventListener('timeout', () => reject(new ApiError(0, '上传超时')));
    xhr.timeout = 0;
    xhr.addEventListener('load', () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status, data });
      else reject(new ApiError(xhr.status, (data as { error?: string })?.error || `HTTP ${xhr.status}`));
    });
    xhr.send(body);
  });
}

/** 构造 Pages assets/upload 的单资产 JSON（key/value/metadata/base64:true） */
function pagesAssetJson(path: string, bytes: Uint8Array, hash: string): string {
  return JSON.stringify([
    {
      key: hash,
      value: bytesToBase64(bytes),
      metadata: { contentType: guessMime(path) },
      base64: true,
    },
  ]);
}

/** 直传单文件（≤24MiB）：浏览器算 hash+base64 → Worker 透传 */
export async function uploadSingleFile(
  file: File,
  remotePath: string,
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await pagesFileHash(bytes, file.name);
  const body = pagesAssetJson(file.name, bytes, hash);
  const params = new URLSearchParams({ filename: file.name, remotePath, hash, size: String(bytes.byteLength) });
  await uploadJsonWithProgress(`/api/upload/single?${params}`, body, onProgress);
}

/** 上传单个分片（浏览器算 hash+base64） */
export async function uploadChunkWithProgress(
  uploadId: string,
  index: number,
  blob: Blob,
  filename: string,
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const path = `${filename}.part${String(index).padStart(3, '0')}`;
  const hash = await pagesFileHash(bytes, path);
  const body = pagesAssetJson(path, bytes, hash);
  const params = new URLSearchParams({ uploadId, index: String(index), hash, size: String(bytes.byteLength) });
  await uploadJsonWithProgress(`/api/upload/chunk?${params}`, body, onProgress);
}

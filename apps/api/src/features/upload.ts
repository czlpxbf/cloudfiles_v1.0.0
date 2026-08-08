// 上传：单文件直传（≤24MiB）+ 大文件分片上传
//
// ⚠️ 关键架构：Worker 免费版 CPU 限制 10ms，大文件 blake3/base64 在 Worker 内计算必然超时（1102→503）。
// 因此 hash 与 base64 全部在**浏览器端**计算，Worker 只做**流式透传**（body 原样转发，CPU≈0）。
//
// 上传协议：
//   POST /api/upload/single?filename=&remotePath=&hash=&size=&shotAt=
//     body = Pages assets/upload 格式 JSON：[{key, value, metadata, base64:true}]
//   POST /api/upload/chunk?uploadId=&index=&hash=&size=
//     body 同上（单片）
//   POST /api/upload/initiate / finalize / GET status（元数据，JSON 小请求）
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import { createDb } from './context';
import { resolvePath, ensureProject } from './auth';
import { getStorage } from './storage';

/** Pages 单文件硬限制 25MiB；直传留余量取 24MiB，分片取 8MiB（浏览器端算 hash，分片大小只影响网络） */
export const DIRECT_LIMIT = 24 * 1024 * 1024;
export const CHUNK_SIZE = 24 * 1024 * 1024;

/** 根据文件名判断是否视频 */
function isVideoFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(ext);
}

const CF_API = 'https://api.cloudflare.com/client/v4';
const kvChunkKey = (userId: number, uploadId: string, index: number) => `up:${userId}:${uploadId}:${index}`;

/** 透传单个资产到 Pages assets/upload（body 原样转发，不做任何 CPU 计算） */
async function proxyUploadAsset(env: Env, projectName: string, rawBody: ReadableStream | null, headers: Headers): Promise<Response> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const tokenRes = await fetch(
    `${CF_API}/accounts/${accountId}/pages/projects/${projectName}/upload-token`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (!tokenRes.ok) throw new Error(`获取 upload-token 失败: HTTP ${tokenRes.status}`);
  const jwt = ((await tokenRes.json()) as { result?: { jwt?: string } }).result?.jwt;
  if (!jwt) throw new Error('upload-token 响应缺少 jwt');

  // 透传：复制 Content-Type，body 原样转发
  const ct = headers.get('Content-Type') || 'application/json';
  return fetch(`${CF_API}/pages/assets/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': ct },
    body: rawBody,
    duplex: 'half',
  } as RequestInit);
}

export function uploadRoutes() {
  const app = new Hono<AppEnv>();

  // ============ 方式一：单文件直传（≤24MiB）============
  // body 由浏览器端构造（含 hash/base64），Worker 流式透传 + 注册元数据
  app.post('/single', async (c) => {
    const db = createDb(c.env);
    const storage = getStorage(c.env);
    const userId = c.get('userId');
    const filename = c.req.query('filename') || '';
    const remotePath = c.req.query('remotePath') || '/';
    const hash = c.req.query('hash') || '';
    const size = Number(c.req.query('size') || 0);
    const shotAt = c.req.query('shotAt') || null;

    if (!filename || !hash || !size) return c.json({ error: '缺少 filename/hash/size' }, 400);
    if (size > DIRECT_LIMIT) {
      return c.json({ error: `单文件直传上限 ${Math.floor(DIRECT_LIMIT / 1024 / 1024)}MiB，大文件请使用分片上传` }, 413);
    }

    const user = await db.findUserById(userId);
    if (!user) return c.json({ error: '用户不存在' }, 404);

    // 定位目标目录
    const parts = remotePath.split('/').filter(Boolean);
    let parentId: number | null = null;
    for (const part of parts) {
      const dir = await db.findChild(userId, parentId, part);
      if (!dir || dir.type !== 'folder') return c.json({ error: `目录不存在: ${remotePath}` }, 404);
      parentId = dir.id;
    }

    // 兜底：确保用户数据项目存在
    if (!c.env.storage) await ensureProject(c.env, user.pagesData);

    let deploy;
    try {
      if (c.env.storage) {
        // 测试注入：直接用 memory 实现
        const { content } = await extractBodyForTest(c.req.raw);
        deploy = await storage.deployFiles([{ path: filename, content }], { projectName: user.pagesData });
      } else {
        // 生产：流式透传（CPU≈0）
        const res = await proxyUploadAsset(c.env, user.pagesData, c.req.raw.body, c.req.raw.headers);
        if (!res.ok) throw new Error(`上传资产失败: HTTP ${res.status} ${await res.text()}`);
        const upsert = await fetch(`${CF_API}/pages/assets/upsert-hashes`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${(await fetchUploadJwt(c.env, user.pagesData))}` , 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: [hash] }),
        });
        if (!upsert.ok) throw new Error(`upsert-hashes 失败: HTTP ${upsert.status}`);
        const form = new FormData();
        form.append('manifest', JSON.stringify({ [`/${filename}`]: hash }));
        form.append('branch', 'main');
        const depRes = await fetch(
          `${CF_API}/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${user.pagesData}/deployments`,
          { method: 'POST', headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}` }, body: form },
        );
        if (!depRes.ok) throw new Error(`创建 deployment 失败: HTTP ${depRes.status} ${await depRes.text()}`);
        const dep = (await depRes.json()) as { result?: { id?: string; url?: string } };
        const baseUrl = dep.result?.url ? new URL(dep.result.url).origin : '';
        deploy = { baseUrl, deploymentId: dep.result?.id || '', paths: [filename] };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[upload/single] 失败:', msg);
      return c.json({ error: `上传失败: ${msg}` }, 502);
    }

    const ts = new Date().toISOString();
    const node = await db.findChild(userId, parentId, filename);
    const fileNode = node && node.type === 'file' ? node : await db.createFile(userId, parentId, filename, ts);
    if (node && node.type === 'folder') {
      await storage.deleteDeployment(user.pagesData, deploy.deploymentId).catch(() => {});
      return c.json({ error: `目标位置已存在同名文件夹: ${filename}` }, 409);
    }

    const version = await db.addVersion({
      fileId: fileNode.id,
      size,
      createdAt: ts,
      name: null,
      shotAt,
      deployUrl: deploy.baseUrl,
      deploymentId: deploy.deploymentId,
      isVideo: isVideoFile(filename),
      duration: null,
      resolution: null,
      chunkCount: 1,
    });
    await db.addChunks(version.id, [{ index: 0, path: filename, size }]);
    await db.updateModified(fileNode.id, ts);

    return c.json({ ok: true, fileId: fileNode.id, versionId: version.id, deployUrl: deploy.baseUrl }, 201);
  });

  // ============ 方式二：大文件分片上传（>24MiB）============
  const initiateSchema = z.object({
    filename: z.string().min(1).max(255),
    remotePath: z.string().min(1).max(1024),
    size: z.number().int().positive(),
  });

  app.post('/initiate', zValidator('json', initiateSchema), async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const { filename, remotePath, size } = c.req.valid('json');
    if (size <= DIRECT_LIMIT) {
      return c.json({ error: '文件未超过直传上限，无需分片' }, 400);
    }

    const parts = remotePath.split('/').filter(Boolean);
    let parentId: number | null = null;
    for (const part of parts) {
      const dir = await db.findChild(userId, parentId, part);
      if (!dir || dir.type !== 'folder') return c.json({ error: `目录不存在: ${remotePath}` }, 404);
      parentId = dir.id;
    }

    const uploadId = crypto.randomUUID();
    const totalChunks = Math.ceil(size / CHUNK_SIZE);
    await db.createUploadSession({
      userId,
      uploadId,
      filename,
      remotePath,
      totalSize: size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      status: 'uploading',
    });

    return c.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks, filename, remotePath }, 201);
  });

  // POST /api/upload/chunk?uploadId=&index=&hash=&size=  body = Pages JSON 单片（浏览器算好 hash/base64）
  app.post('/chunk', async (c) => {
    const db = createDb(c.env);
    const kv = c.env.KV;
    const storage = getStorage(c.env);
    const userId = c.get('userId');
    const uploadId = c.req.query('uploadId') || '';
    const index = Number(c.req.query('index'));
    const hash = c.req.query('hash') || '';
    const size = Number(c.req.query('size') || 0);

    if (!uploadId || !Number.isInteger(index) || index < 0 || !hash) {
      return c.json({ error: '缺少 uploadId/index/hash' }, 400);
    }

    const session = await db.findUploadSession(userId, uploadId);
    if (!session) return c.json({ error: '上传任务不存在' }, 404);
    if (session.status !== 'uploading') return c.json({ error: `任务已结束(${session.status})` }, 409);
    if (index >= session.totalChunks) return c.json({ error: `分片索引越界: ${index}` }, 400);
    if (size > session.chunkSize) {
      return c.json({ error: `分片超过大小限制 ${Math.floor(session.chunkSize / 1024 / 1024)}MiB` }, 413);
    }

    const user = await db.findUserById(userId);
    if (!user) return c.json({ error: '用户不存在' }, 404);
    const path = `${session.filename}.part${String(index).padStart(3, '0')}`;

    try {
      if (!c.env.storage) {
        if (!c.env.storage) await ensureProject(c.env, user.pagesData);
        const res = await proxyUploadAsset(c.env, user.pagesData, c.req.raw.body, c.req.raw.headers);
        if (!res.ok) throw new Error(`上传资产失败: HTTP ${res.status} ${await res.text()}`);
      } else {
        // 测试：从 body 提取内容
        const { content } = await extractBodyForTest(c.req.raw);
        await storage.uploadSingleAsset!(user.pagesData, path, content);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[upload/chunk] 失败:', msg);
      return c.json({ error: `分片上传失败: ${msg}` }, 502);
    }

    // KV 记录分片元数据（hash/path/size）
    await kv.put(`${kvChunkKey(userId, uploadId, index)}`, JSON.stringify({ hash, path, size }), {
      expirationTtl: 24 * 3600,
    });
    return c.json({ ok: true, index });
  });

  // GET /api/upload/status?uploadId= → 已上传分片索引（断点续传）
  app.get('/status', async (c) => {
    const db = createDb(c.env);
    const kv = c.env.KV;
    const userId = c.get('userId');
    const uploadId = c.req.query('uploadId');
    if (!uploadId) return c.json({ error: '缺少 uploadId' }, 400);

    const session = await db.findUploadSession(userId, uploadId);
    if (!session) return c.json({ error: '上传任务不存在' }, 404);

    const prefix = `up:${userId}:${uploadId}:`;
    const uploaded: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix, cursor, limit: 1000 });
      for (const k of page.keys) {
        const idx = Number(k.name.slice(prefix.length));
        if (Number.isInteger(idx)) uploaded.push(idx);
      }
      cursor = (page as { cursor?: string }).cursor;
    } while (cursor);

    return c.json({
      uploadId,
      filename: session.filename,
      remotePath: session.remotePath,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      totalSize: session.totalSize,
      uploaded: uploaded.sort((a, b) => a - b),
      status: session.status,
    });
  });

  // POST /api/upload/finalize { uploadId } → 从 KV 组装 manifest → 轻量部署 → 注册
  const finalizeSchema = z.object({ uploadId: z.string().min(1) });

  app.post('/finalize', zValidator('json', finalizeSchema), async (c) => {
    const db = createDb(c.env);
    const storage = getStorage(c.env);
    const kv = c.env.KV;
    const userId = c.get('userId');
    const { uploadId } = c.req.valid('json');

    const session = await db.findUploadSession(userId, uploadId);
    if (!session) return c.json({ error: '上传任务不存在' }, 404);
    if (session.status !== 'uploading') return c.json({ error: `任务已结束(${session.status})` }, 409);

    const user = await db.findUserById(userId);
    if (!user) return c.json({ error: '用户不存在' }, 404);

    // 从 KV 读出全部分片的 hash 元数据
    const assets: { path: string; hash: string }[] = [];
    const chunks: { index: number; path: string; size: number }[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      const v = await kv.get(kvChunkKey(userId, uploadId, i), 'text');
      if (!v) {
        return c.json({ error: `分片 ${i}/${session.totalChunks} 未上传，请续传`, missing: i }, 409);
      }
      const meta = JSON.parse(v) as { hash: string; path: string; size: number };
      assets.push({ path: meta.path, hash: meta.hash });
      chunks.push({ index: i, path: meta.path, size: meta.size });
    }

    // 轻量创建 deployment（仅 upsert-hashes + manifest，无大文件 CPU）
    if (!c.env.storage) await ensureProject(c.env, user.pagesData);
    let deploy;
    try {
      if (c.env.storage) {
        deploy = await storage.createDeploymentFromAssets!(user.pagesData, assets);
      } else {
        deploy = await createDeploymentProxy(c.env, user.pagesData, assets);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[upload/finalize] 部署失败:', msg);
      return c.json({ error: `部署失败: ${msg}` }, 502);
    }

    // 注册文件节点 + 版本 + 分块
    const ts = new Date().toISOString();
    const parts = session.remotePath.split('/').filter(Boolean);
    let parentId: number | null = null;
    for (const part of parts) {
      const dir = await db.findChild(userId, parentId, part);
      if (!dir || dir.type !== 'folder') return c.json({ error: `目录不存在: ${session.remotePath}` }, 404);
      parentId = dir.id;
    }

    const node = await db.findChild(userId, parentId, session.filename);
    const fileNode = node && node.type === 'file' ? node : await db.createFile(userId, parentId, session.filename, ts);
    if (node && node.type === 'folder') {
      await storage.deleteDeployment(user.pagesData, deploy.deploymentId).catch(() => {});
      return c.json({ error: `目标位置已存在同名文件夹: ${session.filename}` }, 409);
    }

    const version = await db.addVersion({
      fileId: fileNode.id,
      size: session.totalSize,
      createdAt: ts,
      name: null,
      shotAt: null,
      deployUrl: deploy.baseUrl,
      deploymentId: deploy.deploymentId,
      isVideo: isVideoFile(session.filename),
      duration: null,
      resolution: null,
      chunkCount: session.totalChunks,
    });
    await db.addChunks(version.id, chunks);
    await db.updateModified(fileNode.id, ts);

    // 清理 KV 分片 + 标记任务完成
    await Promise.all(chunks.map((_, i) => kv.delete(kvChunkKey(userId, uploadId, i))));
    await db.updateUploadSessionStatus(userId, uploadId, 'done');

    return c.json({ ok: true, fileId: fileNode.id, versionId: version.id, deployUrl: deploy.baseUrl, chunkCount: session.totalChunks }, 201);
  });

  // 方式三：CLI 已完成分块部署，此处注册元数据（保留兼容）
  const registerSchema = z.object({
    filename: z.string().min(1).max(255),
    remotePath: z.string().min(1).max(1024),
    baseUrl: z.string().url(),
    deploymentId: z.string().min(1),
    size: z.number().int().nonnegative(),
    paths: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
    shotAt: z.string().datetime().nullable().optional(),
    isVideo: z.boolean().optional(),
    duration: z.number().nullable().optional(),
    resolution: z.string().nullable().optional(),
  });

  app.post('/register', zValidator('json', registerSchema), async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const body = c.req.valid('json');

    const parts = body.remotePath.split('/').filter(Boolean);
    let parentId: number | null = null;
    for (const part of parts) {
      const dir = await db.findChild(userId, parentId, part);
      if (!dir || dir.type !== 'folder') return c.json({ error: `目录不存在: ${body.remotePath}` }, 404);
      parentId = dir.id;
    }

    const ts = new Date().toISOString();
    const node = await db.findChild(userId, parentId, body.filename);
    if (node && node.type === 'folder') {
      return c.json({ error: `目标位置已存在同名文件夹: ${body.filename}` }, 409);
    }
    const fileNode = node ?? (await db.createFile(userId, parentId, body.filename, ts));

    const version = await db.addVersion({
      fileId: fileNode.id,
      size: body.size,
      createdAt: ts,
      name: null,
      shotAt: body.shotAt ?? null,
      deployUrl: body.baseUrl,
      deploymentId: body.deploymentId,
      isVideo: body.isVideo ?? false,
      duration: body.duration ?? null,
      resolution: body.resolution ?? null,
      chunkCount: body.paths.length,
    });
    await db.addChunks(version.id, body.paths.map((p, i) => ({ index: i, path: p.path, size: p.size })));
    await db.updateModified(fileNode.id, ts);

    return c.json({ ok: true, fileId: fileNode.id, versionId: version.id, baseUrl: body.baseUrl }, 201);
  });

  return app;
}

// ============================================================
// 辅助
// ============================================================

async function fetchUploadJwt(env: Env, projectName: string): Promise<string> {
  const res = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}/upload-token`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
  );
  if (!res.ok) throw new Error(`获取 upload-token 失败: HTTP ${res.status}`);
  const jwt = ((await res.json()) as { result?: { jwt?: string } }).result?.jwt;
  if (!jwt) throw new Error('upload-token 响应缺少 jwt');
  return jwt;
}

/** 生产：用已上传资产创建 deployment（upsert-hashes + manifest） */
async function createDeploymentProxy(env: Env, projectName: string, assets: { path: string; hash: string }[]): Promise<{ baseUrl: string; deploymentId: string; paths: string[] }> {
  const jwt = await fetchUploadJwt(env, projectName);
  const hashes = assets.map((a) => a.hash);
  const upsert = await fetch(`${CF_API}/pages/assets/upsert-hashes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes }),
  });
  if (!upsert.ok) throw new Error(`upsert-hashes 失败: HTTP ${upsert.status}`);

  const manifest: Record<string, string> = {};
  for (const a of assets) manifest[a.path.startsWith('/') ? a.path : `/${a.path}`] = a.hash;
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('branch', 'main');
  const depRes = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}/deployments`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, body: form },
  );
  if (!depRes.ok) throw new Error(`创建 deployment 失败: HTTP ${depRes.status} ${await depRes.text()}`);
  const dep = (await depRes.json()) as { result?: { id?: string; url?: string } };
  const url = dep.result?.url ? new URL(dep.result.url).origin : '';
  return { baseUrl: url, deploymentId: dep.result?.id || '', paths: assets.map((a) => a.path) };
}

/** 测试模式：从请求体（Pages JSON 数组）提取首个资产内容 */
async function extractBodyForTest(raw: Request): Promise<{ content: Uint8Array }> {
  const body = await raw.json() as { key: string; value: string; metadata?: { contentType?: string }; base64?: boolean }[];
  const first = body[0];
  if (!first || !first.value) throw new Error('body 缺少资产内容');
  // value 是 base64
  const bin = atob(first.value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { content: bytes };
}

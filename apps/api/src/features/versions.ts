// 版本管理（cv/rv）+ 下载 + 播放 + 搜索
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { cleanVersionsSchema, renameVersionSchema } from '@cloudfiles/shared';
import type { AppEnv, Env } from '../env';
import { createDb } from './context';
import { resolvePath } from './auth';
import { getStorage } from './storage';

export function versionRoutes() {
  const app = new Hono<AppEnv>();

  // 版本列表 ?path=/file.txt
  app.get('/versions', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const path = c.req.query('path');
    if (!path) return c.json({ error: '缺少 path' }, 400);
    const found = await resolvePath(db, userId, path);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${path}` }, 404);
    const versions = await db.listVersions(found.node.id);
    return c.json({
      path,
      versions: versions.map((v) => ({
        id: v.id, size: v.size, createdAt: v.createdAt, name: v.name, shotAt: v.shotAt,
        isVideo: v.isVideo, duration: v.duration, resolution: v.resolution, chunkCount: v.chunkCount,
      })),
    });
  });

  // 下载地址 ?path=/file.txt&versionId=可选 → 返回各分块完整 URL
  app.get('/download', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const storage = getStorage(c.env);
    const path = c.req.query('path');
    const versionId = c.req.query('versionId') ? Number(c.req.query('versionId')) : undefined;
    if (!path) return c.json({ error: '缺少 path' }, 400);

    const found = await resolvePath(db, userId, path);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${path}` }, 404);

    let version = null;
    if (versionId) {
      version = await db.getVersion(versionId);
      if (!version || version.fileId !== found.node.id) return c.json({ error: '版本不存在' }, 404);
    } else {
      const versions = await db.listVersions(found.node.id);
      version = versions[0] ?? null;
    }
    if (!version) return c.json({ error: '文件暂无版本' }, 404);

    const mem = db as unknown as { chunks?: Map<number, { chunk_index: number; path: string; size: number }[]> };
    const chunks = mem.chunks ? mem.chunks.get(version.id) ?? [] : await fetchChunksFromD1(db, version.id);
    const urls = chunks.map((ch) => ({
      index: ch.chunk_index,
      path: ch.path,
      size: ch.size,
      url: storage.buildFileUrl(version.deployUrl, ch.path),
    }));

    return c.json({
      filename: found.node.name,
      versionId: version.id,
      createdAt: version.createdAt,
      baseUrl: version.deployUrl,
      urls,
    });
  });

  // 代理下载 ?path=/file.txt&chunk=N（Worker 流式透传 Pages 子域名，绕开新项目域名传播延迟）
  // 不传 chunk → 拼接全部 chunk 返回完整文件（播放/预览用）；传 chunk=N → 返回指定分片（分片下载用）
  app.get('/raw', async (c) => {
    const db = createDb(c.env);
    const storage = getStorage(c.env);
    const userId = c.get('userId');
    const path = c.req.query('path');
    const chunkParam = c.req.query('chunk'); // 不传 = undefined / 传了 = 字符串
    const singleChunk = chunkParam != null ? Number(chunkParam) : null;
    if (!path) return c.json({ error: '缺少 path' }, 400);

    const found = await resolvePath(db, userId, path);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${path}` }, 404);

    const versions = await db.listVersions(found.node.id);
    const version = versions[0];
    if (!version) return c.json({ error: '文件暂无版本' }, 404);

    const mem = db as unknown as { chunks?: Map<number, { chunk_index: number; path: string; size: number }[]> };
    const chunks = mem.chunks ? mem.chunks.get(version.id) ?? [] : await fetchChunksFromD1(db, version.id);
    if (chunks.length === 0) return c.json({ error: '文件无分片数据' }, 500);

    // 单分片模式（指定 chunk=N）
    if (singleChunk != null) {
      if (singleChunk >= chunks.length) return c.json({ error: `分片索引越界: ${singleChunk}` }, 400);
      const ch = chunks[singleChunk];
      const res = await fetch(storage.buildFileUrl(version.deployUrl, ch.path));
      if (!res.ok) return c.json({ error: `代理下载失败: HTTP ${res.status}` }, 502);
      const headers = new Headers();
      const ct = res.headers.get('Content-Type');
      if (ct) headers.set('Content-Type', ct);
      return new Response(res.body, { status: 200, headers });
    }

    // 全量拼接模式（未指定 chunk → 流式拼接全部分片，播放/预览/下载用）
    const ext = found.node.name.split('.').pop()?.toLowerCase() || '';
    const ct = guessContentType(ext);
    const contentLength = chunks.reduce((s, c) => s + c.size, 0);

    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < chunks.length; i++) {
          const ch = chunks[i];
          try {
            const res = await fetch(storage.buildFileUrl(version.deployUrl, ch.path));
            if (!res.ok || !res.body) {
              controller.error(new Error(`分片 ${i} 下载失败: HTTP ${res.status}`));
              return;
            }
            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } catch (e) {
            controller.error(e);
            return;
          }
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Content-Length': String(contentLength),
        'Accept-Ranges': 'bytes',
      },
    });
  });

  // 播放地址（视频/音频流）?path=&versionId=
  app.get('/play', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const path = c.req.query('path');
    if (!path) return c.json({ error: '缺少 path' }, 400);
    const found = await resolvePath(db, userId, path);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${path}` }, 404);

    const ext = found.node.name.split('.').pop()?.toLowerCase() || '';
    const isVideo = ['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(ext);
    if (!isVideo) return c.json({ error: '该文件类型不支持流式播放' }, 400);

    const versions = await db.listVersions(found.node.id);
    const version = versions[0];
    if (!version) return c.json({ error: '文件暂无版本' }, 404);

    // 检测是否有 HLS 分片（chunks 含 .m3u8 → HLS 流播放）
    const mem = db as unknown as { chunks?: Map<number, { chunk_index: number; path: string; size: number }[]> };
    const chunks = mem.chunks ? mem.chunks.get(version.id) ?? [] : await fetchChunksFromD1(db, version.id);
    const hasHls = chunks.some((ch) => ch.path.endsWith('.m3u8'));

    if (hasHls) {
      return c.json({
        filename: found.node.name,
        protocol: 'hls',
        manifestUrl: `${version.deployUrl}/index.m3u8`,
        library: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
      });
    }

    // mp4 直出：通过代理端点流式播放
    if (ext === 'mp4' || ext === 'webm') {
      return c.json({
        filename: found.node.name,
        protocol: 'raw',
        manifestUrl: `/api/files/raw?path=${encodeURIComponent(path)}`,
      });
    }

    // 其他格式不支持流式播放
    return c.json({ error: '该文件类型不支持流式播放' }, 400);
  });

  // 清理版本（cv）：body { filePath?, target? }；filePath 必填（全盘清理 Phase 1）
  app.post('/versions/clean', zValidator('json', cleanVersionsSchema), async (c) => {
    const db = createDb(c.env);
    const storage = getStorage(c.env);
    const userId = c.get('userId');
    const { filePath, target } = c.req.valid('json');
    if (!filePath) return c.json({ error: 'MVP 阶段请指定 filePath' }, 400);

    const found = await resolvePath(db, userId, filePath);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${filePath}` }, 404);

    const user = await db.findUserById(userId);
    if (!user) return c.json({ error: '用户不存在' }, 404);

    const versions = await db.listVersions(found.node.id);
    let removed = 0;
    for (const v of versions) {
      const isTarget = target ? v.createdAt === target : false;
      const isOldest = !target && versions.indexOf(v) !== 0; // 保留最新（index 0）
      if (!isTarget && !isOldest) continue;
      await db.deleteVersion(v.id);
      await storage.deleteDeployment(user.pagesData, v.deploymentId).catch(() => {});
      removed++;
    }
    return c.json({ ok: true, removed });
  });

  // 版本命名（rv）：body { filePath, createdAt, name? }，name 空则移除
  app.post('/versions/rename', zValidator('json', renameVersionSchema), async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const { filePath, createdAt, name } = c.req.valid('json');
    const found = await resolvePath(db, userId, filePath);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${filePath}` }, 404);

    const versions = await db.listVersions(found.node.id);
    const target = versions.find((v) => v.createdAt === createdAt);
    if (!target) return c.json({ error: `未找到版本 ${createdAt}` }, 404);

    await db.renameVersion(target.id, name && name.trim() !== '' ? name.trim() : null);
    return c.json({ ok: true });
  });

  // 全局搜索 ?q=
  app.get('/search', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const q = c.req.query('q')?.trim();
    if (!q) return c.json({ error: '缺少 q' }, 400);
    const results = await db.searchByName(userId, q);
    return c.json({ q, results });
  });

  return app;
}

// D1 路径下查询 chunks（与 Memory 的 Map 区分）
async function fetchChunksFromD1(db: ReturnType<typeof createDb>, versionId: number) {
  const d1 = db as unknown as { db?: D1Database };
  if (!d1.db) return [];
  const rows = await d1.db.prepare('SELECT * FROM chunks WHERE version_id = ? ORDER BY chunk_index ASC').bind(versionId).all<{ chunk_index: number; path: string; size: number }>();
  return rows.results ?? [];
}

function guessContentType(ext: string): string {
  const m: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', json: 'application/json',
  };
  return m[ext] ?? 'application/octet-stream';
}

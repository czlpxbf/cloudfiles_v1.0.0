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

    // 单分片文件（≤24MB）：Pages 部署 URL 的 Range 支持不稳定，回退到全量流式
    if (chunks.length === 1) {
      const ch = chunks[0];
      const ext = found.node.name.split('.').pop()?.toLowerCase() || '';
      const res = await fetch(storage.buildFileUrl(version.deployUrl, ch.path));
      if (!res.ok || !res.body) return c.json({ error: `代理下载失败: HTTP ${res.status}` }, 502);
      return new Response(res.body, {
        status: 200,
        headers: {
          'Content-Type': guessContentType(ext),
          'Content-Length': String(ch.size),
        },
      });
    }

    // 多分片拼接 / Range 请求模式
    const ext = found.node.name.split('.').pop()?.toLowerCase() || '';
    const contentLength = chunks.reduce((s, c) => s + c.size, 0);
    const ct = guessContentType(ext);

    // 构建 chunk → 累计字节偏移（用于 Range 定位）
    const offsets: number[] = [];
    let cum = 0;
    for (const ch of chunks) { offsets.push(cum); cum += ch.size; }

    // 解析 Range 请求头
    const rangeHeader = c.req.header('Range');
    let rangeStart = 0;
    let rangeEnd = contentLength - 1;
    let isRange = false;

    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        rangeStart = parseInt(m[1], 10);
        rangeEnd = m[2] ? parseInt(m[2], 10) : contentLength - 1;
        if (rangeStart < contentLength && rangeEnd >= rangeStart) {
          isRange = true;
        } else {
          rangeStart = 0; rangeEnd = contentLength - 1;
        }
      }
    }

    // 找到 Range 覆盖的 chunk 范围
    let firstChunkIdx = 0, lastChunkIdx = chunks.length - 1;
    let skipBytes = 0, takeBytesInLast = chunks[lastChunkIdx]?.size ?? 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunkEnd = offsets[i] + chunks[i].size - 1;
      if (rangeStart >= offsets[i] && rangeStart <= chunkEnd) {
        firstChunkIdx = i;
        skipBytes = rangeStart - offsets[i];
      }
      if (rangeEnd >= offsets[i] && rangeEnd <= chunkEnd) {
        lastChunkIdx = i;
        takeBytesInLast = rangeEnd - offsets[i] + 1;
      }
    }

    const stream = new ReadableStream({
      async start(controller) {
        for (let i = firstChunkIdx; i <= lastChunkIdx; i++) {
          const ch = chunks[i];
          try {
            // 透传 Range 到 Pages CDN（避免拉整个 24MB 分片）
            const fetchHeaders = new Headers();
            let readerTake = ch.size;

            if (i === firstChunkIdx && i === lastChunkIdx) {
              // 单分片：同时处理首尾
              if (skipBytes > 0 || takeBytesInLast < ch.size) {
                const end = skipBytes + takeBytesInLast - 1;
                fetchHeaders.set('Range', `bytes=${skipBytes}-${end}`);
                readerTake = takeBytesInLast;
              }
            } else if (i === firstChunkIdx && skipBytes > 0) {
              fetchHeaders.set('Range', `bytes=${skipBytes}-`);
            } else if (i === lastChunkIdx && takeBytesInLast < ch.size) {
              fetchHeaders.set('Range', `bytes=0-${takeBytesInLast - 1}`);
              readerTake = takeBytesInLast;
            }

            const res = await fetch(storage.buildFileUrl(version.deployUrl, ch.path), { headers: fetchHeaders });
            if (!res.ok || !res.body) {
              controller.error(new Error(`分片 ${i} 下载失败: HTTP ${res.status}`));
              return;
            }
            const reader = res.body.getReader();
            let chunkRead = 0;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              let bytes = value;

              if (i === lastChunkIdx) {
                const remaining = readerTake - chunkRead;
                if (remaining <= 0) break;
                if (bytes.length > remaining) bytes = bytes.subarray(0, remaining);
              }

              chunkRead += bytes.length;
              controller.enqueue(bytes);
            }
          } catch (e) {
            controller.error(e);
            return;
          }
        }
        controller.close();
      },
    });

    if (isRange) {
      const rangeLen = rangeEnd - rangeStart + 1;
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': ct,
          'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${contentLength}`,
          'Content-Length': String(rangeLen),
          'Accept-Ranges': 'bytes',
        },
      });
    }

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

  // 缩略图代理（通过 MediaDo 提取）?path=/image.jpg
  app.get('/thumbnail', async (c) => {
    const db = createDb(c.env);
    const storage = getStorage(c.env);
    const userId = c.get('userId');
    const path = c.req.query('path');
    if (!path) return c.json({ error: '缺少 path' }, 400);

    const found = await resolvePath(db, userId, path);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${path}` }, 404);

    const versions = await db.listVersions(found.node.id);
    const version = versions[0];
    if (!version) return c.json({ error: '文件暂无版本' }, 404);

    // 通过 MediaDo 获取缩略图（异步但不阻塞——直接返回原图 URL 兜底）
    try {
      const mem = db as unknown as { chunks?: Map<number, { chunk_index: number; path: string; size: number }[]> };
      const chunks = mem.chunks ? mem.chunks.get(version.id) ?? [] : await fetchChunksFromD1(db, version.id);
      const fileUrl = chunks.length > 0 ? storage.buildFileUrl(version.deployUrl, chunks[0].path) : version.deployUrl;

      const doId = c.env.MEDIA_DO.newUniqueId();
      const stub = c.env.MEDIA_DO.get(doId);
      const res = await stub.fetch('https://do/metadata', {
        method: 'POST',
        body: JSON.stringify({ url: fileUrl, contentType: guessContentType(path.split('.').pop() || '') }),
      });
      if (res.ok) {
        const data = await res.json() as { thumbnail?: string; width?: number; height?: number };
        if (data.thumbnail) return c.json({ thumbnail: data.thumbnail, width: data.width, height: data.height });
      }
    } catch {
      // MediaDo 不可用 → 返回原图 URL 让前端直接渲染
    }

    return c.json({ thumbnail: null, fallbackUrl: `${version.deployUrl}/${found.node.name}` });
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

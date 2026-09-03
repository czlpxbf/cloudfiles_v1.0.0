// MediaDo — 服务端媒体元数据提取 / 缩略图生成
//
// 背景：浏览器端 ffmpeg.wasm 对大视频完全不可行（535MB 视频 30-60 分钟）。
// DO 有 30s CPU 配额，可处理小文件（<50MB）的元数据和缩略图。
// 大文件暂跳过，标记为待 CLI/外部服务处理。
//
// 用法：
//   const stub = env.MEDIA_DO.get(env.MEDIA_DO.newUniqueId());
//   await stub.fetch(new Request("https://do/metadata", {
//     method: "POST", body: JSON.stringify({ url, contentType })
//   }));
import { DurableObject } from 'cloudflare:workers';

interface MediaRequest {
  url: string;        // 文件下载 URL
  contentType?: string; // 文件 MIME 类型
}

interface MetadataResult {
  width?: number;
  height?: number;
  duration?: number;
  codec?: string;
  format?: string;
  thumbnail?: string; // base64 图片
}

export class MediaDo extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/metadata') {
      const { url: fileUrl, contentType } = await request.json() as MediaRequest;
      if (!fileUrl) return Response.json({ error: '缺少 url' }, { status: 400 });

      try {
        // 下载文件到 DO 内存（限制：小文件 <50MB）
        const res = await fetch(fileUrl);
        if (!res.ok) return Response.json({ error: `下载失败: HTTP ${res.status}` }, { status: 502 });

        const contentLength = Number(res.headers.get('Content-Length') || 0);
        if (contentLength > 50 * 1024 * 1024) {
          return Response.json({
            skipped: true,
            reason: `文件过大 (${Math.round(contentLength / 1024 / 1024)}MB)，跳过服务端提取`,
          });
        }

        const result: MetadataResult = {};

        // 图片：提取尺寸
        if (contentType?.startsWith('image/') || fileUrl.match(/\.(jpg|jpeg|png|webp|gif)$/i)) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          // 简单画像提取（JPEG/PNG 头部解析），完整实现以后再补
          if (contentType === 'image/jpeg' || fileUrl.match(/\.jpe?g$/i)) {
            const { width, height } = parseJpegDimensions(bytes);
            result.width = width ?? undefined;
            result.height = height ?? undefined;
            result.format = 'jpeg';
          } else if (contentType === 'image/png' || fileUrl.match(/\.png$/i)) {
            const { width, height } = parsePngDimensions(bytes);
            result.width = width ?? undefined;
            result.height = height ?? undefined;
            result.format = 'png';
          }
        }

        // 视频：标记为视频类型（详细元数据需要 ffmpeg，后续扩展）
        if (contentType?.startsWith('video/') || fileUrl.match(/\.(mp4|webm|mkv|mov|avi)$/i)) {
          result.format = contentType?.split('/')[1] || 'unknown';
        }

        return Response.json({ ok: true, ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: `提取失败: ${msg}` }, { status: 500 });
      }
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

// ---- 简单 JPEG 尺寸解析（不依赖第三方库） ----
function parseJpegDimensions(bytes: Uint8Array): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset < bytes.length - 8) {
    if (bytes[offset] !== 0xFF) return { width: null, height: null };
    const marker = bytes[offset + 1];
    if (marker === 0xDA) break; // SOS — 数据开始
    if (marker === 0xC0 || marker === 0xC2) {
      // SOF0 / SOF2 — 包含尺寸
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 2 + len;
  }
  return { width: null, height: null };
}

// ---- 简单 PNG 尺寸解析 ----
function parsePngDimensions(bytes: Uint8Array): { width: number | null; height: number | null } {
  if (bytes.length < 24) return { width: null, height: null };
  // IHDR 在偏移 16 处（8 字节签名 + 4 字节长度 + 4 字节 IHDR）
  return {
    width: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
    height: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23],
  };
}

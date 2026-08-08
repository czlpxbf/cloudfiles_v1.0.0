// 分享链接：创建 / 公开访问（只读，token 即密钥）
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../env';
import { createDb } from './context';
import { resolvePath } from './auth';
import { getStorage } from './storage';

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function shareRoutes() {
  const app = new Hono<AppEnv>();

  const createSchema = z.object({
    filePath: z.string().min(1).max(1024),
    versionId: z.number().int().positive().optional(),
    expiresInHours: z.number().int().min(1).max(720).optional(),
  });

  // 创建分享（需登录）
  app.post('/shares', zValidator('json', createSchema), async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const { filePath, versionId, expiresInHours } = c.req.valid('json');

    const found = await resolvePath(db, userId, filePath);
    if (!found?.node || found.node.type !== 'file') return c.json({ error: `文件不存在: ${filePath}` }, 404);

    const share = await db.createShare({
      userId,
      fileId: found.node.id,
      token: randomToken(),
      versionId: versionId ?? null,
      expiresAt: expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000).toISOString() : null,
    });
    return c.json({ token: share.token, expiresAt: share.expiresAt }, 201);
  });

  // 我的分享列表
  app.get('/shares', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const shares = await db.listShares(userId);
    const out = await Promise.all(
      shares.map(async (s) => {
        const f = await db.getNodeById(s.fileId);
        return { token: s.token, fileName: f?.name ?? '(已删除)', createdAt: s.createdAt, expiresAt: s.expiresAt };
      }),
    );
    return c.json({ shares: out });
  });

  // 删除分享
  app.delete('/shares/:token', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    await db.deleteShare(userId, c.req.param('token'));
    return c.json({ ok: true });
  });

  // 公开访问（无需登录）：返回文件下载 URL 列表
  app.get('/s/:token', async (c) => {
    const db = createDb(c.env);
    const storage = getStorage(c.env);
    const token = c.req.param('token');
    const share = await db.findShareByToken(token);
    if (!share) return c.json({ error: '分享不存在或已失效' }, 404);
    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
      return c.json({ error: '分享已过期' }, 410);
    }

    const file = await db.getNodeById(share.fileId);
    if (!file || file.type !== 'file') return c.json({ error: '文件已被删除' }, 410);

    let version = share.versionId ? await db.getVersion(share.versionId) : null;
    if (!version) {
      const versions = await db.listVersions(file.id);
      version = versions[0] ?? null;
    }
    if (!version) return c.json({ error: '文件暂无版本' }, 404);

    const mem = db as unknown as { chunks?: Map<number, { chunk_index: number; path: string; size: number }[]> };
    const chunks = mem.chunks ? mem.chunks.get(version.id) ?? [] : await fetchChunks(db, version.id);
    const urls = chunks.map((ch) => ({ index: ch.chunk_index, path: ch.path, size: ch.size, url: storage.buildFileUrl(version!.deployUrl, ch.path) }));

    return c.json({ fileName: file.name, sharedAt: share.createdAt, urls });
  });

  return app;
}

async function fetchChunks(db: ReturnType<typeof createDb>, versionId: number) {
  const d1 = db as unknown as { db?: D1Database };
  if (!d1.db) return [];
  const rows = await d1.db.prepare('SELECT * FROM chunks WHERE version_id = ? ORDER BY chunk_index ASC').bind(versionId).all<{ chunk_index: number; path: string; size: number }>();
  return rows.results ?? [];
}

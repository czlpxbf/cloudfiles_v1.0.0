// 文件系统：list / mkdir / rm / mv
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { mkdirSchema, removeSchema, moveSchema } from '@cloudfiles/shared';
import type { AppEnv, Env } from '../env';
import { createDb } from './context';
import { resolvePath } from './auth';

export function fileRoutes() {
  const app = new Hono<AppEnv>();

  // 列出目录（?path=/xxx 或省略 = 根）
  app.get('/list', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const path = (c.req.query('path') || '/').trim();
    const parts = path.split('/').filter(Boolean);

    let parentId: number | null = null;
    for (const part of parts) {
      const child = await db.findChild(userId, parentId, part);
      if (!child || child.type !== 'folder') return c.json({ error: `目录不存在: ${path}` }, 404);
      parentId = child.id;
    }

    const children = await db.listChildren(userId, parentId);
    const out = await Promise.all(
      children.map(async (f) => {
        const versions = f.type === 'file' ? await db.listVersions(f.id) : [];
        return {
          id: f.id,
          name: f.name,
          type: f.type,
          createdAt: f.createdAt,
          modifiedAt: f.modifiedAt,
          versions: versions.map((v) => ({
            id: v.id, size: v.size, createdAt: v.createdAt, name: v.name,
            shotAt: v.shotAt, isVideo: v.isVideo, duration: v.duration, resolution: v.resolution,
          })),
        };
      }),
    );
    return c.json({ path, children: out });
  });

  // mkdir /new/folder（可递归创建）
  app.post('/folder', zValidator('json', mkdirSchema), async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const path = c.req.valid('json').path;
    const ts = new Date().toISOString();
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return c.json({ error: '路径无效' }, 400);

    let parentId: number | null = null;
    for (const part of parts) {
      let child = await db.findChild(userId, parentId, part);
      if (!child) {
        child = await db.createFolder(userId, parentId, part, ts);
      } else if (child.type !== 'folder') {
        return c.json({ error: `路径冲突：${part} 已存在且不是文件夹` }, 409);
      }
      parentId = child.id;
    }
    return c.json({ ok: true, path });
  });

  // rm /path（文件或文件夹，级联删除）
  app.post('/remove', zValidator('json', removeSchema), async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const path = c.req.valid('json').path;
    const found = await resolvePath(db, userId, path);
    if (!found?.node) return c.json({ error: `路径不存在: ${path}` }, 404);
    await db.deleteNode(found.node.id);
    return c.json({ ok: true });
  });

  // mv /src /dest（移动或重命名）
  app.post('/move', zValidator('json', moveSchema), async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const { src, dest } = c.req.valid('json');

    const srcRes = await resolvePath(db, userId, src);
    if (!srcRes?.node) return c.json({ error: `源路径不存在: ${src}` }, 404);
    const node = srcRes.node;

    // 目标自身移动无意义，拒绝
    if (src === dest) return c.json({ error: '源与目标相同' }, 409);

    // 解析目标：/a/b/c → 父目录 /a/b + 新名 c
    const destParts = dest.split('/').filter(Boolean);
    if (destParts.length === 0) return c.json({ error: '目标路径无效' }, 400);
    const newName = destParts[destParts.length - 1];
    const parentParts = destParts.slice(0, -1);

    let targetParentId: number | null = null;
    for (const part of parentParts) {
      const p = await db.findChild(userId, targetParentId, part);
      if (!p || p.type !== 'folder') return c.json({ error: `目标父目录不存在: /${parentParts.join('/')}` }, 404);
      targetParentId = p.id;
    }

    // 目标同名冲突检查
    if (node.parentId !== targetParentId || node.name !== newName) {
      const conflict = await db.findChild(userId, targetParentId, newName);
      if (conflict) return c.json({ error: `目标已存在: ${dest}` }, 409);
    }

    await db.moveNode(node.id, targetParentId, newName, new Date().toISOString());
    return c.json({ ok: true });
  });

  return app;
}

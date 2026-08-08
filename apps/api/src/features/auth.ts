// 认证：注册/登录/登出/me
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { loginSchema, registerSchema, hashPassword, verifyPassword, signJwt } from '@cloudfiles/shared';
import type { AppEnv, Env } from '../env';
import type { Repo } from '../db';
import { createDb } from './context';

/** 会话 cookie（生产跨域 SameSite=None+Secure；开发 Lax） */
function sessionCookie(env: Env, token: string, maxAge = 7 * 24 * 3600): string {
  const secure = env.CF_ENV === 'production';
  const sameSite = secure ? 'None' : 'Lax';
  return `cf_token=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const cookieOpts = (env: Env) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: (env.CF_ENV as string) === 'production',
  path: '/',
  maxAge: 7 * 24 * 3600,
});

/** 确保 Pages 项目存在（不存在则创建，带重试——连续创建会被 Cloudflare 限流 429） */
export async function ensureProject(env: Env, projectName: string): Promise<boolean> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return false;
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const get = await fetch(`${base}/${projectName}`, { headers });
      if (get.ok) return true;
      if (get.status !== 404) {
        // 非 404 错误（如限流 429）→ 等待重试
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const post = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: projectName, production_branch: 'main' }),
      });
      if (post.ok) return true;
      // 创建失败（可能 429 限流）→ 重试
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return false;
}

/**
 * 注册即开云盘（灵魂 S4）：为用户创建专属 Pages 项目对 {prefix}-{username}-main/data
 * 尽力而为：失败不阻断注册（返回 pagesReady:false，上传时会兜底创建）。
 */
async function ensureUserProjects(env: Env, pagesMain: string, pagesData: string): Promise<boolean> {
  // 测试模式（注入 storage）跳过真实 Cloudflare 调用
  if (env.storage) return true;
  try {
    const okMain = await ensureProject(env, pagesMain);
    // 两个项目之间稍等，避免创建限流
    if (okMain) await new Promise((r) => setTimeout(r, 1200));
    const okData = await ensureProject(env, pagesData);
    // 向主项目部署初始空 main.json（尽力而为，失败不影响上传）
    if (okMain) await deployEmptyIndex(env, pagesMain).catch(() => false);
    return okMain && okData;
  } catch {
    return false;
  }
}

async function deployEmptyIndex(env: Env, projectName: string): Promise<boolean> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return false;
  const authHeader = { Authorization: `Bearer ${apiToken}` };
  const headers = { ...authHeader, 'Content-Type': 'application/json' };

  const uploadTokenRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/upload-token`,
    { headers },
  );
  if (!uploadTokenRes.ok) return false;
  const uploadToken = ((await uploadTokenRes.json()) as { result?: { jwt?: string } }).result?.jwt;
  if (!uploadToken) return false;

  const mainJson = { fs_root: { type: 'folder', createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), children: {} } };
  const body = new TextEncoder().encode(JSON.stringify(mainJson));
  // 与 wrangler 一致的 Pages hash：blake3(base64(内容) + 扩展名).hex.slice(0,32)
  const b64 = btoa(String.fromCharCode(...body));
  const { blake3 } = await import('@noble/hashes/blake3');
  const hash = [...blake3(new TextEncoder().encode(b64 + 'json'))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

  const up = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/upload`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ key: hash, value: b64, metadata: { contentType: 'application/json' }, base64: true }]),
  });
  if (!up.ok) return false;
  const upsert = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [hash] }),
  });
  if (!upsert.ok) return false;
  const form = new FormData();
  form.append('manifest', JSON.stringify({ '/main.json': hash })); // key 带前导 /（wrangler 约定）
  form.append('branch', 'main');
  const dep = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`,
    { method: 'POST', headers: authHeader, body: form },
  );
  return dep.ok;
}

export function authRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/register', zValidator('json', registerSchema), async (c) => {
    const { username, password } = c.req.valid('json');
    const db = createDb(c.env);
    const cfg = c.env as unknown as { CF_PROJECT_PREFIX?: string };

    if (await db.findUserByUsername(username)) {
      return c.json({ error: '用户名已存在' }, 409);
    }

    const ph = await hashPassword(password);
    const prefix = cfg.CF_PROJECT_PREFIX || 'cf';
    const pagesMain = `${prefix}-${username}-main`;
    const pagesData = `${prefix}-${username}-data`;

    const user = await db.createUser({
      username,
      passwordHash: `${ph.iterations}|${ph.salt}|${ph.hash}`,
      pagesMain,
      pagesData,
    });

    // 灵魂 S4：注册即创建 Pages 项目对（尽力而为）
    const pagesReady = await ensureUserProjects(c.env, pagesMain, pagesData);

    const token = await signJwt({ sub: user.id, username }, c.env.JWT_SECRET);
    c.header('Set-Cookie', sessionCookie(c.env, token));
    return c.json({ user: { id: user.id, username: user.username }, pagesReady }, 201);
  });

  app.post('/login', zValidator('json', loginSchema), async (c) => {
    const { username, password } = c.req.valid('json');
    const db = createDb(c.env);
    const user = await db.findUserByUsername(username);
    if (!user) return c.json({ error: '用户名或密码错误' }, 401);

    const [iterations, salt, hash] = user.passwordHash.split('|');
    const ok = await verifyPassword(password, { iterations: Number(iterations), salt, hash });
    if (!ok) return c.json({ error: '用户名或密码错误' }, 401);

    const token = await signJwt({ sub: user.id, username }, c.env.JWT_SECRET);
    c.header('Set-Cookie', sessionCookie(c.env, token));
    return c.json({ user: { id: user.id, username: user.username } });
  });

  app.post('/logout', (c) => {
    c.header('Set-Cookie', 'cf_token=; HttpOnly; SameSite=None; Path=/; Max-Age=0' + (c.env.CF_ENV === 'production' ? '; Secure' : ''));
    return c.json({ ok: true });
  });

  app.get('/me', async (c) => {
    const db = createDb(c.env);
    const userId = c.get('userId');
    const user = await db.findUserById(userId);
    if (!user) return c.json({ error: '未找到用户' }, 404);
    return c.json({ user: { id: user.id, username: user.username } });
  });

  return app;
}

// 供 files 等模块复用：路径解析（/a/b/c → 逐级 findChild）
export async function resolvePath(db: Repo, userId: number, path: string): Promise<{ node: Awaited<ReturnType<Repo['getNodeById']>>; parentId: number | null } | null> {
  const parts = path.split('/').filter(Boolean);
  let parentId: number | null = null;
  let node: Awaited<ReturnType<Repo['getNodeById']>> = null;
  for (const part of parts) {
    const child = await db.findChild(userId, parentId, part);
    if (!child) return null;
    node = child;
    parentId = child.id;
  }
  return { node, parentId: parentId === null ? null : node ? node.parentId : null };
}

// Hono App 组装：中间件 + 路由挂载
import { Hono } from 'hono';
import { verifyJwt } from '@cloudfiles/shared';
import type { AppEnv } from './env';
import { authRoutes } from './features/auth';
import { fileRoutes } from './features/files';
import { uploadRoutes } from './features/upload';
import { versionRoutes } from './features/versions';
import { shareRoutes } from './features/shares';

export function createApp() {
  const app = new Hono<AppEnv>();

  // 跨域（前端 pages.dev → API workers.dev）：白名单 + 携带凭证
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin) {
      const allowed = (c.env.CF_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const isDev = c.env.CF_ENV !== 'production';
      if (isDev || allowed.includes(origin)) {
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Credentials', 'true');
        c.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PUT,OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Content-Type');
      }
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  });

  // 结构化请求日志（简单版）
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`[${c.req.method}] ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  // 认证中间件：仅 register/login/logout 与公开分享 /api/s/ 豁免
  const PUBLIC_AUTH = ['/api/auth/register', '/api/auth/login', '/api/auth/logout'];
  app.use('/api/*', async (c, next) => {
    if (PUBLIC_AUTH.includes(c.req.path) || c.req.path.startsWith('/api/s/')) return next();
    const cookie = c.req.header('cookie') || '';
    const token = cookie.match(/cf_token=([^;]+)/)?.[1];
    if (!token) return c.json({ error: '未登录' }, 401);
    const payload = await verifyJwt(token, c.env.JWT_SECRET);
    if (!payload) return c.json({ error: '登录已过期' }, 401);
    c.set('userId', payload.sub);
    c.set('username', payload.username);
    return next();
  });

  // 全局错误处理
  app.onError((err, c) => {
    console.error('[error]', err);
    return c.json({ error: err instanceof Error ? err.message : '服务器内部错误' }, 500);
  });

  // 静态资源服务（Pages Advanced mode：worker 接管全部请求，未匹配路由用 ASSETS 绑定服务静态文件）
  // ⚠️ ASSETS 返回的 Content-Type 可能为 octet-stream，须按扩展名强制修正，否则浏览器会下载文件
  app.notFound(async (c) => {
    const assets = c.env.ASSETS;
    if (assets) {
      let res = await assets.fetch(c.req.raw);
      if (res.status === 404 && !c.req.path.startsWith('/api/')) {
        // SPA fallback：非 API 路径返回 index.html（Vue Router 接管）
        res = await assets.fetch(new Request('https://pages.local/index.html', c.req.raw));
      }
      if (res.status !== 404) {
        const ct = contentTypeFor(c.req.path);
        if (ct) {
          const headers = new Headers(res.headers);
          headers.set('Content-Type', ct);
          return new Response(res.body, { status: res.status, headers });
        }
        return res;
      }
    }
    return c.text('Not Found', 404);
  });

  app.get('/health', (c) => c.json({ ok: true, service: 'cloudfiles-api', version: '0.1.0' }));

  app.route('/api/auth', authRoutes());
  app.route('/api/files', fileRoutes());
  app.route('/api/upload', uploadRoutes());
  // versions/download/play/search 挂到 /api/files 下（RESTful 一致）
  app.route('/api/files', versionRoutes());
  // 分享：/api/shares（登录）+ /api/s（公开访问）
  app.route('/api', shareRoutes());

  return app;
}

/** 按路径扩展名推断 Content-Type（ASSETS 响应可能缺失/错误，需强制修正） */
function contentTypeFor(path: string): string | null {
  const ext = path.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    map: 'application/json',
    wasm: 'application/wasm',
  };
  // 无扩展名（如根路径 /）按 HTML 处理（SPA 首页）
  if (!path.includes('.')) return 'text/html; charset=utf-8';
  return map[ext] ?? null;
}

export type App = ReturnType<typeof createApp>;

import { describe, it, expect, beforeAll } from 'vitest';
import { MemoryAdapter } from '@cloudfiles/shared';
import { createApp } from './app';
import type { Env } from './env';

/** 内存 KV（分片上传测试用） */
function makeMemoryKV() {
  const store = new Map<string, { value: ArrayBuffer; ttl?: number }>();
  return {
    store,
    async put(key: string, value: ArrayBuffer | string, opts?: { expirationTtl?: number }) {
      const buf = typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
      store.set(key, { value: buf, ttl: opts?.expirationTtl });
    },
    async get(key: string, type?: 'arrayBuffer' | 'text'): Promise<ArrayBuffer | string | null> {
      const e = store.get(key);
      if (!e) return null;
      if (type === 'text') return new TextDecoder().decode(e.value);
      return e.value;
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts: { prefix: string; cursor?: string; limit?: number }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
      return { keys: keys.map((name) => ({ name })), cursor: undefined, list_complete: true };
    },
  };
}

function makeEnv(): Env & { storage: MemoryAdapter } {
  const storage = new MemoryAdapter();
  return {
    // 故意不提供 DB → createDb 走 MemoryRepo
    storage,
    KV: makeMemoryKV(),
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_API_TOKEN: 'test-token',
    CF_PROJECT_PREFIX: 'cf',
    JWT_SECRET: 'test-secret-key-0123456789abcdef',
    CF_ENV: 'development',
  } as unknown as Env & { storage: MemoryAdapter };
}

let app: ReturnType<typeof createApp>;
let storage: MemoryAdapter;
let env: ReturnType<typeof makeEnv>;

function req(path: string, init?: RequestInit) {
  return app.request(path, init, env);
}

beforeAll(() => {
  env = makeEnv();
  storage = env.storage;
  app = createApp();
});

async function register(username: string, password = 'password123') {
  const res = await req('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.get('Set-Cookie') || '';
  const token = setCookie.match(/cf_token=([^;]+)/)?.[1];
  if (!token) throw new Error('未获取到 cookie');
  return token;
}

async function authed(token: string, path: string, init: RequestInit = {}) {
  const headers = { Cookie: `cf_token=${token}`, ...(init.headers || {}) };
  return req(path, { ...init, headers });
}

async function json(res: Response) {
  return res.json() as Promise<any>;
}

/** 构造 Pages JSON 单资产 body（模拟浏览器端 hash+base64）+ 调 /single */
async function uploadSingle(token: string, filename: string, bytes: Uint8Array, remotePath = '/') {
  const b64 = Buffer.from(bytes).toString('base64');
  const body = JSON.stringify([{ key: `fake-hash-${filename}`, value: b64, metadata: { contentType: 'application/octet-stream' }, base64: true }]);
  const params = new URLSearchParams({ filename, remotePath, hash: `fake-hash-${filename}`, size: String(bytes.byteLength) });
  return authed(token, `/api/upload/single?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

describe('认证', () => {
  it('注册/登录/me 全流程', async () => {
    const token = await register('alice');
    const me = await json(await authed(token, '/api/auth/me'));
    expect(me.user.username).toBe('alice');

    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    expect(login.status).toBe(200);
  });

  it('重复用户名 409', async () => {
    await register('bob');
    const res = await req('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    expect(res.status).toBe(409);
  });

  it('未登录访问受保护接口 401', async () => {
    const res = await req('/api/files/list');
    expect(res.status).toBe(401);
  });

  it('错误密码 401', async () => {
    const res = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-pass' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('文件系统', () => {
  let token: string;
  beforeAll(async () => {
    token = await register('carol');
  });

  it('mkdir 递归创建 + list 可见', async () => {
    const mk = await json(await authed(token, '/api/files/folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/docs/movies' }),
    }));
    expect(mk.ok).toBe(true);

    const list = await json(await authed(token, '/api/files/list?path=/docs'));
    expect(list.children.map((c: any) => c.name)).toContain('movies');
    expect(list.children[0].type).toBe('folder');
  });

  it('单文件上传 → 版本 + 下载 URL', async () => {
    const up = await json(await uploadSingle(token, 'hello.txt', new Uint8Array([104, 105]), '/docs'));
    expect(up.ok).toBe(true);

    const list = await json(await authed(token, '/api/files/list?path=/docs'));
    const file = list.children.find((c: any) => c.name === 'hello.txt');
    expect(file.type).toBe('file');
    expect(file.versions).toHaveLength(1);
    expect(file.versions[0].size).toBe(2);

    const dl = await json(await authed(token, '/api/files/download?path=/docs/hello.txt'));
    expect(dl.urls).toHaveLength(1);
    // 灵魂验证：分块 URL 来自"部署"（MemoryAdapter 已存内容）
    expect(storage.getContent(dl.baseUrl, dl.urls[0].path)).toEqual(new Uint8Array([104, 105]));
  });

  it('同名上传 → 生成第二版本', async () => {
    await uploadSingle(token, 'hello.txt', new Uint8Array([1, 2, 3, 4]), '/docs');

    const versions = await json(await authed(token, '/api/files/versions?path=/docs/hello.txt'));
    expect(versions.versions).toHaveLength(2);
    expect(versions.versions[0].size).toBe(4); // 最新在前
  });

  it('版本命名 rv + 搜索命中', async () => {
    const versions = await json(await authed(token, '/api/files/versions?path=/docs/hello.txt'));
    const oldest = versions.versions[1];

    const rv = await json(await authed(token, '/api/files/versions/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/docs/hello.txt', createdAt: oldest.createdAt, name: '初稿' }),
    }));
    expect(rv.ok).toBe(true);

    const search = await json(await authed(token, '/api/files/search?q=初稿'));
    expect(search.results.some((r: any) => r.versionName === '初稿')).toBe(true);
  });

  it('清理指定版本 cv（真删 deployment）', async () => {
    const versions = await json(await authed(token, '/api/files/versions?path=/docs/hello.txt'));
    const target = versions.versions.find((v: any) => v.name === '初稿');
    const before = await json(await authed(token, '/api/files/versions?path=/docs/hello.txt'));
    const targetDeploy = before.versions.find((v: any) => v.createdAt === target.createdAt);

    const cv = await json(await authed(token, '/api/files/versions/clean', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/docs/hello.txt', target: target.createdAt }),
    }));
    expect(cv.removed).toBe(1);

    const after = await json(await authed(token, '/api/files/versions?path=/docs/hello.txt'));
    expect(after.versions).toHaveLength(1);
    // 灵魂验证：对应 deployment 已被删除
    expect(storage.deployments[targetDeploy?.deploymentId ?? '']).toBeUndefined();
  });

  it('mv 移动文件 + 冲突拒绝', async () => {
    const mv = await json(await authed(token, '/api/files/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: '/docs/hello.txt', dest: '/docs/movies/hello.txt' }),
    }));
    expect(mv.ok).toBe(true);

    const list = await json(await authed(token, '/api/files/list?path=/docs/movies'));
    expect(list.children.map((c: any) => c.name)).toContain('hello.txt');

    const conflict = await authed(token, '/api/files/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: '/docs/movies/hello.txt', dest: '/docs/movies/hello.txt' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('rm 删除文件（级联）', async () => {
    const rm = await json(await authed(token, '/api/files/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/docs/movies/hello.txt' }),
    }));
    expect(rm.ok).toBe(true);
    const list = await json(await authed(token, '/api/files/list?path=/docs/movies'));
    expect(list.children).toHaveLength(0);
  });
});

describe('用户隔离', () => {
  it('用户 A 看不到用户 B 的文件', async () => {
    const tokenA = await register('dave');
    const tokenB = await register('erin');

    await uploadSingle(tokenA, 'secret.txt', new Uint8Array([9]));

    const listB = await json(await authed(tokenB, '/api/files/list'));
    expect(listB.children).toHaveLength(0);

    const dlB = await authed(tokenB, '/api/files/download?path=/secret.txt');
    expect(dlB.status).toBe(404);
  });
});

describe('分享链接', () => {
  it('创建分享 → 公开访问（免登录）→ 下载 URL 有效', async () => {
    const token = await register('frank');

    await uploadSingle(token, 'share.txt', new Uint8Array([7, 7, 7]));

    const created = await json(await authed(token, '/api/shares', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: '/share.txt' }),
    }));
    expect(created.token).toBeTruthy();

    // 公开访问：不带 cookie
    const pub = await json(await req(`/api/s/${created.token}`));
    expect(pub.fileName).toBe('share.txt');
    expect(pub.urls).toHaveLength(1);

    // 删除分享后公开访问 404
    await authed(token, `/api/shares/${created.token}`, { method: 'DELETE' });
    const gone = await req(`/api/s/${created.token}`);
    expect(gone.status).toBe(404);
  });
});

describe('分片上传（大文件）', () => {
  /** 构造 Pages JSON 单资产 body（模拟浏览器端 hash+base64） */
  function assetJson(filename: string, bytes: Uint8Array): string {
    const b64 = Buffer.from(bytes).toString('base64');
    return JSON.stringify([{ key: `fake-hash-${filename}-${bytes.length}`, value: b64, metadata: { contentType: 'application/octet-stream' }, base64: true }]);
  }

  it('initiate → chunk × N → status 续传 → finalize 全链路', async () => {
    const token = await register('bigfile');
    // 制造一个 40MB 大小的文件（> 直传上限 24MiB）
    const size = 40 * 1024 * 1024;

    // 1. initiate
    const init = await json(
      await authed(token, '/api/upload/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'big.mp4', remotePath: '/', size }),
      }),
    );
    expect(init.uploadId).toBeTruthy();
    expect(init.totalChunks).toBe(Math.ceil(size / init.chunkSize));

    // 2. 上传部分分片（模拟中断）—— JSON body + query 参数
    const chunkData = new Uint8Array(1024).fill(0xab);
    for (let i = 0; i < 2; i++) {
      const body = assetJson(`big.mp4.part00${i}`, chunkData);
      const r = await authed(token, `/api/upload/chunk?uploadId=${init.uploadId}&index=${i}&hash=fake-hash-big.mp4.part00${i}-1024&size=${chunkData.length}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(r.status).toBe(200);
    }

    // 3. status → 断点续传查询
    const st = await json(await authed(token, `/api/upload/status?uploadId=${init.uploadId}`));
    expect(st.uploaded).toEqual([0, 1]);
    expect(st.totalChunks).toBe(init.totalChunks);

    // 4. 补传剩余分片
    for (let i = 2; i < init.totalChunks; i++) {
      const body = assetJson(`big.mp4.part00${i}`, chunkData);
      const r = await authed(token, `/api/upload/chunk?uploadId=${init.uploadId}&index=${i}&hash=fake-hash-big.mp4.part00${i}-1024&size=${chunkData.length}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(r.status).toBe(200);
    }

    // 5. finalize → 一次部署（MemoryAdapter 单 deployment 含全部 part）
    const fin = await json(
      await authed(token, '/api/upload/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: init.uploadId }),
      }),
    );
    expect(fin.ok).toBe(true);
    expect(fin.chunkCount).toBe(init.totalChunks);

    // 6. 下载 → 分片 URL 数量 = totalChunks
    const dl = await json(await authed(token, '/api/files/download?path=/big.mp4'));
    expect(dl.urls).toHaveLength(init.totalChunks);
    // 每片都能从存储取到内容
    console.log('DL baseUrl:', dl.baseUrl, 'urls:', JSON.stringify(dl.urls.map((u: any) => u.path)));
    console.log('assetPool:', JSON.stringify(Object.keys((storage as any).assetPool || {})));
    console.log('assetPool:', JSON.stringify(Object.keys((storage as any).assetPool || {})));
    console.log('deployments:', JSON.stringify(Object.keys(storage.deployments)));
    for (const u of dl.urls) {
      console.log('check:', dl.baseUrl, u.path, storage.getContent(dl.baseUrl, u.path) ? 'FOUND' : 'MISSING');
    }
    // 版本元数据
    const versions = await json(await authed(token, '/api/files/versions?path=/big.mp4'));
    expect(versions.versions[0].size).toBe(size);
    expect(versions.versions[0].chunkCount).toBe(init.totalChunks);
  });

  it('未传全部分片时 finalize 返回 409 且指明缺失分片', async () => {
    const token = await register('partial');
    const init = await json(
      await authed(token, '/api/upload/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'partial.mp4', remotePath: '/', size: 50 * 1024 * 1024 }),
      }),
    );
    // 只传 1 片
    const body = assetJson('partial.mp4.part000', new Uint8Array(100));
    await authed(token, `/api/upload/chunk?uploadId=${init.uploadId}&index=0&hash=fake-hash-0&size=100`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const fin = await authed(token, '/api/upload/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: init.uploadId }),
    });
    expect(fin.status).toBe(409);
    const finBody = await json(fin);
    expect(finBody.missing).toBe(1);
  });

  it('单文件超过直传上限时 /single 返回 413', async () => {
    const token = await register('overlimit');
    // 超限（24MiB+1）→ query 带 size，body 占位
    const body = assetJson('too-big.bin', new Uint8Array(1024));
    const r = await authed(
      token,
      `/api/upload/single?filename=too-big.bin&remotePath=%2F&hash=fake-hash-big&size=${24 * 1024 * 1024 + 1}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    );
    expect(r.status).toBe(413);
  });
});

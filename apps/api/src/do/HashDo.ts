// HashDo — 服务端 PBKDF2 密码哈希
//
// 背景：Worker 免费版 CPU 限制 10ms，PBKDF2 100,000 次迭代大概率超时，
// 被迫在浏览器端计算（安全风险：hash 逻辑暴露在前端 JS）。
// Durable Object 有 30s CPU 配额 → 彻底解决。
//
// 用法：
//   const stub = env.HASH_DO.get(env.HASH_DO.idFromName("singleton"));
//   const hash = await stub.fetch(new Request("https://do/hash", {
//     method: "POST", body: JSON.stringify({ password, salt? })
//   }));
import { DurableObject } from 'cloudflare:workers';

export interface EnvForDo {
  HASH_DO: DurableObjectNamespace;
}

export class HashDo extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/hash') {
      const { password, salt: saltB64 } = await request.json() as { password: string; salt?: string };
      if (!password) return Response.json({ error: '缺少 password' }, { status: 400 });

      const saltBytes = saltB64
        ? Uint8Array.from(atob(saltB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
        : crypto.getRandomValues(new Uint8Array(16));

      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
        keyMaterial,
        256,
      );

      const hash = btoa(String.fromCharCode(...new Uint8Array(bits)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const salt = btoa(String.fromCharCode(...saltBytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      return Response.json({ hash, salt, iterations: 100_000 });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

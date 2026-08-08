// @cloudfiles/shared - WebCrypto 工具（PBKDF2 密码哈希 + HS256 JWT）
// 零第三方依赖，Workers / Node 18+ / 浏览器均可用。

// ---------- PBKDF2 密码哈希 ----------
/** Uint8Array → ArrayBuffer（兼容 TS 5.7 泛型 TypedArray） */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export interface PasswordHash {
  hash: string; // base64url(hash)
  salt: string; // base64url(salt)
  iterations: number;
}

export async function hashPassword(
  password: string,
  iterations = 100_000,
  salt?: Uint8Array,
): Promise<PasswordHash> {
  const saltBytes = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: toArrayBuffer(saltBytes), iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return {
    hash: base64url(new Uint8Array(bits)),
    salt: base64url(saltBytes),
    iterations,
  };
}

export async function verifyPassword(password: string, ph: PasswordHash): Promise<boolean> {
  const saltBytes = fromBase64url(ph.salt);
  const expected = await hashPassword(password, ph.iterations, saltBytes);
  return expected.hash === ph.hash;
}

// ---------- HS256 JWT ----------
function b64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64url(bytes: Uint8Array): string {
  // 兼容 Node 与 Workers：逐字节拼接避免 Buffer 依赖
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface JwtPayload {
  sub: number; // user id
  username: string;
  iat: number;
  exp: number;
}

export async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, ttlSec = 7 * 24 * 3600): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${base64url(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, toArrayBuffer(fromBase64url(sig)), new TextEncoder().encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as JwtPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

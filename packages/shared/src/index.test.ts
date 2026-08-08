import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, signJwt, verifyJwt } from '../src/crypto';
import { MemoryAdapter, extractProductionUrl, sha256Hex } from '../src/storage';
import { resolveHandler, playerAdapters } from '../src/capabilities';
import { validateConfig, DEFAULT_CONFIG, type CloudfilesConfig } from '../src/config';

describe('crypto', () => {
  it('PBKDF2 哈希可验证', async () => {
    const ph = await hashPassword('correct horse battery staple');
    expect(ph.hash).toBeTruthy();
    expect(ph.salt).toBeTruthy();
    expect(await verifyPassword('correct horse battery staple', ph)).toBe(true);
    expect(await verifyPassword('wrong password', ph)).toBe(false);
  });

  it('PBKDF2 相同密码+盐产出相同哈希', async () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const a = await hashPassword('pw', 1000, salt);
    const b = await hashPassword('pw', 1000, salt);
    expect(a.hash).toBe(b.hash);
  });

  it('JWT 签名与验证', async () => {
    const token = await signJwt({ sub: 42, username: 'alice' }, 'secret-key-1234567890');
    const payload = await verifyJwt(token, 'secret-key-1234567890');
    expect(payload?.sub).toBe(42);
    expect(payload?.username).toBe('alice');
    expect(await verifyJwt(token, 'wrong-secret')).toBeNull();
  });
});

describe('storage adapter', () => {
  it('MemoryAdapter 部署与删除', async () => {
    const mem = new MemoryAdapter();
    const enc = new TextEncoder();
    const stored = await mem.deployFiles(
      [
        { path: 'chunk_0.bin', content: enc.encode('hello') },
        { path: 'chunk_1.bin', content: enc.encode('world') },
      ],
      { projectName: 't-data' },
    );
    expect(stored.paths).toHaveLength(2);
    expect(mem.getContent(stored.baseUrl, 'chunk_0.bin')).toEqual(enc.encode('hello'));
    await mem.deleteDeployment('t-data', stored.deploymentId);
    expect(mem.getContent(stored.baseUrl, 'chunk_0.bin')).toBeUndefined();
  });

  it('extractProductionUrl 保留 hash 子域', () => {
    expect(extractProductionUrl('https://a1b2c3d4.proj-data.pages.dev', 'proj-data')).toBe('https://a1b2c3d4.proj-data.pages.dev');
  });

  it('sha256Hex 稳定输出', async () => {
    const h = await sha256Hex(new TextEncoder().encode('abc'));
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('capabilities', () => {
  it('按扩展名解析处理器', () => {
    expect(resolveHandler('a.mp4').kind).toBe('video');
    expect(resolveHandler('a.md').kind).toBe('text');
    expect(resolveHandler('a.zip').kind).toBe('archive');
    expect(resolveHandler('a.unknown-xyz').kind).toBe('binary');
  });

  it('播放器适配器齐全', () => {
    expect(playerAdapters.hls.manifestSuffix).toBe('.m3u8');
    expect(playerAdapters.dash.manifestSuffix).toBe('.mpd');
  });
});

describe('config', () => {
  it('无效配置 fail fast', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      cloudflare: { accountId: '', apiToken: '', projectPrefix: '', mainBranch: 'main' },
      auth: { jwtSecret: 'short', jwtTtlSec: 3600 },
    } as unknown as CloudfilesConfig;
    expect(() => validateConfig(bad)).toThrow(/配置无效/);
  });

  it('chunkSize 超过 25MiB 报错（平台边界）', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      cloudflare: { accountId: 'a', apiToken: 'b'.repeat(40), projectPrefix: 'cf', mainBranch: 'main' },
      auth: { jwtSecret: 's'.repeat(32), jwtTtlSec: 3600 },
      storage: { adapter: 'pages', chunkSizeBytes: 26 * 1024 * 1024 },
    } as unknown as CloudfilesConfig;
    expect(() => validateConfig(bad)).toThrow(/25MiB/);
  });
});

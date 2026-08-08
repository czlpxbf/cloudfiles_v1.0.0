// 前端部署（esbuild bundle 版）：将部署逻辑 + shared 源码打包为单文件后执行
// 用法:
//   export CLOUDFLARE_ACCOUNT_ID=xxx
//   export CLOUDFLARE_API_TOKEN=xxx
//   node scripts/deploy-web.mjs [projectName]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectName = process.argv[2] || 'cloudfiles-web';

const distDir = path.join(__dirname, '..', 'apps', 'web', 'dist');
if (!fs.existsSync(distDir)) {
  console.error(`未找到构建产物: ${distDir}`);
  process.exit(1);
}

// 收集 dist 文件
const files = [];
function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, rel);
    else files.push({ path: rel, content: new Uint8Array(fs.readFileSync(full)) });
  }
}
walk(distDir);

// 打包 API（Pages Functions 同域部署，解决 workers.dev 被墙 + CORS）
// ⚠️ 不能放进 manifest，必须以 _worker.bundle 独立字段上传（wrangler 行为）
const workerOut = path.join(__dirname, '..', '.tmp-worker-bundle.js');
await build({
  entryPoints: [path.join(__dirname, '..', 'apps', 'api', 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: workerOut,
  alias: { '@cloudfiles/shared': path.join(__dirname, '..', 'packages', 'shared', 'src', 'index.ts') },
  logLevel: 'error',
});
const workerBundle = new Uint8Array(fs.readFileSync(workerOut));
try { fs.rmSync(workerOut, { force: true }); } catch { /* safe-delete 拦截可忽略 */ }
console.log(`部署 ${files.length} 个静态文件 + _worker.bundle（API）到 Pages 项目 ${projectName}...`);

// esbuild bundle 部署执行体（内联 shared 源码，绕开 dist 锁定问题）
const filesB64 = files.map((f) => ({
  path: f.path,
  contentB64: Buffer.from(f.content).toString('base64'),
}));
const workerB64 = Buffer.from(workerBundle).toString('base64');
const entrySrc = `
import { PagesDeployAdapter } from '@cloudfiles/shared';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) { console.error('需要 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN'); process.exit(1); }
const raw = ${JSON.stringify(filesB64)};
const files = raw.map((f) => ({ path: f.path, content: Uint8Array.from(Buffer.from(f.contentB64, 'base64')) }));
const adapter = new PagesDeployAdapter({ accountId, apiToken });
const stored = await adapter.deployFiles(files, { projectName: ${JSON.stringify(projectName)} }, [
  { field: '_worker.bundle', filename: '_worker.bundle', content: Uint8Array.from(Buffer.from(${JSON.stringify(workerB64)}, 'base64')) },
]);
console.log('前端已部署: ' + stored.baseUrl);
console.log('生产地址: https://' + ${JSON.stringify(projectName)} + '.pages.dev');
`;

const outfile = path.join(__dirname, '..', '.tmp-deploy-web.mjs');
await build({
  stdin: { contents: entrySrc, resolveDir: __dirname, sourcefile: 'deploy-web-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  alias: { '@cloudfiles/shared': path.join(__dirname, '..', 'packages', 'shared', 'src', 'index.ts') },
  logLevel: 'error',
});

// 同进程执行 bundle（避免子进程输出丢失）
try {
  const { pathToFileURL } = await import('node:url');
  await import(pathToFileURL(outfile).href);
} catch (e) {
  console.error('部署执行失败:', e?.message ?? e);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(outfile, { force: true }); } catch { /* 忽略 */ }
}

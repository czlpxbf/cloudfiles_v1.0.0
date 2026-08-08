// Worker 打包脚本：esbuild bundle API 入口 → dist/worker.js
// 用法: node scripts/build-worker.mjs
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'apps', 'api', 'dist');

await build({
  entryPoints: [path.join(__dirname, '..', 'apps', 'api', 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: path.join(outDir, 'worker.js'),
  sourcemap: false,
  minify: false,
  // 直接用 shared 源码（避免依赖 tsc dist 产物）
  alias: {
    '@cloudfiles/shared': path.join(__dirname, '..', 'packages', 'shared', 'src', 'index.ts'),
  },
  logLevel: 'info',
});

console.log('✅ Worker 已打包: apps/api/dist/worker.js');

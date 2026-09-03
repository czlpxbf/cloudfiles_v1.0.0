// 构建 + 部署脚本（Workers + Static Assets）
// 用法: node scripts/deploy.mjs
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

console.log('==> 构建前端...');
execSync('npx vite build', { cwd: path.join(root, 'apps', 'web'), stdio: 'inherit' });

console.log('==> 部署 Worker + Static Assets...');
execSync('npx wrangler deploy', { cwd: root, stdio: 'inherit' });

console.log('✅ 部署完成');

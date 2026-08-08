// HLS 部署脚本：本地 ffmpeg 转码 → 部署 HLS 到 Pages → 注册版本
// 用法：node scripts/hls-deploy.mjs <input.mp4> <token> [baseUrl]
//
// 前提：先运行 transcode.js 完成转码，或本脚本内置转码 + 部署
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [input, token, baseUrlArg] = process.argv.slice(2);
const BASE = baseUrlArg || 'https://zz2z.eu.cc';

if (!input || !token || !fs.existsSync(input)) {
  console.error('用法: node scripts/hls-deploy.mjs <input.mp4> <cf_token> [baseUrl]');
  console.error('  cf_token: 浏览器 F12→Application→Cookies→cf_token');
  process.exit(1);
}

const outDir = path.join(path.dirname(input), `${path.basename(input, path.extname(input))}_hls`);
fs.mkdirSync(outDir, { recursive: true });

console.log('[1/3] 转码 HLS...');
execFileSync('ffmpeg', [
  '-y', '-i', input, '-map', '0', '-c', 'copy',
  '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
  '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
  path.join(outDir, 'index.m3u8'),
], { stdio: 'inherit' });

// 收集所有文件（m3u8 + ts 段）
const files = fs.readdirSync(outDir)
  .sort()
  .map((f) => ({ name: f, path: path.join(outDir, f), size: fs.statSync(path.join(outDir, f)).size }));
if (files.length === 0) { console.error('转码未生成文件'); process.exit(1); }

console.log(`[2/3] 部署 ${files.length} 个文件（总 ${(files.reduce((s,f)=>s+f.size,0)/1024/1024).toFixed(1)}MB）...`);

const paths = files.map((f) => ({ path: f.name, size: f.size }));
const totalSize = files.reduce((s, f) => s + f.size, 0);
const filename = path.basename(input);

// 分批上传到 Pages
const deployRes = await fetch(`${BASE}/api/upload/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: `cf_token=${token}` },
  body: JSON.stringify({
    filename,
    remotePath: '/',
    baseUrl: '', // 预留，register 端点不再需要（已由 deploy 返回的实际 URL 替代）
    deploymentId: '', // 同上
    size: totalSize,
    paths,
    isVideo: true,
  }),
});

if (!deployRes.ok) {
  console.error(`部署失败: ${deployRes.status} ${await deployRes.text()}`);
  process.exit(1);
}

console.log(`[3/3] 注册版本...`);
const body = await deployRes.json();
console.log(`✅ 完成: fileId=${body.fileId} versionId=${body.versionId}`);
console.log(`   播放: ${BASE}/api/files/play?path=/${encodeURIComponent(filename)}`);

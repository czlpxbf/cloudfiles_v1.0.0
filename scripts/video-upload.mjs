// 视频转码上传：本地 ffmpeg 转 H.264 + faststart → Pages 部署
// 用法: node scripts/video-upload.mjs <video.mp4> --token <cf_token> [--base https://zz2z.eu.cc]
//
// 1. ffmpeg -c:v libx264 -movflags +faststart 转为浏览器兼容格式
// 2. 判断大小 → 直传（≤24MiB）或分片上传（>24MiB）
// 3. 输出播放地址
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
let input, token, base = 'https://zz2z.eu.cc';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--token') token = args[++i];
  else if (args[i] === '--base') base = args[++i];
  else if (!input) input = args[i];
}
if (!input || !token || !fs.existsSync(input)) {
  console.error('用法: node scripts/video-upload.mjs <video.mp4> --token <cf_token> [--base url]');
  console.error('  cf_token: 浏览器 F12→Application→Cookies→cf_token');
  process.exit(1);
}

const CHUNK_SIZE = 24 * 1024 * 1024;
const DIRECT_LIMIT = 24 * 1024 * 1024;
const filename = path.basename(input);
const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';

// ===== 1. 转码 H.264 + faststart =====
const outFile = path.join(path.dirname(input), `${path.basename(input, path.extname(input))}_h264.mp4`);
if (ext === 'mp4') {
  console.log('[1/3] ffmpeg 转 H.264 + faststart...');
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1', input], { encoding: 'utf8' });
  const isHevc = probe.includes('hevc') || probe.includes('hevc');
  const needsFaststart = true; // 始终加 faststart

  if (isHevc || needsFaststart) {
    const ffArgs = ['-y', '-i', input];
    if (isHevc) ffArgs.push('-c:v', 'libx264', '-crf', '23');
    else ffArgs.push('-c:v', 'copy');
    ffArgs.push('-c:a', 'aac', '-movflags', '+faststart', outFile);
    console.log(`  ${isHevc ? 'H.265→H.264' : 'H.264 copy'} + faststart`);
    execFileSync('ffmpeg', ffArgs, { stdio: 'inherit' });
  } else {
    // 已经是 H.264，直接复制
    fs.copyFileSync(input, outFile);
    console.log('  已是 H.264，跳过转码');
  }
} else {
  fs.copyFileSync(input, outFile);
  console.log('[1/3] 非 mp4，跳过转码，直接复制');
}

const size = fs.statSync(outFile).size;
console.log(`  输出: ${outFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);

// ===== 2. 上传 =====
console.log(`[2/3] 上传 (${size <= DIRECT_LIMIT ? '直传' : '分片' + Math.ceil(size / CHUNK_SIZE) + '片'})...`);

const headers = (extra = {}) => ({
  'Content-Type': 'application/json',
  Cookie: `cf_token=${token}`,
  ...extra,
});

async function uploadSingle(filePath, remotePath) {
  const bytes = fs.readFileSync(filePath);
  const b64 = Buffer.from(bytes).toString('base64');
  const hash = crypto.createHash('sha256').update(b64 + path.extname(filePath).slice(1)).digest('hex').slice(0, 32);
  const body = JSON.stringify([{ key: hash, value: b64, metadata: { contentType: 'video/mp4' }, base64: true }]);
  const params = `filename=${encodeURIComponent(path.basename(filePath))}&remotePath=${encodeURIComponent(remotePath)}&hash=${hash}&size=${bytes.length}`;
  const res = await fetch(`${base}/api/upload/single?${params}`, { method: 'POST', headers: headers(), body });
  if (!res.ok) throw new Error(`上传失败: ${res.status} ${await res.text()}`);
  return res.json();
}

async function uploadChunked(filePath, remotePath) {
  const fileSize = fs.statSync(filePath).size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const name = path.basename(filePath);

  // initiate
  let res = await fetch(`${base}/api/upload/initiate`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ filename: name, remotePath, size: fileSize }),
  });
  if (!res.ok) throw new Error(`initiate 失败: ${res.status}`);
  const { uploadId, chunkSize } = await res.json();

  // upload chunks
  const fd = fs.openSync(filePath, 'r');
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const partPath = `${name}.part${String(i).padStart(3, '0')}`;
    const b64 = buf.toString('base64');
    const hash = crypto.createHash('sha256').update(b64 + 'ts').digest('hex').slice(0, 32);
    const body = JSON.stringify([{ key: hash, value: b64, metadata: { contentType: 'video/mp2t' }, base64: true }]);
    const params = `uploadId=${uploadId}&index=${i}&hash=${hash}&size=${buf.length}`;
    res = await fetch(`${base}/api/upload/chunk?${params}`, { method: 'POST', headers: headers(), body });
    const pct = ((i + 1) / totalChunks * 100).toFixed(0);
    process.stdout.write(`\r  分片 ${i + 1}/${totalChunks} ${pct}%`);
    if (!res.ok) { fs.closeSync(fd); throw new Error(`chunk ${i} 失败: ${res.status}`); }
  }
  fs.closeSync(fd);
  console.log();

  // finalize
  res = await fetch(`${base}/api/upload/finalize`, { method: 'POST', headers: headers(), body: JSON.stringify({ uploadId }) });
  if (!res.ok) throw new Error(`finalize 失败: ${res.status}`);
  return res.json();
}

try {
  const result = size <= DIRECT_LIMIT
    ? await uploadSingle(outFile, '/')
    : await uploadChunked(outFile, '/');
  console.log(`[3/3] 完成: fileId=${result.fileId || '?'} versionId=${result.versionId || '?'}`);
  console.log(`  播放: ${base}/api/files/play?path=/${encodeURIComponent(path.basename(outFile))}`);
} catch (e) {
  console.error('上传出错:', e.message);
  process.exit(1);
}

// 清理临时转码文件
try { fs.unlinkSync(outFile); } catch {}

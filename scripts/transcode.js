// 视频转码脚本：ffmpeg -c copy 流式分片（cfvideo 思路，零转码零画质损失）
//
// 用法:
//   node scripts/transcode.js <input.mp4> [--mode hls|dash] [--out <dir>]
//
// 默认 hls: index.m3u8 + seg_000.ts（每片 4 秒，≤25MiB，适配 Pages 单文件上限）
// 可选 dash: manifest.mpd + init.m4s + seg.m4s
//
// 前置要求: 安装 ffmpeg（https://ffmpeg.org）
// 说明: -c copy 仅做容器级分片，不重新编码 → 秒级完成、无质量损失。
//       源建议 H.264/AAC（浏览器兼容），AV1 部分浏览器不支持。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.log('用法: node scripts/transcode.js <input> [--mode hls|dash] [--out <dir>]');
  process.exit(1);
}

const args = process.argv.slice(2);
const input = args[0];
if (!input || !fs.existsSync(input)) usage();

const modeIdx = args.indexOf('--mode');
const mode = modeIdx > -1 ? args[modeIdx + 1] : 'hls';
const outIdx = args.indexOf('--out');
const outDir = outIdx > -1 ? args[outIdx + 1] : path.join(path.dirname(input), `${path.basename(input, path.extname(input))}_${mode}`);

if (!['hls', 'dash'].includes(mode)) usage();
fs.mkdirSync(outDir, { recursive: true });

console.log(`[transcode] ${input} → ${outDir} (${mode})`);

const baseArgs = ['-y', '-i', input, '-map', '0', '-c', 'copy'];
const outPath = path.join(outDir, mode === 'hls' ? 'index.m3u8' : 'manifest.mpd');

const ffmpegArgs =
  mode === 'hls'
    ? [...baseArgs, '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'), outPath]
    : [...baseArgs, '-f', 'dash', '-seg_duration', '4', '-use_template', '1', '-use_timeline', '1', outPath];

try {
  execFileSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
} catch (e) {
  console.error('[transcode] ffmpeg 执行失败，请确认已安装 ffmpeg 并加入 PATH');
  process.exit(1);
}

// 检查分片是否超过 25MiB（Pages 平台边界）
const files = fs.readdirSync(outDir).filter((f) => f.endsWith(mode === 'hls' ? '.ts' : '.m4s'));
const MAX = 25 * 1024 * 1024;
const oversized = files.filter((f) => fs.statSync(path.join(outDir, f)).size > MAX);
if (oversized.length > 0) {
  console.warn(`⚠️ 以下分片超过 25MiB（Pages 单文件上限），可减小 -hls_time/-seg_duration: ${oversized.join(', ')}`);
}

console.log(`✅ 转码完成: ${outDir}`);
console.log(`   分片数: ${files.length} | 最大: ${Math.max(...files.map((f) => fs.statSync(path.join(outDir, f)).size))} 字节`);
console.log(`   上传: cloudfiles up ${outDir}/* 或使用 CLI 的视频上传流程`);

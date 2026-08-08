// Cloudfiles CLI v0.1.0 —— 通用网盘客户端（调 Worker API，大文件本地分块直传 Pages）
import fs from 'node:fs';
import path from 'node:path';
import { PagesDeployAdapter, resolveHandler } from '@cloudfiles/shared';
import { api, loginInteractive, registerInteractive, loadSession } from './client.js';

const CHUNK_SIZE = 25 * 1024 * 1024; // 25MiB = Pages 单文件上限（平台边界）

function usage() {
  console.log(`
CLOUDFILES CLI v0.1.0
用法: node cli.js <命令> [参数]

认证:
  login                         登录
  register                      注册新用户

文件:
  ls [路径]                     列出目录
  mkdir <路径>                  创建文件夹
  up <本地文件或目录> [远程路径]  上传（>25MiB 自动分块直传部署）
  dl <远程路径> [版本时间戳]      下载（全部版本可指定）
  rm <路径>                     删除
  mv <src> <dest>               移动/重命名

版本:
  cv --path <路径> [--target <时间戳>]   清理版本（真删 deployment）
  rv <路径> <时间戳> [名称]              版本命名（空名称=移除）

其他:
  search <关键字>               搜索（文件名/版本名）
`);
}

async function ensureAuth() {
  const session = loadSession();
  if (!session.token) throw new Error('未登录，请先执行: cloudfiles login');
  return session;
}

async function cmdLs(args) {
  const session = await ensureAuth();
  const target = args[0] || '/';
  const data = await api(`/api/files/list?path=${encodeURIComponent(target)}`, { session });
  for (const c of data.children) {
    const size = c.type === 'file' ? ` ${(c.versions[0]?.size ?? 0).toLocaleString()}B` : '';
    const vs = c.type === 'file' ? ` (${c.versions.length}版)` : '';
    console.log(`${c.type === 'folder' ? '[DIR]' : '[FILE]'} ${c.name}${vs}${size}`);
  }
  console.log(`共 ${data.children.length} 项`);
}

async function cmdMkdir(args) {
  const session = await ensureAuth();
  if (!args[0]) throw new Error('用法: mkdir <路径>');
  await api('/api/files/folder', { method: 'POST', body: { path: args[0] }, session });
  console.log(`已创建: ${args[0]}`);
}

async function cmdUp(localArg, remotePathArg) {
  const session = await ensureAuth();
  if (!localArg) throw new Error('用法: up <本地路径> [远程路径]');
  const localPath = path.resolve(localArg);
  const stat = fs.statSync(localPath);
  if (stat.isDirectory()) throw new Error('目录上传请先打包为压缩文件（MVP）');
  const remotePath = remotePathArg || `/`;
  const filename = path.basename(localPath);
  const size = stat.size;

  const userData = await api('/api/auth/me', { session });
  if (!userData.user) throw new Error('获取用户信息失败');

  if (size <= CHUNK_SIZE) {
    // 小文件：直接 multipart 上传（Worker 部署）
    const form = new FormData();
    form.append('file', new File([fs.readFileSync(localPath)], filename));
    form.append('remotePath', remotePath);
    const res = await api('/api/upload/single', { method: 'POST', form, session });
    console.log(`✅ 上传完成: ${filename} → ${remotePath}（版本 #${res.versionId}）`);
    return;
  }

  // 大文件：本地分块 → PagesDeployAdapter 一次部署 → register
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('大文件上传需要环境变量 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN');
  }

  // 切块
  const chunks = [];
  const fd = fs.openSync(localPath, 'r');
  let offset = 0;
  let idx = 0;
  while (offset < size) {
    const len = Math.min(CHUNK_SIZE, size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    chunks.push({ path: `chunk_${idx}.bin`, content: new Uint8Array(buf) });
    offset += len;
    idx++;
  }
  fs.closeSync(fd);
  console.log(`分块: ${chunks.length} 块，开始部署...`);

  const adapter = new PagesDeployAdapter({ accountId, apiToken });
  // 需要知道数据项目名 → 从 register 响应取得（先询问或约定）
  const projectName = `${(process.env.CF_PROJECT_PREFIX || 'cf')}-${userData.user.username}-data`;
  const stored = await adapter.deployFiles(chunks, { projectName });

  const reg = await api('/api/upload/register', {
    method: 'POST',
    session,
    body: {
      filename,
      remotePath,
      baseUrl: stored.baseUrl,
      deploymentId: stored.deploymentId,
      size,
      paths: chunks.map((_, i) => ({ path: `chunk_${i}.bin`, size: chunkSizeAt(i) })),
    },
  });
  console.log(`✅ 大文件上传完成: ${filename}（${(size / 1024 / 1024).toFixed(1)}MB, ${chunks.length} 块, 1 次部署）→ ${stored.baseUrl}`);

  function chunkSizeAt(i) {
    const len = Math.min(CHUNK_SIZE, size - i * CHUNK_SIZE);
    return Math.max(0, len);
  }
}

async function cmdDl(args) {
  const session = await ensureAuth();
  if (!args[0]) throw new Error('用法: dl <远程路径> [时间戳]');
  const filePath = args[0];
  const createdAt = args[1];

  // 获取版本列表以定位时间戳 → 下载 URL
  let versionId;
  if (createdAt) {
    const vs = await api(`/api/files/versions?path=${encodeURIComponent(filePath)}`, { session });
    const v = vs.versions.find((x) => x.createdAt === createdAt);
    if (!v) throw new Error(`未找到版本 ${createdAt}`);
    versionId = v.id;
  }
  const dl = await api(
    `/api/files/download?path=${encodeURIComponent(filePath)}${versionId ? `&versionId=${versionId}` : ''}`,
    { session },
  );

  const outPath = path.join(process.cwd(), dl.filename);
  const ws = fs.createWriteStream(outPath);
  let done = 0;
  for (const u of dl.urls) {
    const res = await fetch(u.url);
    if (!res.ok) throw new Error(`分块下载失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await new Promise((resolve, reject) => {
      ws.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    done += buf.length;
    process.stdout.write(`\r下载中 ${done}/${dl.urls.length} 块`);
  }
  ws.end();
  console.log(`\n✅ 已保存: ${outPath}`);
}

async function cmdRm(args) {
  const session = await ensureAuth();
  if (!args[0]) throw new Error('用法: rm <路径>');
  await api('/api/files/remove', { method: 'POST', body: { path: args[0] }, session });
  console.log(`已删除: ${args[0]}`);
}

async function cmdMv(args) {
  const session = await ensureAuth();
  if (!args[0] || !args[1]) throw new Error('用法: mv <src> <dest>');
  await api('/api/files/move', { method: 'POST', body: { src: args[0], dest: args[1] }, session });
  console.log(`已移动: ${args[0]} → ${args[1]}`);
}

async function cmdCv(args) {
  const session = await ensureAuth();
  const pIdx = args.indexOf('--path');
  const tIdx = args.indexOf('--target');
  const filePath = pIdx > -1 ? args[pIdx + 1] : undefined;
  const target = tIdx > -1 ? args[tIdx + 1] : undefined;
  if (!filePath) throw new Error('用法: cv --path <路径> [--target <时间戳>]');
  const body = { filePath };
  if (target) body.target = target;
  const res = await api('/api/files/versions/clean', { method: 'POST', body, session });
  console.log(`已清理 ${res.removed} 个版本（含云端 deployment）`);
}

async function cmdRv(args) {
  const session = await ensureAuth();
  if (!args[0] || !args[1]) throw new Error('用法: rv <路径> <时间戳> [名称]');
  await api('/api/files/versions/rename', {
    method: 'POST',
    body: { filePath: args[0], createdAt: args[1], name: args[2] || '' },
    session,
  });
  console.log('版本命名已更新');
}

async function cmdSearch(args) {
  const session = await ensureAuth();
  if (!args[0]) throw new Error('用法: search <关键字>');
  const res = await api(`/api/files/search?q=${encodeURIComponent(args[0])}`, { session });
  if (res.results.length === 0) console.log('无结果');
  for (const r of res.results) {
    console.log(`[${r.fileName}] 版本#${r.versionId} ${r.createdAt} ${r.versionName ? `别名:${r.versionName}` : ''}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  try {
    switch (cmd) {
      case 'login': await loginInteractive(); break;
      case 'register': await registerInteractive(); break;
      case 'ls': await cmdLs(args.slice(1)); break;
      case 'mkdir': await cmdMkdir(args.slice(1)); break;
      case 'up': await cmdUp(args[1], args[2]); break;
      case 'dl': await cmdDl(args.slice(1)); break;
      case 'rm': await cmdRm(args.slice(1)); break;
      case 'mv': await cmdMv(args.slice(1)); break;
      case 'cv': await cmdCv(args.slice(1)); break;
      case 'rv': await cmdRv(args.slice(1)); break;
      case 'search': await cmdSearch(args.slice(1)); break;
      default: usage();
    }
  } catch (err) {
    console.error(`\n错误: ${err.message}`);
    process.exit(1);
  }
}

main();

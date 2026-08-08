// Worker 部署脚本（Workers API 直传，绕开 wrangler 缓存锁）
// 用法:
//   export CLOUDFLARE_ACCOUNT_ID=xxx
//   export CLOUDFLARE_API_TOKEN=xxx
//   node scripts/deploy-worker-api.mjs [scriptName]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
  console.error('需要环境变量 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN');
  process.exit(1);
}
const scriptName = process.argv[2] || 'cloudfiles-api';
const workerFile = path.join(__dirname, '..', 'apps', 'api', 'dist', 'worker.js');
if (!fs.existsSync(workerFile)) {
  console.error(`未找到 ${workerFile}（先运行 node scripts/build-worker.mjs）`);
  process.exit(1);
}

const metadata = {
  main_module: 'worker.js',
  bindings: [
    { type: 'd1', name: 'DB', id: '8e717e13-cb12-4efb-a2b5-842899562a5e' },
    { type: 'kv_namespace', name: 'KV', namespace_id: '87e9c6e7d22e4919a42e3a1a3720575f' },
  ],
};

const form = new FormData();
form.append('worker.js', new File([fs.readFileSync(workerFile)], 'worker.js', { type: 'application/javascript' }));
form.append('metadata', new File([JSON.stringify(metadata)], 'metadata.json', { type: 'application/json' }));

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
  { method: 'PUT', headers: { Authorization: `Bearer ${apiToken}` }, body: form },
);
const data = await res.json();
if (data.success) {
  console.log(`✅ Worker 已部署: ${scriptName}`);
  console.log(`   公网地址: https://${scriptName}.${data.result?.subdomain || 'workers'}.dev`);
} else {
  console.error('部署失败:', JSON.stringify(data.errors ?? data));
  process.exit(1);
}

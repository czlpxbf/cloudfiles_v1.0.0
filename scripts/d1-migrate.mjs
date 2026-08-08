// D1 迁移执行脚本：读取 migrations/*.sql，按语句拆分，逐条调用 D1 Query API
// 用法: node scripts/d1-migrate.mjs <accountId> <databaseId> <token> [sqlFile]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [accountId, databaseId, token, sqlFileArg] = process.argv.slice(2);

if (!accountId || !databaseId || !token) {
  console.error('用法: node scripts/d1-migrate.mjs <accountId> <databaseId> <apiToken> [sqlFile]');
  process.exit(1);
}

const sqlFile = sqlFileArg
  ? path.resolve(sqlFileArg)
  : path.join(__dirname, '..', 'apps', 'api', 'migrations', '0001_init.sql');

const sql = fs.readFileSync(sqlFile, 'utf-8');
// 按分号拆分语句（0001 无过程化内容，简单拆分安全）
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('--'));

console.log(`执行迁移: ${path.basename(sqlFile)} (${statements.length} 条语句)`);

let ok = 0;
for (const stmt of statements) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: stmt }),
  });
  const data = await res.json();
  if (data.success) {
    ok++;
    console.log(`  ✓ ${stmt.split('\n')[0].slice(0, 60)}`);
  } else {
    console.error(`  ✗ 失败: ${JSON.stringify(data.errors ?? data)}`);
    console.error(`    SQL: ${stmt.slice(0, 120)}`);
    process.exitCode = 1;
    break;
  }
}
console.log(`迁移完成: ${ok}/${statements.length} 条成功`);

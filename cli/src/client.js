// CLI API 客户端：token 持久化 + fetch 封装
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const CONFIG_PATH = path.join(os.homedir(), '.cloudfiles.json');

export function getBaseUrl() {
  return process.env.CLOUDFILES_API_URL || 'http://localhost:8787';
}

export function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { token: null, username: null, baseUrl: null };
  }
}

export function saveSession(session) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(session, null, 2));
}

export function clearSession() {
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch {}
}

export async function api(path, { method = 'GET', body, form, session = loadSession() } = {}) {
  const headers = {};
  if (session.token) headers['Cookie'] = `cf_token=${session.token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${getBaseUrl()}${path}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${data.error || '未知错误'}`);
  }
  return data;
}

export async function loginInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const username = await rl.question('用户名: ');
  const password = await rl.question('密码: ');
  rl.close();
  const res = await fetch(`${getBaseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`登录失败: ${data.error}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const token = setCookie.match(/cf_token=([^;]+)/)?.[1];
  if (!token) throw new Error('响应缺少会话 cookie');
  saveSession({ token, username, baseUrl: getBaseUrl() });
  console.log(`已登录: ${username}`);
}

export async function registerInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const username = await rl.question('用户名: ');
  const password = await rl.question('密码: ');
  rl.close();
  const res = await fetch(`${getBaseUrl()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`注册失败: ${data.error}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const token = setCookie.match(/cf_token=([^;]+)/)?.[1];
  saveSession({ token, username, baseUrl: getBaseUrl() });
  console.log(`已注册并登录: ${username}`);
}

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, ApiError, uploadSingleFile, uploadChunkWithProgress, type FileNode } from '../api/client';
import UploadProgressBar from '../components/UploadProgressBar.vue';

const emit = defineEmits<{ (e: 'play', path: string): void }>();

const currentPath = ref('/');
const crumbs = ref<string[]>([]);
const children = ref<FileNode[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const query = ref('');
const searchResults = ref<{ fileId: number; fileName: string; versionId: number; versionName: string | null; createdAt: string }[] | null>(null);

const uploadInput = ref<HTMLInputElement | null>(null);

// 上传任务列表（每文件一条进度）
interface UploadTask {
  id: number;
  filename: string;
  size: number;
  progress: number; // 0~1
  loaded: number;
  phase: string;
  error: string;
  aborted: boolean;
}
const uploadTasks = ref<UploadTask[]>([]);
let taskSeq = 0;

// 下载任务列表
interface DownloadTask {
  id: number;
  filename: string;
  progress: number;
  loaded: number;
  total: number;
  phase: string;
  error: string;
}
const downloadTasks = ref<DownloadTask[]>([]);
let downloadSeq = 0;

// 直传上限（与后端一致：24MiB）
const DIRECT_LIMIT = 24 * 1024 * 1024;
// localStorage 断点续传记录 key
const RESUME_KEY = 'cloudfiles_resume';

// 版本弹窗状态
const versionDialog = ref<{ path: string; name: string } | null>(null);
const versions = ref<{ id: number; size: number; createdAt: string; name: string | null; shotAt: string | null; isVideo: boolean }[]>([]);
const newVersionName = ref('');

function pathAt(i: number): string {
  const parts = crumbs.value.slice(0, i + 1);
  return '/' + parts.join('/');
}

async function load(path: string) {
  busy.value = true;
  error.value = '';
  try {
    const data = await api.list(path);
    currentPath.value = data.path;
    crumbs.value = data.path.split('/').filter(Boolean);
    children.value = data.children;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '加载失败';
  } finally {
    busy.value = false;
  }
}

function enterFolder(name: string) {
  const next = currentPath.value === '/' ? `/${name}` : `${currentPath.value}/${name}`;
  load(next);
}

async function mkdir() {
  const name = window.prompt('新建文件夹名称：');
  if (!name) return;
  try {
    const target = currentPath.value === '/' ? `/${name}` : `${currentPath.value}/${name}`;
    await api.mkdir(target);
    await load(currentPath.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '创建失败';
  }
}

function newTask(filename: string, size: number): UploadTask {
  const t: UploadTask = { id: ++taskSeq, filename, size, progress: 0, loaded: 0, phase: '等待中', error: '', aborted: false };
  uploadTasks.value.push(t);
  return t;
}

async function uploadFiles(files: FileList | null) {
  if (!files || files.length === 0) return;
  error.value = '';
  for (const file of Array.from(files)) {
    const task = newTask(file.name, file.size);
    try {
      if (file.size <= DIRECT_LIMIT) {
        await uploadSingleWithProgress(file, task);
      } else {
        await uploadChunked(file, task);
      }
      task.progress = 1;
      task.phase = '完成';
      notice.value = `已上传 ${file.name}`;
    } catch (e) {
      if (task.aborted) {
        task.phase = '已取消';
      } else {
        task.error = e instanceof ApiError ? e.message : '上传失败';
        task.phase = '失败';
      }
    }
  }
  setTimeout(() => (notice.value = ''), 3000);
  await load(currentPath.value);
  // 清理 3 分钟前的完成/失败任务（保留最近的）
  uploadTasks.value = uploadTasks.value.filter((t) => t.progress < 1 || t.error || Date.now() - t.id < 180000);
}

/** ≤24MiB：直传（浏览器算 hash+base64 → Worker 透传，带进度） */
async function uploadSingleWithProgress(file: File, task: UploadTask) {
  task.phase = '计算中';
  await uploadSingleFile(file, currentPath.value, (p) => {
    task.loaded = p.loaded;
    task.progress = p.total > 0 ? p.loaded / p.total : 0;
    task.phase = '上传中';
  });
}

/** >24MiB：分片上传（initiate → chunks → finalize），支持断点续传 */
async function uploadChunked(file: File, task: UploadTask) {
  // 尝试恢复未完成任务（同文件名+大小）
  const resumeKey = `${file.name}|${file.size}`;
  const resume = readResume(resumeKey);

  let init;
  if (resume) {
    try {
      const st = await api.uploadStatus(resume.uploadId);
      if (st.status === 'uploading' && st.totalSize === file.size && st.remotePath === currentPath.value) {
        init = st;
        task.phase = '续传中';
      } else {
        removeResume(resumeKey);
      }
    } catch {
      removeResume(resumeKey);
    }
  }
  if (!init) {
    init = await api.uploadInitiate(file.name, currentPath.value, file.size);
    saveResume(resumeKey, init.uploadId);
  }

  const { uploadId, chunkSize, totalChunks } = init;
  const uploaded = new Set<number>(init.uploaded ?? []);

  // 顺序上传缺失分片
  for (let i = 0; i < totalChunks; i++) {
    if (uploaded.has(i)) continue;
    if (task.aborted) throw new ApiError(0, '已取消');
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const blob = file.slice(start, end);
    task.phase = `分片 ${i + 1}/${totalChunks} 计算中`;
    await uploadChunkWithProgress(uploadId, i, blob, file.name, (p) => {
      // 整体进度 = 已传分片 + 当前分片内进度
      const base = (i * chunkSize) / file.size;
      task.loaded = Math.min(file.size, (i * chunkSize) + p.loaded);
      task.progress = Math.min(1, base + (p.loaded / Math.max(1, p.total)) * (blob.size / file.size));
      task.phase = `分片 ${i + 1}/${totalChunks} 上传中`;
    });
  }

  task.phase = '部署中';
  await api.uploadFinalize(uploadId);
  removeResume(resumeKey);
}

// ============ 断点续传 localStorage ============
function readResume(key: string): { uploadId: string } | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, { uploadId: string; ts: number }>;
    const entry = map[key];
    if (!entry) return null;
    // 超过 12h 视为失效
    if (Date.now() - entry.ts > 12 * 3600 * 1000) {
      removeResume(key);
      return null;
    }
    return { uploadId: entry.uploadId };
  } catch {
    return null;
  }
}
function saveResume(key: string, uploadId: string) {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, { uploadId: string; ts: number }>) : {};
    map[key] = { uploadId, ts: Date.now() };
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch {}
}
function removeResume(key: string) {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, unknown>;
    delete map[key];
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch {}
}

/** XHR 上传 FormData（直传用），回写任务进度 */
function retryTask(t: UploadTask) {
  t.error = '';
  t.progress = 0;
  t.loaded = 0;
  // 重新触发：用一个隐藏 input 不方便，直接重新执行上传（需要原文件）→ 简化：提示用户重新选择
  // 实际上分片可续传；直传只能重选。此处移除任务并提示。
  uploadTasks.value = uploadTasks.value.filter((x) => x.id !== t.id);
  notice.value = '请重新选择文件上传（直传不支持自动重试）';
  setTimeout(() => (notice.value = ''), 3000);
}
function cancelTask(t: UploadTask) {
  t.aborted = true;
}

async function doDownload(node: FileNode, versionId?: number) {
  const dt: DownloadTask = {
    id: ++downloadSeq, filename: node.name, progress: 0, loaded: 0, total: 0,
    phase: '正在解析文件', error: '',
  };
  downloadTasks.value.push(dt);

  try {
    const path = `${currentPath.value}/${node.name}`;
    const dl = await api.download(path, versionId);
    dt.total = dl.urls.reduce((s, u) => s + u.size, 0);
    dt.phase = dl.urls.length > 1 ? `准备下载 ${dl.urls.length} 个分片` : '正在连接服务器';

    const parts: Blob[] = [];
    const base = `?path=${encodeURIComponent(path)}${versionId ? `&versionId=${versionId}` : ''}`;
    let loadedSoFar = 0;

    for (let i = 0; i < dl.urls.length; i++) {
      dt.phase = dl.urls.length > 1 ? `下载中 ${i + 1}/${dl.urls.length}` : '下载中';
      const res = await fetch(`/api/files/raw${base}&chunk=${i}`, { credentials: 'include' });
      if (!res.ok) throw new ApiError(res.status, `下载分块失败: HTTP ${res.status}`);
      if (!res.body) throw new ApiError(0, '响应无数据流');

      // 流式读取 + 逐段更新进度
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let chunkReceived = 0;
      const chunkTotal = dl.urls[i].size;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        chunkReceived += value.length;
        dt.loaded = loadedSoFar + chunkReceived;
        dt.progress = dt.total > 0 ? Math.min(1, dt.loaded / dt.total) : 0;
      }
      parts.push(new Blob(chunks));
      loadedSoFar += chunkReceived;
    }

    dt.phase = '组装文件中';
    const blob = new Blob(parts);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = dl.filename;
    a.click();
    URL.revokeObjectURL(a.href);

    dt.phase = '下载完成';
    dt.progress = 1;
    dt.loaded = dt.total;
    notice.value = `已下载 ${node.name}`;
    setTimeout(() => (notice.value = ''), 3000);
  } catch (e) {
    dt.error = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : '下载失败');
    dt.phase = '下载失败';
  }

  // 3 秒后移除完成/失败的任务
  setTimeout(() => {
    downloadTasks.value = downloadTasks.value.filter((t) => t.id !== dt.id);
  }, 5000);
}

async function doPreview(node: FileNode) {
  window.open(`/api/files/raw?path=${encodeURIComponent(`${currentPath.value}/${node.name}`)}`, '_blank');
}

async function doPlay(node: FileNode) {
  emit('play', `${currentPath.value}/${node.name}`);
}

async function openVersions(node: FileNode) {
  versionDialog.value = { path: `${currentPath.value}/${node.name}`, name: node.name };
  newVersionName.value = '';
  const data = await api.versions(versionDialog.value.path);
  versions.value = data.versions;
}

async function renameVersion(v: { id: number; createdAt: string; name: string | null }) {
  if (!versionDialog.value) return;
  const name = window.prompt('版本名称（留空移除）：', v.name ?? '');
  if (name === null) return;
  await api.renameVersion(versionDialog.value.path, v.createdAt, name);
  const data = await api.versions(versionDialog.value.path);
  versions.value = data.versions;
}

async function cleanOldVersions() {
  if (!versionDialog.value) return;
  if (!window.confirm('清理该文件的所有旧版本（保留最新）？')) return;
  await api.cleanVersions(versionDialog.value.path);
  const data = await api.versions(versionDialog.value.path);
  versions.value = data.versions;
  await load(currentPath.value);
}

async function doRemove(node: FileNode) {
  if (!window.confirm(`确定删除 "${node.name}" ？`)) return;
  try {
    const path = `${currentPath.value}/${node.name}`;
    await api.remove(path);
    await load(currentPath.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '删除失败';
  }
}

async function doSearch() {
  const q = query.value.trim();
  if (!q) {
    searchResults.value = null;
    return;
  }
  try {
    searchResults.value = (await api.search(q)).results;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '搜索失败';
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(s: string): string {
  return new Date(s).toLocaleString();
}

onMounted(() => load('/'));
</script>

<template>
  <div class="drive">
    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="crumbs">
        <a class="crumb root" @click="load('/')">根目录</a>
        <template v-for="(c, i) in crumbs" :key="i">
          <span class="sep">/</span>
          <a class="crumb" @click="load(pathAt(i))">{{ c }}</a>
        </template>
      </div>
      <div class="actions">
        <button class="btn" @click="mkdir">新建文件夹</button>
        <button class="btn primary" @click="uploadInput?.click()">上传文件</button>
        <input ref="uploadInput" type="file" multiple hidden @change="uploadFiles($event.target?.files)" />
      </div>
    </div>

    <!-- 上传进度列表 -->
    <div v-if="uploadTasks.length" class="uploads">
      <UploadProgressBar
        v-for="t in uploadTasks"
        :key="'up-' + t.id"
        :filename="t.filename"
        :progress="t.progress"
        :loaded="t.loaded"
        :total="t.size"
        :error="t.error"
        :phase="t.phase"
        :visible="true"
        @retry="retryTask(t)"
        @cancel="cancelTask(t)"
      />
    </div>

    <!-- 下载进度列表 -->
    <div v-if="downloadTasks.length" class="uploads">
      <UploadProgressBar
        v-for="t in downloadTasks"
        :key="'dl-' + t.id"
        :filename="'📥 ' + t.filename"
        :progress="t.progress"
        :loaded="t.loaded"
        :total="t.total"
        :error="t.error"
        :phase="t.phase"
        :visible="true"
        @retry="() => {}"
        @cancel="() => {}"
      />
    </div>

    <!-- 搜索 -->
    <div class="searchbar">
      <input v-model="query" class="input" placeholder="搜索文件名 / 版本别名，回车执行" @keyup.enter="doSearch" />
      <button class="btn" @click="doSearch">搜索</button>
      <button v-if="searchResults" class="btn ghost" @click="searchResults = null; query = ''">清除</button>
    </div>

    <p v-if="error" class="msg err">{{ error }}</p>
    <p v-if="notice" class="msg ok">{{ notice }}</p>

    <!-- 搜索结果 -->
    <div v-if="searchResults" class="card">
      <h3>搜索结果（{{ searchResults.length }}）</h3>
      <div v-for="(r, i) in searchResults" :key="i" class="row">
        <span class="fname">{{ r.fileName }}</span>
        <span class="muted">版本 {{ fmtTime(r.createdAt) }}{{ r.versionName ? ` · 别名:${r.versionName}` : '' }}</span>
        <button class="btn sm" @click="doDownload({ id: r.fileId, name: r.fileName, type: 'file' } as any, r.versionId)">下载</button>
      </div>
    </div>

    <!-- 文件列表 -->
    <div class="card">
      <div v-if="busy" class="empty">加载中...</div>
      <div v-else-if="children.length === 0" class="empty">空目录</div>
      <div v-for="node in children" :key="node.id" class="row">
        <span class="icon">{{ node.type === 'folder' ? '📁' : '📄' }}</span>
        <a class="fname" @click="node.type === 'folder' ? enterFolder(node.name) : doPreview(node)">
          {{ node.name }}
        </a>
        <span class="muted meta">
          {{ node.type === 'file' && node.versions?.length ? fmtSize(node.versions[0].size) + ' · ' + node.versions.length + ' 个版本' : '' }}
        </span>
        <span class="muted meta">{{ fmtTime(node.modifiedAt) }}</span>
        <div class="op">
          <template v-if="node.type === 'file'">
            <button class="btn sm" title="在线播放（视频）" @click="doPlay(node)">▶</button>
            <button class="btn sm" @click="openVersions(node)">版本</button>
            <button class="btn sm" @click="doDownload(node)">下载</button>
          </template>
          <button class="btn sm danger" @click="doRemove(node)">删除</button>
        </div>
      </div>
    </div>

    <!-- 版本弹窗 -->
    <div v-if="versionDialog" class="modal-mask" @click.self="versionDialog = null">
      <div class="modal">
        <h3>版本历史 — {{ versionDialog.name }}</h3>
        <button class="btn sm" @click="cleanOldVersions">清理旧版本（保留最新）</button>
        <div v-for="v in versions" :key="v.id" class="row vrow">
          <span class="muted">{{ fmtTime(v.createdAt) }}{{ v.name ? ` · ${v.name}` : '' }}{{ v.shotAt ? ` · 拍摄:${fmtTime(v.shotAt)}` : '' }}</span>
          <div class="op">
            <button class="btn sm" @click="renameVersion(v)">命名</button>
            <button class="btn sm" @click="doDownload(versionDialog as any, v.id)">下载此版</button>
          </div>
        </div>
        <button class="btn ghost close" @click="versionDialog = null">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drive { max-width: 960px; margin: 0 auto; padding: 20px 16px 60px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.crumbs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.crumb { color: var(--primary); cursor: pointer; }
.crumb.root { font-weight: 500; }
.sep { color: var(--muted); }
.actions { display: flex; gap: 8px; }
.uploads { margin-bottom: 12px; }
.searchbar { display: flex; gap: 8px; margin-bottom: 12px; }
.input { flex: 1; border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 8px; }
.row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.row:last-child { border-bottom: none; }
.icon { width: 22px; text-align: center; }
.fname { flex: 1; cursor: pointer; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 12px; }
.muted { color: var(--muted); font-size: 12px; }
.op { display: flex; gap: 6px; }
.btn { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius); padding: 6px 12px; }
.btn.sm { padding: 4px 8px; font-size: 12px; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.btn.ghost { color: var(--muted); }
.empty { text-align: center; padding: 40px; color: var(--muted); }
.msg { padding: 6px 12px; border-radius: var(--radius); margin-bottom: 8px; font-size: 13px; }
.msg.err { background: #fdecec; color: var(--danger); }
.msg.ok { background: #e8f7ef; color: var(--primary-dark); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { background: var(--surface); border-radius: 12px; padding: 20px; width: 520px; max-height: 70vh; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.modal h3 { margin-bottom: 4px; }
.close { align-self: center; margin-top: 8px; }
.vrow { justify-content: space-between; }
</style>

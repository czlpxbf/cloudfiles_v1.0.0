<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, ApiError, type FileNode } from '../api/client';
import UploadProgressBar from '../components/UploadProgressBar.vue';
import { useUpload } from '../composables/useUpload';
import { useDownload } from '../composables/useDownload';

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

const { uploadTasks, uploadFiles, retryTask, cancelTask } = useUpload(currentPath, (name) => {
  notice.value = `已上传 ${name}`;
  setTimeout(() => (notice.value = ''), 3000);
  load(currentPath.value);
});

const { downloadTasks, doDownload } = useDownload(currentPath, (name) => {
  notice.value = `已下载 ${name}`;
  setTimeout(() => (notice.value = ''), 3000);
});

// 版本弹窗
const versionDialog = ref<{ path: string; name: string } | null>(null);
const versions = ref<{ id: number; size: number; createdAt: string; name: string | null; shotAt: string | null; isVideo: boolean }[]>([]);

function pathAt(i: number): string { return '/' + crumbs.value.slice(0, i + 1).join('/'); }

async function load(path: string) {
  busy.value = true; error.value = '';
  try {
    const data = await api.list(path);
    currentPath.value = data.path;
    crumbs.value = data.path.split('/').filter(Boolean);
    children.value = data.children;
  } catch (e) { error.value = e instanceof ApiError ? e.message : '加载失败'; }
  finally { busy.value = false; }
}

function enterFolder(name: string) { load(currentPath.value === '/' ? `/${name}` : `${currentPath.value}/${name}`); }

async function mkdir() {
  const name = window.prompt('新建文件夹名称：'); if (!name) return;
  try { await api.mkdir(currentPath.value === '/' ? `/${name}` : `${currentPath.value}/${name}`); await load(currentPath.value); }
  catch (e) { error.value = e instanceof ApiError ? e.message : '创建失败'; }
}

function isImage(name: string) { return /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name); }
function rawUrl(node: FileNode) { return `/api/files/raw?path=${encodeURIComponent(`${currentPath.value}/${node.name}`)}`; }
function doPreview(node: FileNode) { window.open(rawUrl(node), '_blank'); }
function doPlay(node: FileNode) { emit('play', `${currentPath.value}/${node.name}`); }

async function doRename(node: FileNode) {
  const newName = window.prompt('新名称：', node.name);
  if (!newName || newName === node.name) return;
  try {
    const src = `${currentPath.value}/${node.name}`;
    const dest = `${currentPath.value}/${newName}`;
    await api.move(src, dest);
    await load(currentPath.value);
  } catch (e) { error.value = e instanceof ApiError ? e.message : '重命名失败'; }
}

async function openVersions(node: FileNode) {
  versionDialog.value = { path: `${currentPath.value}/${node.name}`, name: node.name };
  const data = await api.versions(versionDialog.value.path);
  versions.value = data.versions;
}

async function renameVersion(v: { id: number; createdAt: string; name: string | null }) {
  if (!versionDialog.value) return;
  const name = window.prompt('版本名称（留空移除）：', v.name ?? '');
  if (name === null) return;
  await api.renameVersion(versionDialog.value.path, v.createdAt, name);
  versions.value = (await api.versions(versionDialog.value.path)).versions;
}

async function cleanOldVersions() {
  if (!versionDialog.value || !window.confirm('清理该文件的所有旧版本（保留最新）？')) return;
  await api.cleanVersions(versionDialog.value.path);
  versions.value = (await api.versions(versionDialog.value.path)).versions;
  await load(currentPath.value);
}

async function doRemove(node: FileNode) {
  if (!window.confirm(`确定删除 "${node.name}" ？`)) return;
  try { await api.remove(`${currentPath.value}/${node.name}`); await load(currentPath.value); }
  catch (e) { error.value = e instanceof ApiError ? e.message : '删除失败'; }
}

async function doSearch() {
  const q = query.value.trim(); if (!q) { searchResults.value = null; return; }
  try { searchResults.value = (await api.search(q)).results; }
  catch (e) { error.value = e instanceof ApiError ? e.message : '搜索失败'; }
}

function fmtSize(n: number) { return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
function fmtTime(s: string) { return new Date(s).toLocaleString(); }

onMounted(() => load('/'));
</script>

<template>
  <div class="drive">
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
        <input ref="uploadInput" type="file" multiple hidden @change="uploadFiles(($event.target as HTMLInputElement).files)" />
      </div>
    </div>

    <div v-if="uploadTasks.length" class="uploads">
      <UploadProgressBar v-for="t in uploadTasks" :key="'up-' + t.id" :filename="t.filename" :progress="t.progress" :loaded="t.loaded" :total="t.size" :error="t.error" :phase="t.phase" :visible="true" @retry="retryTask(t)" @cancel="cancelTask(t)" />
    </div>
    <div v-if="downloadTasks.length" class="uploads">
      <UploadProgressBar v-for="t in downloadTasks" :key="'dl-' + t.id" :filename="'📥 ' + t.filename" :progress="t.progress" :loaded="t.loaded" :total="t.total" :error="t.error" :phase="t.phase" :visible="true" @retry="() => {}" @cancel="() => {}" />
    </div>

    <div class="searchbar">
      <input v-model="query" class="input" placeholder="搜索文件名 / 版本别名" @keyup.enter="doSearch" />
      <button class="btn" @click="doSearch">搜索</button>
      <button v-if="searchResults" class="btn ghost" @click="searchResults = null; query = ''">清除</button>
    </div>

    <p v-if="error" class="msg err">{{ error }}</p>
    <p v-if="notice" class="msg ok">{{ notice }}</p>

    <div v-if="searchResults" class="card">
      <h3>搜索结果（{{ searchResults.length }}）</h3>
      <div v-for="(r, i) in searchResults" :key="i" class="row">
        <span class="fname">{{ r.fileName }}</span>
        <span class="muted">版本 {{ fmtTime(r.createdAt) }}{{ r.versionName ? ` · ${r.versionName}` : '' }}</span>
        <button class="btn sm" @click="doDownload({ id: r.fileId, name: r.fileName, type: 'file' } as any, r.versionId)">下载</button>
      </div>
    </div>

    <div class="card">
      <div v-if="busy" class="empty">加载中...</div>
      <div v-else-if="children.length === 0" class="empty">空目录</div>
      <div v-for="node in children" :key="node.id" class="row">
        <span class="icon">
          <img v-if="isImage(node.name)" :src="rawUrl(node)" class="thumb" loading="lazy" />
          <template v-else>{{ node.type === 'folder' ? '📁' : '📄' }}</template>
        </span>
        <a class="fname" @click="node.type === 'folder' ? enterFolder(node.name) : doPreview(node)">{{ node.name }}</a>
        <span class="muted meta">{{ node.type === 'file' && node.versions?.length ? fmtSize(node.versions[0].size) + ' · ' + node.versions.length + ' 个版本' : '' }}</span>
        <span class="muted meta">{{ fmtTime(node.modifiedAt) }}</span>
        <div class="op">
          <template v-if="node.type === 'file'">
            <button class="btn sm" title="播放" @click="doPlay(node)">▶</button>
            <button class="btn sm" @click="openVersions(node)">版本</button>
            <button class="btn sm" @click="doDownload(node)">下载</button>
          </template>
          <button class="btn sm" @click="doRename(node)">重命名</button>
          <button class="btn sm danger" @click="doRemove(node)">删除</button>
        </div>
      </div>
    </div>

    <div v-if="versionDialog" class="modal-mask" @click.self="versionDialog = null">
      <div class="modal">
        <h3>版本历史 — {{ versionDialog.name }}</h3>
        <button class="btn sm" @click="cleanOldVersions">清理旧版本</button>
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
.icon { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 4px; }
.thumb { width: 100%; height: 100%; object-fit: cover; }
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

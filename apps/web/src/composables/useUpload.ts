// useUpload — 上传逻辑：直传 + 分片 + 断点续传 + 进度回调
import { ref, type Ref } from 'vue';
import { api, ApiError, uploadSingleFile, uploadChunkWithProgress } from '../api/client';

export interface UploadTask {
  id: number;
  filename: string;
  size: number;
  progress: number;
  loaded: number;
  phase: string;
  error: string;
  aborted: boolean;
}

const DIRECT_LIMIT = 24 * 1024 * 1024;
const RESUME_KEY = 'cloudfiles_resume';

export function useUpload(remotePath: Ref<string>, onDone: (filename: string) => void) {
  const tasks = ref<UploadTask[]>([]);
  let seq = 0;

  function newTask(filename: string, size: number): UploadTask {
    const t: UploadTask = { id: ++seq, filename, size, progress: 0, loaded: 0, phase: '等待中', error: '', aborted: false };
    tasks.value.push(t);
    return t;
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const task = newTask(file.name, file.size);
      try {
        const uploadFile = file;

        if (uploadFile.size <= DIRECT_LIMIT) {
          await uploadSingleWithProgress(uploadFile, task);
        } else {
          await uploadChunked(uploadFile, task);
        }
        task.progress = 1;
        task.phase = '完成';
        onDone(uploadFile.name);
      } catch (e) {
        task.phase = task.aborted ? '已取消' : '失败';
        task.error = task.aborted ? '' : (e instanceof ApiError ? e.message : '上传失败');
      }
    }
    // 3min 后清完成/失败任务
    setTimeout(() => {
      tasks.value = tasks.value.filter((t) => t.progress < 1 || t.error || Date.now() - t.id < 180000);
    }, 180000);
  }

  async function uploadSingleWithProgress(file: File, task: UploadTask) {
    task.phase = '计算中';
    await uploadSingleFile(file, remotePath.value, (p) => {
      task.loaded = p.loaded;
      task.progress = p.total > 0 ? p.loaded / p.total : 0;
      task.phase = '上传中';
    });
  }

  async function uploadChunked(file: File, task: UploadTask) {
    const resumeKey = `${file.name}|${file.size}`;
    const resume = readResume(resumeKey);
    let init: any;
    if (resume) {
      try {
        const st = await api.uploadStatus(resume.uploadId);
        if (st.status === 'uploading' && st.totalSize === file.size && st.remotePath === remotePath.value) {
          init = st;
          task.phase = '续传中';
        } else { removeResume(resumeKey); }
      } catch { removeResume(resumeKey); }
    }
    if (!init) {
      init = await api.uploadInitiate(file.name, remotePath.value, file.size);
      saveResume(resumeKey, init.uploadId);
    }
    const { uploadId, chunkSize, totalChunks } = init;
    const uploaded = new Set<number>(init.uploaded ?? []);
    for (let i = 0; i < totalChunks; i++) {
      if (uploaded.has(i)) continue;
      if (task.aborted) throw new ApiError(0, '已取消');
      const blob = file.slice(i * chunkSize, Math.min((i + 1) * chunkSize, file.size));
      task.phase = `分片 ${i + 1}/${totalChunks} 计算中`;
      await uploadChunkWithProgress(uploadId, i, blob, file.name, (p) => {
        const base = (i * chunkSize) / file.size;
        task.loaded = Math.min(file.size, i * chunkSize + p.loaded);
        task.progress = Math.min(1, base + (p.loaded / Math.max(1, p.total)) * (blob.size / file.size));
        task.phase = `分片 ${i + 1}/${totalChunks} 上传中`;
      });
    }
    task.phase = '部署中';
    await api.uploadFinalize(uploadId);
    removeResume(resumeKey);
  }

  function retryTask(t: UploadTask) {
    tasks.value = tasks.value.filter((x) => x.id !== t.id);
  }
  function cancelTask(t: UploadTask) { t.aborted = true; }

  return { uploadTasks: tasks, uploadFiles, retryTask, cancelTask };
}

// === localStorage 断点续传 ===
function readResume(key: string): { uploadId: string } | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, { uploadId: string; ts: number }>;
    const entry = map[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > 12 * 3600 * 1000) { removeResume(key); return null; }
    return { uploadId: entry.uploadId };
  } catch { return null; }
}
function saveResume(key: string, uploadId: string) {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    const map: Record<string, { uploadId: string; ts: number }> = raw ? JSON.parse(raw) : {};
    map[key] = { uploadId, ts: Date.now() };
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch { /* quota/storage full, silently fail */ }
}
function removeResume(key: string) {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, unknown>;
    delete map[key];
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch { /* silently fail */ }
}

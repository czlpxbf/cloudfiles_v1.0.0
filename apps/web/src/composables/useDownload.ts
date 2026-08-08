// useDownload — 下载逻辑：流式读取 + 多分片拼接 + 阶段进度
import { ref, type Ref } from 'vue';
import { api, ApiError } from '../api/client';
import type { FileNode } from '../api/client';

export interface DownloadTask {
  id: number;
  filename: string;
  progress: number;
  loaded: number;
  total: number;
  phase: string;
  error: string;
}

export function useDownload(currentPath: Ref<string>, onDone: (filename: string) => void) {
  const tasks = ref<DownloadTask[]>([]);
  let seq = 0;

  async function doDownload(node: FileNode, versionId?: number) {
    const dt: DownloadTask = {
      id: ++seq, filename: node.name, progress: 0, loaded: 0, total: 0,
      phase: '正在解析文件', error: '',
    };
    tasks.value.push(dt);

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

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let chunkReceived = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          chunkReceived += value.length;
          dt.loaded = loadedSoFar + chunkReceived;
          dt.progress = dt.total > 0 ? Math.min(1, dt.loaded / dt.total) : 0;
        }
        parts.push(new Blob(chunks as BlobPart[]));
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
      onDone(node.name);
    } catch (e) {
      dt.error = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : '下载失败');
      dt.phase = '下载失败';
    }

    setTimeout(() => {
      tasks.value = tasks.value.filter((t) => t.id !== dt.id);
    }, 5000);

    return dt;
  }

  return { downloadTasks: tasks, doDownload };
}

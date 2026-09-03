// useTranscoder — 浏览器端 ffmpeg.wasm 视频转码（H.265→H.264 + faststart）
import { ref } from 'vue';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;
const coreLoaded = ref(false);
const coreLoadPromise: Promise<FFmpeg> | null = null;

/** 懒加载 ffmpeg.wasm（31MB 首次下载，缓存后续复用） */
async function loadFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (coreLoadPromise) return coreLoadPromise;

  const p = (async () => {
    ffmpeg = new FFmpeg();
    const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({ coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'), wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm') });
    coreLoaded.value = true;
    return ffmpeg!;
  })();

  return p;
}

export interface TranscodeTask {
  phase: string;
  progress: number; // 0~1
  outputSize: number;
}

/** 检测视频是否需要转码（H.265 → H.264、moov 位置修复） */
export function needsTranscode(file: File): boolean {
  return file.type === 'video/mp4' || file.name.endsWith('.mp4');
}

/** 转码视频：H.265→H.264 + faststart，返回转码后的 Blob */
export async function transcodeVideo(
  file: File,
  onProgress: (t: TranscodeTask) => void,
): Promise<File> {
  const f = await loadFFmpeg();
  onProgress({ phase: '加载转码引擎', progress: 0, outputSize: 0 });

  const inputName = 'input.mp4';
  const outputName = 'output.mp4';

  await f.writeFile(inputName, await fetchFile(file));
  onProgress({ phase: '开始转码（H.264+faststart）', progress: 0.05, outputSize: 0 });

  // ffmpeg 进度回调
  f.on('progress', ({ progress: p, time }) => {
    onProgress({ phase: `转码中 ${time ? Math.floor(time / 1000000) + 's' : ''}`, progress: 0.05 + p * 0.85, outputSize: 0 });
  });

  await f.exec([
    '-i', inputName,
    '-c:v', 'libx264', '-crf', '23',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-preset', 'fast',
    outputName,
  ]);

  onProgress({ phase: '读取转码结果', progress: 0.92, outputSize: 0 });
  const data = await f.readFile(outputName);
  await f.deleteFile(inputName);
  await f.deleteFile(outputName);

  const blob = new Blob([data as BlobPart], { type: 'video/mp4' });
  const ext = file.name.split('.').pop() || 'mp4';
  const newName = file.name.replace(new RegExp(`\\.${ext}$`), '_h264.' + ext);

  onProgress({ phase: '转码完成', progress: 1, outputSize: blob.size });
  return new File([blob], newName, { type: 'video/mp4' });
}

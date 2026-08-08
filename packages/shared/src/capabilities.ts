// @cloudfiles/shared - 能力插件契约（MASTER_PLAN §2.3）
// 开源贡献者实现这些接口扩展能力，不改核心。

/** 文件类型处理器：决定某类文件如何预览/播放/生成缩略图/提取元数据 */
export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'archive' | 'binary';

export type PreviewMode = 'inline' | 'proxy' | 'stream' | 'download';

export interface FileTypeHandler {
  /** 匹配的扩展名（不含点，小写） */
  extensions: string[];
  kind: FileKind;
  /** 浏览器端预览策略 */
  preview: { mode: PreviewMode; proxyPath?: string };
  /** 缩略图生成方式 */
  thumb?: { generator: 'cli' | 'client' | 'none'; size?: number };
  /** 元数据提取 */
  meta?: 'exif' | 'ffprobe' | 'none';
  /** 流式播放（视频/音频） */
  playable?: { protocol: 'hls' | 'dash' | 'raw' };
}

/** 播放协议适配器：hls.js / dash.js / 原生 <video> */
export interface PlayerAdapter {
  protocol: 'hls' | 'dash' | 'raw';
  manifestSuffix: string; // .m3u8 / .mpd / 无
  library?: string; // CDN 地址（前端动态加载）
}

/** 元数据刮削器（可选插件） */
export interface Scraper {
  name: string;
  search(q: string): Promise<ScrapedMeta[]>;
  enrich(id: string): Promise<ScrapedMeta>;
}

export interface ScrapedMeta {
  title: string;
  originalTitle?: string;
  year?: number;
  rating?: number;
  genres?: string[];
  posterUrl?: string;
  directors?: string[];
  actors?: string[];
  plot?: string;
}

// ---------- 内置处理器注册表（可被外部插件扩展） ----------
export const builtinHandlers: FileTypeHandler[] = [
  { extensions: ['txt','md','json','js','ts','jsx','tsx','css','scss','html','htm','xml','yaml','yml','ini','conf','cfg','log','csv','sh','bat','py','java','c','cpp','h','hpp','go','rs','rb','php','sql','vue'], kind: 'text', preview: { mode: 'inline', proxyPath: '/api/preview' }, meta: 'none' },
  { extensions: ['jpg','jpeg','png','webp','gif','bmp','svg'], kind: 'image', preview: { mode: 'inline' }, thumb: { generator: 'client', size: 480 }, meta: 'exif' },
  { extensions: ['heic','heif'], kind: 'image', preview: { mode: 'download' }, thumb: { generator: 'cli', size: 480 }, meta: 'exif' },
  { extensions: ['mp4','webm','mkv','mov','avi','m4v'], kind: 'video', preview: { mode: 'stream' }, thumb: { generator: 'cli', size: 480 }, meta: 'ffprobe', playable: { protocol: 'raw' } }, // Stage 2B 后改为 hls
  { extensions: ['mp3','m4a','ogg','flac','wav','aac'], kind: 'audio', preview: { mode: 'stream' }, thumb: { generator: 'none' }, meta: 'ffprobe', playable: { protocol: 'raw' } },
  { extensions: ['pdf'], kind: 'document', preview: { mode: 'proxy', proxyPath: '/api/preview' }, thumb: { generator: 'none' }, meta: 'none' },
  { extensions: ['doc','docx','xls','xlsx','ppt','pptx'], kind: 'document', preview: { mode: 'download' }, thumb: { generator: 'none' }, meta: 'none' },
  { extensions: ['zip','rar','7z','tar','gz'], kind: 'archive', preview: { mode: 'download' }, thumb: { generator: 'none' }, meta: 'none' },
];

/** 根据文件名解析类型处理器 */
export function resolveHandler(filename: string, registry: FileTypeHandler[] = builtinHandlers): FileTypeHandler {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return registry.find((h) => h.extensions.includes(ext)) ?? {
    extensions: [], kind: 'binary', preview: { mode: 'download' }, meta: 'none',
  } as FileTypeHandler;
}

/** 内置播放器适配器 */
export const playerAdapters: Record<string, PlayerAdapter> = {
  hls: { protocol: 'hls', manifestSuffix: '.m3u8', library: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js' },
  dash: { protocol: 'dash', manifestSuffix: '.mpd', library: 'https://cdn.jsdelivr.net/npm/dashjs@4/dist/dash.all.min.js' },
  raw: { protocol: 'raw', manifestSuffix: '' },
};

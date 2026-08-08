<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../api/client';

const props = defineProps<{ path: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const error = ref('');
const manifestUrl = ref('');
const protocol = ref('raw');
const library = ref('');
const poster = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('播放器库加载失败'));
    document.head.appendChild(s);
  });
}

async function initPlayer() {
  if (!manifestUrl.value || !videoEl.value) return;
  try {
    if (protocol.value === 'hls' && library.value) {
      await loadScript(library.value);
      const Hls = (window as any).Hls;
      if (Hls && Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(manifestUrl.value);
        hls.attachMedia(videoEl.value);
      } else if (videoEl.value.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.value.src = manifestUrl.value; // iOS 原生
      }
    } else if (protocol.value === 'dash' && library.value) {
      await loadScript(library.value);
      const dashjs = (window as any).dashjs;
      if (dashjs) {
        dashjs.MediaPlayer().create().initialize(videoEl.value, manifestUrl.value, true);
      }
    } else if (protocol.value === 'raw') {
      videoEl.value.src = manifestUrl.value;
    }
  } catch (e: any) {
    error.value = e?.message || '播放器初始化失败';
  }
}

onMounted(async () => {
  try {
    const data = await api.play(props.path);
    protocol.value = data.protocol;
    manifestUrl.value = data.manifestUrl;
    library.value = data.library || '';
    poster.value = data.poster || '';
    await initPlayer();
  } catch (e: any) {
    error.value = e?.message || '无法获取播放地址';
  }
});
</script>

<template>
  <div class="player-wrap">
    <div class="bar">
      <button class="btn" @click="emit('back')">← 返回</button>
      <span class="name">{{ props.path }}</span>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <div v-else class="stage">
      <video ref="videoEl" class="video" controls :poster="poster"></video>
      <p v-if="!manifestUrl" class="muted">加载播放器中...</p>
    </div>
    <p class="hint muted">协议: {{ protocol }}{{ manifestUrl ? ' · ' + manifestUrl : '' }}</p>
  </div>
</template>

<style scoped>
.player-wrap { max-width: 960px; margin: 0 auto; padding: 20px 16px; }
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stage { background: #000; border-radius: 12px; overflow: hidden; }
.video { width: 100%; max-height: 70vh; display: block; background: #000; }
.err { color: var(--danger); padding: 20px; }
.muted { color: var(--muted); padding: 16px; }
.hint { font-size: 12px; margin-top: 10px; word-break: break-all; }
.btn { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius); padding: 6px 14px; }
</style>

<script setup lang="ts">
// 独立上传进度条组件：显示单文件进度、速度、已传大小
import { ref, watch, computed } from 'vue';

const props = defineProps<{
  filename: string;
  /** 0 ~ 1 的进度 */
  progress: number;
  /** 已传字节数 */
  loaded: number;
  /** 总字节数（0 表示未知） */
  total: number;
  /** 错误信息（非空则显示错误态） */
  error?: string;
  /** 当前阶段文案（如 上传中/合并中/部署中） */
  phase?: string;
  /** 是否显示（挂载后立即显示） */
  visible?: boolean;
}>();

const emit = defineEmits<{ (e: 'retry'): void; (e: 'cancel'): void }>();

const shown = ref(!!props.visible);
watch(() => props.visible, (v) => (shown.value = !!v));

// 速度估算：记录最近 3 秒的字节增量
const speed = ref(0);
let lastLoaded = 0;
let lastTime = 0;
watch(
  () => props.loaded,
  (cur) => {
    const now = Date.now();
    if (lastTime) {
      const dt = (now - lastTime) / 1000;
      if (dt > 0.05) speed.value = Math.max(0, (cur - lastLoaded) / dt);
    }
    lastLoaded = cur;
    lastTime = now;
  },
  { immediate: true },
);

const pct = computed(() => {
  if (props.total <= 0) return 0;
  return Math.min(100, Math.round((props.loaded / props.total) * 100));
});

const speedText = computed(() => {
  if (speed.value <= 0) return '';
  return `${fmtBytes(speed.value)}/s`;
});

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div v-if="shown" class="upload-item" :class="{ err: !!error }">
    <div class="head">
      <span class="name" :title="filename">{{ filename }}</span>
      <span v-if="error" class="phase err-text">{{ error }}</span>
      <span v-else class="phase">
        {{ phase || '上传中' }} {{ pct > 0 ? pct + '%' : progress > 0 ? Math.round(progress * 100) + '%' : '' }}
        <template v-if="total > 0">（{{ fmtBytes(loaded) }}/{{ fmtBytes(total) }}）</template>
        <template v-if="speedText"> {{ speedText }}</template>
      </span>
    </div>
    <div class="bar-wrap">
      <div class="bar" :style="{ width: pct + '%' }" :class="{ done: pct >= 100 && !error }"></div>
    </div>
    <div v-if="error" class="ops">
      <button class="btn sm" @click="emit('retry')">重试</button>
      <button class="btn sm ghost" @click="emit('cancel')">取消</button>
    </div>
  </div>
</template>

<style scoped>
.upload-item {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e2e5ea);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
.upload-item.err { border-color: var(--danger, #e5484d); }
.head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text, #1a1d21); }
.phase { color: var(--muted, #8a919c); font-size: 12px; white-space: nowrap; }
.err-text { color: var(--danger, #e5484d); }
.bar-wrap { height: 6px; background: var(--border, #e2e5ea); border-radius: 3px; overflow: hidden; }
.bar { height: 100%; background: var(--primary, #4f6ef7); border-radius: 3px; transition: width 0.2s ease; }
.bar.done { background: #34c759; }
.ops { display: flex; gap: 8px; margin-top: 8px; }
.btn { border: 1px solid var(--border, #e2e5ea); background: var(--surface, #fff); border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.btn.ghost { color: var(--muted, #8a919c); }
</style>

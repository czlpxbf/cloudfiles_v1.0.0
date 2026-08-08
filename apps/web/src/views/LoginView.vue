<script setup lang="ts">
import { ref } from 'vue';
import { api, ApiError } from '../api/client';

const emit = defineEmits<{ (e: 'login', user: { id: number; username: string }): void }>();

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const data = mode.value === 'login'
      ? await api.login(username.value, password.value)
      : await api.register(username.value, password.value);
    emit('login', data.user);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '请求失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <form class="card" @submit.prevent="submit">
      <h1 class="title">CLOUDFILES</h1>
      <p class="sub">部署即存储的免费无限网盘</p>
      <input v-model="username" class="input" placeholder="用户名" autocomplete="username" />
      <input v-model="password" type="password" class="input" placeholder="密码（至少 8 位）" autocomplete="current-password" />
      <p v-if="error" class="err">{{ error }}</p>
      <button class="btn primary" type="submit" :disabled="busy">
        {{ busy ? '请稍候...' : mode === 'login' ? '登 录' : '注 册' }}
      </button>
      <a class="switch" @click="mode = mode === 'login' ? 'register' : 'login'">
        {{ mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录' }}
      </a>
    </form>
  </div>
</template>

<style scoped>
.wrap { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
.card { display: flex; flex-direction: column; gap: 14px; width: 320px; padding: 36px 32px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.title { text-align: center; letter-spacing: 3px; color: var(--primary-dark); }
.sub { text-align: center; color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.input { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; font-size: 14px; }
.input:focus { outline: 2px solid var(--primary); border-color: transparent; }
.err { color: var(--danger); font-size: 12px; }
.btn { padding: 10px; border-radius: var(--radius); }
.btn.primary { background: var(--primary); border: none; color: #fff; font-size: 14px; }
.btn.primary:disabled { opacity: 0.6; }
.switch { text-align: center; color: var(--primary); font-size: 12px; cursor: pointer; }
</style>

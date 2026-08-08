<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from './api/client';
import LoginView from './views/LoginView.vue';
import DriveView from './views/DriveView.vue';
import PlayerView from './views/PlayerView.vue';

const user = ref<{ id: number; username: string } | null>(null);
const view = ref<'drive' | 'player'>('drive');
const playingPath = ref('');
const loading = ref(true);

onMounted(async () => {
  try {
    user.value = (await api.me()).user;
  } catch {
    user.value = null;
  }
  loading.value = false;
});

function onLogin(u: { id: number; username: string }) {
  user.value = u;
}

function onLogout() {
  api.logout().finally(() => {
    user.value = null;
  });
}

function openPlayer(path: string) {
  playingPath.value = path;
  view.value = 'player';
}
</script>

<template>
  <div v-if="loading" class="boot">加载中...</div>
  <LoginView v-else-if="!user" @login="onLogin" />
  <template v-else>
    <header class="topbar">
      <div class="brand">CLOUDFILES</div>
      <div class="userbox">
        <span class="uname">{{ user.username }}</span>
        <button class="btn ghost" @click="onLogout">退出</button>
      </div>
    </header>
    <DriveView v-if="view === 'drive'" @play="openPlayer" />
    <PlayerView v-else :path="playingPath" @back="view = 'drive'" />
  </template>
</template>

<style scoped>
.boot { display: flex; justify-content: center; padding: 80px; color: var(--muted); }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--border); }
.brand { font-weight: 700; letter-spacing: 2px; color: var(--primary-dark); }
.userbox { display: flex; gap: 12px; align-items: center; }
.uname { color: var(--muted); }
.btn { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius); padding: 6px 14px; }
.btn.ghost { color: var(--muted); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
</style>

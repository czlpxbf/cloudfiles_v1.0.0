import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    cache: { dir: '../../.tmp-vitest-cache' },
  },
});

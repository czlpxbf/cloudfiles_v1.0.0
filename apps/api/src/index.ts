// Cloudflare Worker 入口
import { createApp } from './app';
import type { Env } from './env';

export { HashDo } from './do/HashDo';
export { MediaDo } from './do/MediaDo';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = createApp();
    return app.fetch(request, env, ctx);
  },
};

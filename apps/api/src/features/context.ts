// 共享上下文：根据 Env 构建 Repo（测试注入 memory，生产用 D1）
import { D1Repo, MemoryRepo, type Repo } from '../db';
import type { Env } from '../env';

/** MemoryRepo 为进程内状态，必须单例共享；D1 无状态可每次新建 */
export function createDb(env: Env): Repo {
  if (!env.DB) {
    const e = env as Env & { _repo?: Repo };
    if (!e._repo) e._repo = new MemoryRepo();
    return e._repo;
  }
  return new D1Repo(env.DB);
}

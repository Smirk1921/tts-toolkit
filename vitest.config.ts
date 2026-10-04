// vitest.config.ts
// 限制 worker 数：Windows 下 git 子进程清理慢，默认 maxWorkers（CPU 核数）
// 会让并发跑的 git 测试在 afterEach 的 rm 上撞 EBUSY。
// maxWorkers=2 / minWorkers=1 是经验值，本地全套 963 用例 ~80s 可过。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    minWorkers: 1,
    // 单个测试默认 5s 对构造 git merge 冲突的用例不够，放宽到 30s
    testTimeout: 30_000,
    // hook 超时同步放宽（beforeEach/afterEach 里的 git init / rm）
    hookTimeout: 30_000,
  },
});

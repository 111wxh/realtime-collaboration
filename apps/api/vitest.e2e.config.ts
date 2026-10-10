import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * e2e 配置：需要真实的 PostgreSQL（必要时 Redis）。
 *   docker compose up -d postgres redis
 *   pnpm --filter api test:e2e
 *
 * 与单测的差别：
 *  - include 换成 test/ 下的 *.e2e.test.ts；
 *  - 不并行文件（多个测试套件共用一个数据库，串行跑更好排查）；
 *  - 超时放宽，给迁移/首次连接留余量。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // e2e 里 dotenv 由测试自身加载（apps/api/.env），这里不再注入
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
});

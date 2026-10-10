import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * 单测配置。
 *
 * 为什么必须用 unplugin-swc（而不是 vitest 默认的 esbuild）：Nest 的 DI 依赖
 * `emitDecoratorMetadata` 生成的 `design:paramtypes`，esbuild 不做这件事，
 * 少了它所有构造器注入都会在运行期变成 undefined。swc 能做到，
 * 顺带编译速度快很多。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // 单测全部不依赖数据库/Redis：CI 与本地都能直接跑
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

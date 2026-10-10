import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 配置文件所在目录（apps/web），跨平台不需要 __dirname */
const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * 前端单测：jsdom 环境。
 *
 * - `@collab/shared` 直接 alias 到 shared 的 src（与 next.config 的 transpilePackages 同理），
 *   测试里跑的是同一份协议源码，不用等 shared 先 build；
 * - 纯逻辑测试（hitTest / interaction / sync-core）不触碰 DOM，jsdom 只是兜底；
 * - JSX 交给 esbuild 的 automatic runtime，不引 @vitejs/plugin-react，
 *   避免 vite 7/8 两份类型定义打架（vitest 3 依赖 vite 7，插件按 vite 8 发布）。
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': root.replace(/[\\/]$/, ''),
      '@collab/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'lib/**/*.test.ts',
      'lib/**/*.test.tsx',
      'stores/**/*.test.ts',
      'components/**/*.test.tsx',
      'app/**/*.test.tsx',
    ],
    exclude: ['node_modules/**', '.next/**'],
  },
});

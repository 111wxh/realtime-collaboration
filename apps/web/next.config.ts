import type { NextConfig } from 'next';

/**
 * REST 代理目标：容器里用 API_INTERNAL_URL=http://api:3001 覆盖，
 * 本地开发回落到 NEXT_PUBLIC_API_URL（http://localhost:3001），再兜底 localhost。
 *
 * 前端一律请求相对路径 `/api/...`：浏览器只跟 Next 同源打交道，
 * 既没有 CORS 问题，refresh_token 的 httpOnly cookie 也落在同源上，容器里无需改构建产物。
 */
const apiOrigin = (
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:3001'
)
  .trim()
  .replace(/\/+$/, '');

const nextConfig: NextConfig = {
  // @collab/shared 的 exports 直指 src（TS 源码）：让 Next 一起编译，
  // 前端改协议类型不需要等 shared 先 build。API 端走 dist（CommonJS）。
  transpilePackages: ['@collab/shared'],

  // 容器化交付：产出 .next/standalone（自带最小运行时的 server.js + 追踪到的依赖），
  // 由 infra/docker/Dockerfile.web 拷贝进运行时镜像。只影响 `next build`，
  // 本地 `next dev` 行为不变。
  // monorepo 下产物路径为 .next/standalone/apps/web/server.js。
  output: 'standalone',

  async rewrites() {
    return [
      // 只代理 REST；WebSocket（socket.io）由浏览器直连 API，握手靠 auth.token 而非 cookie
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
    ];
  },
};

export default nextConfig;

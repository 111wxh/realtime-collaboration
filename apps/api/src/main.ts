// 环境变量必须最先加载：网关的装饰器选项（WS_MAX_BUFFER / CORS_ORIGIN）
// 在模块求值时就读取 process.env，晚一步就会读到空值。
import 'dotenv/config';
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  // 结构化日志（pino）接管 Nest 的 Logger；bufferLogs 保证启动早期的日志也不丢
  app.useLogger(app.get(Logger));
  // 反向代理（Caddy/Nginx）后面才能拿到真实协议：刷新 cookie 的 Secure 标志
  // 依赖 req.secure 判断——不信任代理头的话 HTTPS 部署会被判成 http
  app.set('trust proxy', 1);

  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
    credentials: true,
  });
  // 刷新令牌走 httpOnly cookie，REST 侧需要 cookie 解析
  app.use(cookieParser());
  // 注意：这里刻意**不挂 class-validator 的全局 ValidationPipe**。
  // 全项目的输入校验统一走 zod（@collab/shared 的协议 schema + 各模块的 REST DTO），
  // 由 ZodValidationPipe 在各自的路由上负责；额外挂 ValidationPipe 会去 require
  // 未安装的 class-validator（Nest 的 loadPackage 会直接 process.exit(1) 杀掉进程）。
  // 业务接口统一 /api 前缀；探活/就绪保持根路径（K8s/负载均衡惯用）
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  // 日志里能串起一条完整链路：每个请求一个 id，出错时前端把 id 报上来即可定位
  app.use(
    (
      req: { headers: Record<string, unknown> },
      res: { setHeader(k: string, v: string): void },
      next: () => void,
    ) => {
      const headerName = 'x-request-id';
      const existing = req.headers[headerName];
      const requestId =
        typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
      req.headers[headerName] = requestId;
      res.setHeader(headerName, requestId);
      next();
    },
  );
  // Prisma / Redis 在 SIGTERM 时优雅断开
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  app.get(Logger).log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();

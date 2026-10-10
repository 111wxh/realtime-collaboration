/**
 * 进程配置：环境变量只在这里读一次，其余模块依赖注入 AppConfig。
 * 好处是跑测试时可以注入一套假配置，不用改 process.env。
 */

export interface AppConfig {
  nodeEnv: string;
  port: number;
  /** 允许的跨域来源（CORS_ORIGIN 逗号分隔） */
  corsOrigins: string[];
  databaseUrl: string;
  /** 为空表示不启用 Redis（presence / 限流退化到进程内存，便于本地无依赖跑测试） */
  redisUrl: string | null;
  jwtSecret: string;
  jwtExpiresIn: JwtExpiresIn;
  refreshTokenTtlMs: number;
  wsMaxBuffer: number;
  oplogRetentionDays: number;
  logLevel: string;
  /** presence 键 TTL（秒）：多实例共享的在线状态靠它自动过期 */
  presenceTtlSeconds: number;
  /** 单房间在线成员刷新 TTL 的间隔（毫秒） */
  presenceTouchIntervalMs: number;
  /**
   * 刷新 cookie 的 Secure 标志：null = 跟随请求协议（HTTPS/反代下自动开），
   * 显式配置用于特殊部署（如全栈 compose 走 http://localhost 时强制关闭）。
   */
  cookieSecure: boolean | null;
}

export const APP_CONFIG = 'APP_CONFIG';

/**
 * jsonwebtoken / ms 接受的时长字面量（`15m` / `30d` …）。
 * 收窄成模板字面量而不是 string：配置写错时在编译期就能发现。
 */
export type JwtExpiresIn = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}` | number;

/**
 * 解析 `30d` / `15m` / `30s` / `500ms` 这类时长；纯数字按秒处理（与 JWT 生态一致）。
 * 解析不了时返回 fallback，而不是抛错——配置错不该让进程起不来。
 */
export function parseDurationMs(input: string | undefined, fallbackMs: number): number {
  if (!input) return fallbackMs;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
  if (!match) return fallbackMs;
  const value = Number(match[1] ?? 0);
  const unit = (match[2] ?? 'ms') as 'ms' | 's' | 'm' | 'h' | 'd';
  const factor: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(value * (factor[unit] ?? 1));
}

function toInt(input: string | undefined, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 三态布尔：未配置返回 null（表示"按运行环境推断"），非法值也按未配置处理 */
function toOptionalBool(input: string | undefined): boolean | null {
  if (input === undefined || input.trim() === '') return null;
  const value = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) {
    throw new Error('DATABASE_URL 未配置：PostgreSQL 是权威状态存储，缺少它无法启动');
  }
  const redisUrl = env.REDIS_URL?.trim() ? env.REDIS_URL.trim() : null;
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: toInt(env.PORT, 3001),
    corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    databaseUrl,
    redisUrl,
    jwtSecret: env.JWT_SECRET ?? 'dev-only-change-me',
    jwtExpiresIn: (env.JWT_EXPIRES_IN ?? '15m') as JwtExpiresIn,
    refreshTokenTtlMs: parseDurationMs(env.REFRESH_TOKEN_TTL, 30 * 86_400_000),
    wsMaxBuffer: toInt(env.WS_MAX_BUFFER, 1_048_576),
    oplogRetentionDays: toInt(env.OPLOG_RETENTION_DAYS, 7),
    logLevel: env.LOG_LEVEL ?? 'info',
    presenceTtlSeconds: toInt(env.PRESENCE_TTL_SECONDS, 60),
    presenceTouchIntervalMs: toInt(env.PRESENCE_TOUCH_INTERVAL_MS, 20_000),
    cookieSecure: toOptionalBool(env.COOKIE_SECURE),
  };
}

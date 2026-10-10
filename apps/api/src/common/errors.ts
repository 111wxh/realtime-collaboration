import { ERROR_CODES, type ErrorCode } from '@collab/shared';

/**
 * 领域错误：携带协议错误码（@collab/shared 的 ERROR_CODES）与 HTTP 状态。
 *
 * 为什么要自建一层而不是直接用 Nest 的 HttpException：
 *  - 协议里 `code` 是机器读的字段（§6.4 的 error 事件 / REST 错误响应），
 *    HttpException 只有状态码，没有这个语义；
 *  - WS 与 REST 两条链路都抛同一种错误，全局过滤器各按各的格式翻译。
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 错误码 → HTTP 状态的默认映射（个别场景可用 AppError 构造器覆盖） */
export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ERROR_CODES.UNAUTHENTICATED]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.ALREADY_EXISTS]: 409,
  [ERROR_CODES.VALIDATION_FAILED]: 400,
  [ERROR_CODES.VERSION_CONFLICT]: 409,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.ROOM_FULL]: 409,
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [ERROR_CODES.CONFLICT]: 409,
  [ERROR_CODES.INTERNAL]: 500,
};

export function appError(code: ErrorCode, message: string, detail?: unknown): AppError {
  return new AppError(code, message, HTTP_STATUS_BY_CODE[code], detail);
}

export const unauthenticated = (message = '未登录或登录已失效'): AppError =>
  appError(ERROR_CODES.UNAUTHENTICATED, message);

export const forbidden = (message = '无权访问该资源'): AppError =>
  appError(ERROR_CODES.FORBIDDEN, message);

export const notFound = (message = '资源不存在'): AppError =>
  appError(ERROR_CODES.NOT_FOUND, message);

export const alreadyExists = (message = '资源已存在'): AppError =>
  appError(ERROR_CODES.ALREADY_EXISTS, message);

export const conflict = (message = '状态冲突'): AppError => appError(ERROR_CODES.CONFLICT, message);

export const internal = (message = '服务器内部错误'): AppError =>
  appError(ERROR_CODES.INTERNAL, message);

export function validationFailed(message: string, detail?: unknown): AppError {
  return appError(ERROR_CODES.VALIDATION_FAILED, message, detail);
}

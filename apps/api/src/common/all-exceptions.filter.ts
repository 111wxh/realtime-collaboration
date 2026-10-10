import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@collab/shared';

import { AppError } from './errors';

interface HttpReply {
  status(code: number): { json(body: unknown): unknown };
}

/** REST 错误响应体：与协议 §6.4 的 error 事件同一形状 */
interface ErrorBody {
  code: ErrorCode;
  message: string;
  requestId?: string;
}

/** 结构化日志的最小接口（避免直接依赖 pino 的实现类型） */
export interface ErrorLogger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/** HTTP 状态码 → 协议错误码（REST 只回 {code,message}，前端 switch code 即可） */
function codeFromHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODES.VALIDATION_FAILED;
    case 401:
      return ERROR_CODES.UNAUTHENTICATED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 413:
      return ERROR_CODES.PAYLOAD_TOO_LARGE;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    default:
      return status >= 500 ? ERROR_CODES.INTERNAL : ERROR_CODES.VALIDATION_FAILED;
  }
}

/**
 * 全局异常出口：所有 REST 错误统一成 `{ code, message }`（协议 §6.4 的 error 形状）。
 * 5xx 带 traceId 打 error 日志，4xx 只记 warn——否则日志会被探测流量刷爆。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: ErrorLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType<'http' | 'ws'>() === 'ws') {
      // WS 侧的异常原则上在网关里就地翻译成 error/shape:rejected；
      // 走到这里说明是兜底路径，只保证"不崩 + 有日志"。
      this.logger.error({ err: exception }, 'WS 未捕获异常');
      return;
    }

    const http = host.switchToHttp();
    const response = http.getResponse<HttpReply>();
    const request = http.getRequest<{ headers?: Record<string, unknown>; url?: string }>();
    const requestId = request?.headers?.['x-request-id'];
    const { status, body } = this.normalize(exception, requestId);

    if (status >= 500) {
      this.logger.error({ err: exception, requestId, url: request?.url }, 'REST 未捕获异常');
    } else {
      this.logger.warn({ code: body.code, requestId, url: request?.url }, 'REST 请求被拒');
    }
    response.status(status).json(body);
  }

  private normalize(exception: unknown, requestId: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        body: { code: exception.code, message: exception.message },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      let message: string;
      if (typeof response === 'string') {
        message = response;
      } else if (response && typeof response === 'object') {
        const raw = response as { message?: unknown };
        message = Array.isArray(raw.message)
          ? raw.message.map(String).join('; ')
          : String(raw.message ?? exception.message);
      } else {
        message = exception.message;
      }
      return {
        status,
        body: {
          code: codeFromHttpStatus(status),
          // 5xx 不把内部细节透给客户端，排查靠日志里的 requestId
          message: status >= 500 ? '服务器内部错误' : message,
          ...(status >= 500 && typeof requestId === 'string' ? { requestId } : {}),
        },
      };
    }

    return {
      status: 500,
      body: {
        code: ERROR_CODES.INTERNAL,
        message: '服务器内部错误',
        ...(typeof requestId === 'string' ? { requestId } : {}),
      },
    };
  }
}

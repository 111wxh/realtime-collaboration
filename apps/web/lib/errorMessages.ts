/**
 * 错误码 → 中文文案。前端只对 code 做映射，永不解析 message（见 shared/errors.ts 约定）。
 */
import { ERROR_CODES, type ErrorCode } from '@collab/shared';

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ERROR_CODES.UNAUTHENTICATED]: '登录状态已失效，请重新登录',
  [ERROR_CODES.FORBIDDEN]: '没有权限执行该操作',
  [ERROR_CODES.NOT_FOUND]: '资源不存在或已被删除',
  [ERROR_CODES.ALREADY_EXISTS]: '该邮箱已被注册，请直接登录',
  [ERROR_CODES.VALIDATION_FAILED]: '输入内容不合法，请检查后重试',
  [ERROR_CODES.VERSION_CONFLICT]: '检测到并发修改，已按服务端状态重试',
  [ERROR_CODES.RATE_LIMITED]: '操作过于频繁，请稍后再试',
  [ERROR_CODES.ROOM_FULL]: '房间人数已满',
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: '内容过大，无法提交',
  [ERROR_CODES.CONFLICT]: '当前状态不允许该操作',
  [ERROR_CODES.INTERNAL]: '服务端出错了，请稍后重试',
};

/** 取文案；未知 code 走兜底（服务端新增了 code 也不会空白） */
export function errorMessage(code: string | undefined, fallback = '操作失败，请重试'): string {
  if (!code) return fallback;
  return ERROR_MESSAGES[code as ErrorCode] ?? fallback;
}

/**
 * 把一个异常翻译成给用户看的描述。与 errorMessage 的区别：
 *  - 连接层面失败（后端没起 / 断网）走它自带的可读描述，而不是 INTERNAL 的"服务端出错"——
 *    后者会把"服务根本连不上"说成"服务端出错了"，误导排查方向；
 *  - 其它 ApiError 仍按 code 映射；非 ApiError 走兜底。
 */
export function describeError(error: unknown, fallback = '操作失败，请重试'): string {
  if (isApiError(error)) {
    return error.network ? error.message : errorMessage(error.code, fallback);
  }
  return fallback;
}

/** 结构判定而非 instanceof：避免本模块反向 import lib/api 造成循环依赖 */
function isApiError(value: unknown): value is { code: string; message: string; network: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { network?: unknown }).network === 'boolean'
  );
}

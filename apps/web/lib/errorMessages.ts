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

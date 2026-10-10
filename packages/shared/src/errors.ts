/**
 * 错误码——`error` 事件的 payload `{ code, message }` 里机器读的那一半，
 * 也是 REST 错误响应的 `code` 字段。
 *
 * 约定：
 *  - 前端只对 code 做 switch，永远不解析 message（文案随时会改）；
 *  - code 集合是协议的一部分：客户端一旦开始依赖某个 code，删除或重命名
 *    就是破坏性变更，只能新增、不能改。
 */
import { z } from 'zod';

export const ERROR_CODES = {
  /** 未登录 / access token 缺失或失效 */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** 已认证但不是房间成员，或角色不足（如非 owner 删除房间） */
  FORBIDDEN: 'FORBIDDEN',
  /** 资源不存在：房间 / board / 图形 */
  NOT_FOUND: 'NOT_FOUND',
  /** 同一个资源已存在：注册时邮箱重复 / 重复加入 */
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  /** 输入校验失败：REST DTO 或 WS 消息 schema 不通过 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** 乐观并发控制冲突：客户端 baseVersion 落后，需基于 serverShape 重放 */
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  /** 令牌桶限流触发（写事件 / 光标事件） */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 房间人数已达上限 */
  ROOM_FULL: 'ROOM_FULL',
  /** 单条消息超过 maxHttpBufferSize */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** 请求的资源与当前状态冲突，无法按请求执行 */
  CONFLICT: 'CONFLICT',
  /** 未分类错误的兜底；这种错误在服务端必须带 traceId 打日志 */
  INTERNAL: 'INTERNAL',
} as const;

/** 全部合法错误码的联合类型 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 错误码的运行期校验 schema */
export const ErrorCodeSchema = z.enum(
  Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
);

/** 错误对象：WS `error` 事件 payload 与 REST 错误响应共用的形状 */
export interface ProtocolError {
  code: ErrorCode;
  message: string;
}

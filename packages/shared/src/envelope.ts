/**
 * 消息信封——协议的第二半：所有 WS 消息共用一个外壳，
 * 日志、追踪、版本演进（v 字段）都只需要面对一种形状。
 *
 * 字段定义：计划书 §6.2。两个消费方：
 *  - TS 类型 `Envelope<T, P>`：收发函数的签名里用，获得编译期检查；
 *  - `envelopeSchema` / `envelopeOf`：M4-1 网关校验管道用 Zod 在边界上 parse 每一条消息。
 */

import { z } from 'zod';

import type { ClientEvent, ServerEvent } from './events';

export interface Envelope<T extends string, P> {
  /** 协议版本；将来出现不兼容变更时用它区分新旧消息 */
  v: 1;
  /** 事件名，取值来自 CLIENT_EVENTS / SERVER_EVENTS */
  type: T;
  /** 客户端请求 id，用于把回执（shape:ack / shape:rejected）关联回等待中的请求 */
  reqId?: string;
  roomId?: string;
  /** 服务端权威序号；只在服务端下发时携带，客户端上行不带 */
  seq?: number;
  /** 毫秒时间戳 */
  ts: number;
  payload: P;
}

/**
 * 信封基础 schema。payload 用 z.unknown()：每个事件的 payload 形状由它自己的
 * schema 定义，那是 M4-1 的事——现在逐事件写 schema 属于提前上难度。
 */
export const envelopeSchema = z.object({
  v: z.literal(1),
  type: z.string(),
  reqId: z.string().optional(),
  roomId: z.string().optional(),
  seq: z.number().int().positive().optional(),
  ts: z.number(),
  payload: z.unknown(),
});

/**
 * 给某个具体事件生成专属信封 schema：type 钉成字面量，payload 换成事件自己的 schema。
 * M4-1 的网关管道按事件名调用它，例如：
 *   envelopeOf(CLIENT_EVENTS.SHAPE_CREATE, shapeCreatePayloadSchema)
 * type 参数限定为已登记的事件名——给没进 §6.3/§6.4 表的事件写校验会直接编译报错，
 * 这就是"协议即类型"的闸门。
 */
export function envelopeOf<T extends ClientEvent | ServerEvent, P extends z.ZodTypeAny>(
  type: T,
  payloadSchema: P,
) {
  return envelopeSchema.extend({
    type: z.literal<T>(type),
    payload: payloadSchema,
  });
}

/**
 * @collab/shared —— 前后端共享的协议层。
 *
 *   ./events.ts    事件名常量（§6.3 / §6.4 两张表）
 *   ./envelope.ts  消息信封 Envelope<T, P> 与基础 envelopeSchema（§6.2）
 *   ./errors.ts    错误码与 ProtocolError
 *   ./protocol.ts  每事件的 payload Zod schema、注册表、校验与构造器
 */
export * from './events';
export * from './envelope';
export * from './errors';
export * from './protocol';

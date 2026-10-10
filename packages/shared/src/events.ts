/**
 * 事件名常量——协议的第一半：前后端引用同一份字符串，
 * 拼错事件名会在编译期暴露（联合类型 + switch 穷举检查），而不是运行期静默丢消息。
 *
 * 两个 `as const` 是关键：没有它，`typeof CLIENT_EVENTS` 的值类型退化成 string，
 * 派生出的联合类型 `ClientEvent` / `ServerEvent` 就失去保护作用。
 */

export const CLIENT_EVENTS = {
  /** 进入房间；payload 带 sinceSeq 时用于重连补齐 */
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  SHAPE_CREATE: 'shape:create',
  SHAPE_UPDATE: 'shape:update',
  SHAPE_DELETE: 'shape:delete',
  /** 批量操作：多选移动、撤销重做都走它，避免一次交互发几十条消息 */
  SHAPE_BATCH: 'shape:batch',
  /** 高频瞬时消息：客户端 30–50ms 合并发送，服务端不保证顺序 */
  CURSOR_MOVE: 'cursor:move',
  /** 检漏后的增量补齐请求：本地发现 seq 断档时发出 */
  BOARD_SYNC: 'board:sync',
  /** 应用层心跳，只用于 RTT 统计；连接保活由 Socket.IO 传输层心跳负责 */
  PING: 'ping',
} as const;

/** 客户端 → 服务端 的事件名联合类型 */
export type ClientEvent = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];

export const SERVER_EVENTS = {
  /** 加入成功回执，携带成员列表与 boardId */
  ROOM_JOINED: 'room:joined',
  /** 全量快照：首次加入、或 sinceSeq 过旧（op log 里查不到）时下发 */
  BOARD_STATE: 'board:state',
  /** 增量操作：重连补齐时按 fromSeq 起下发 */
  BOARD_OPS: 'board:ops',
  /** 权威广播：只有服务端事务提交成功的图形变更才从这里出去 */
  SHAPE_CREATED: 'shape:created',
  SHAPE_UPDATED: 'shape:updated',
  SHAPE_DELETED: 'shape:deleted',
  /** 确认回执：携带权威 seq 与 serverShape，客户端据此把 pending 转正 */
  SHAPE_ACK: 'shape:ack',
  /** 拒绝回执：客户端据此回滚本地乐观状态 */
  SHAPE_REJECTED: 'shape:rejected',
  CURSOR_UPDATED: 'cursor:updated',
  PRESENCE_JOINED: 'presence:joined',
  PRESENCE_LEFT: 'presence:left',
  PRESENCE_LIST: 'presence:list',
  /** 统一错误出口，payload 为 ProtocolError */
  ERROR: 'error',
} as const;

/** 服务端 → 客户端 的事件名联合类型 */
export type ServerEvent = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

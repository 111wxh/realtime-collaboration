/**
 * 协议的实现半：每个事件的 payload Zod schema，以及按事件名分发的信封校验。
 *
 * 消费方：
 *  - `apps/api` 的 WS 网关在边界上 parse 每一条上行消息（非法消息被拒且不崩溃）；
 *  - `apps/api` 的 REST 层复用其中的 DTO schema（注册、登录、建房间等）；
 *  - `apps/web` 的 socket 层在收到下行消息时解析（类型收窄 + 运行期防护）。
 *
 * 设计约定：
 *  - 图形几何（x/y/w/h）不带单位，坐标范围 ±1e6（防 NaN / Infinity / 恶意大数）；
 *  - `clientOpId` 是幂等键，由客户端生成（UUID），服务端 `(board_id, client_op_id)` 唯一。
 */

import { z } from 'zod';

import { CLIENT_EVENTS, SERVER_EVENTS } from './events';
import { envelopeSchema } from './envelope';
import { ErrorCodeSchema, type ProtocolError } from './errors';

// ---------------------------------------------------------------------------
// 基础元素
// ---------------------------------------------------------------------------

const UuidSchema = z.string().uuid();

/** 坐标 / 宽高上界。超出视为恶意或 bug，直接拒绝而不是静默截断 */
export const MAX_COORD = 1_000_000;
/** 文本图形的内容上限（字符数） */
export const MAX_TEXT_LENGTH = 10_000;
/** 自由画笔单条图形的点上限 */
export const MAX_FREEDRAW_POINTS = 20_000;

const CoordSchema = z.number().finite().min(-MAX_COORD).max(MAX_COORD);
const DimensionSchema = z.number().finite().min(-MAX_COORD).max(MAX_COORD);

export const SHAPE_TYPES = ['rect', 'ellipse', 'line', 'arrow', 'freedraw', 'text'] as const;
export const ShapeTypeSchema = z.enum(SHAPE_TYPES);
export type ShapeType = z.infer<typeof ShapeTypeSchema>;

/** 图形样式。每种图元只用到其中一部分字段，缺省值由渲染层兜底 */
export const ShapeStyleSchema = z.object({
  stroke: z.string().max(32).optional(),
  fill: z.string().max(32).optional(),
  strokeWidth: z.number().finite().min(0).max(64).optional(),
  opacity: z.number().min(0).max(1).optional(),
  dash: z.array(z.number().finite().min(0).max(64)).max(8).optional(),
  fontSize: z.number().finite().min(4).max(512).optional(),
});
export type ShapeStyle = z.infer<typeof ShapeStyleSchema>;

/** 类型特有数据：freedraw 的点集、text 的文本内容 */
export const ShapeDataSchema = z.object({
  points: z
    .array(z.object({ x: CoordSchema, y: CoordSchema }))
    .max(MAX_FREEDRAW_POINTS)
    .optional(),
  text: z.string().max(MAX_TEXT_LENGTH).optional(),
});
export type ShapeData = z.infer<typeof ShapeDataSchema>;

/**
 * 线上图形形状（wire shape）：所有字段都有值，create / 广播 / 快照共用一种形状。
 * 服务端不收缺字段的"半成品"——需要局部修改走 ShapePatch。
 */
export const ShapeSchema = z.object({
  id: UuidSchema,
  boardId: UuidSchema,
  type: ShapeTypeSchema,
  x: CoordSchema,
  y: CoordSchema,
  w: DimensionSchema,
  h: DimensionSchema,
  rotation: z.number().finite().min(-360).max(360),
  zIndex: z.number().int().min(-100_000).max(100_000),
  style: ShapeStyleSchema,
  data: ShapeDataSchema,
  /** 乐观并发控制的版本号：创建为 1，每次成功的 update +1 */
  version: z.number().int().positive(),
  createdBy: UuidSchema.nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Shape = z.infer<typeof ShapeSchema>;

/** 局部更新：只带要改的字段；服务端 merge 后 version + 1 */
export const ShapePatchSchema = z
  .object({
    x: CoordSchema.optional(),
    y: CoordSchema.optional(),
    w: DimensionSchema.optional(),
    h: DimensionSchema.optional(),
    rotation: z.number().finite().min(-360).max(360).optional(),
    zIndex: z.number().int().min(-100_000).max(100_000).optional(),
    style: ShapeStyleSchema.optional(),
    data: ShapeDataSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'patch 不能为空对象',
  });
export type ShapePatch = z.infer<typeof ShapePatchSchema>;

export const OpTypeSchema = z.enum(['create', 'update', 'delete', 'restore', 'reorder']);
export type OpType = z.infer<typeof OpTypeSchema>;

/**
 * 一次写操作的载荷：op log 的一行在协议层的镜像。
 * 服务端广播与客户端 pending 队列都用它——广播里只有它，权威结果另由 ack 下发。
 */
export const ShapeOpSchema = z.object({
  opType: OpTypeSchema,
  shapeId: UuidSchema,
  /** create 带整条图形；其余按需：update 带 patch，reorder 带 zIndex */
  shape: ShapeSchema.optional(),
  patch: ShapePatchSchema.optional(),
  zIndex: z.number().int().min(-100_000).max(100_000).optional(),
  /**
   * 乐观并发控制：仅 update 使用。单条 op（shape:update 的外层 payload）必带；
   * batch 子 op 可选 —— 带则服务端逐条校验，不带则无条件应用（版本仍单调 +1）。
   */
  baseVersion: z.number().int().positive().optional(),
  /** 幂等键：重复提交同一 clientOpId 必须无副作用 */
  clientOpId: UuidSchema,
  /** 服务端分配的权威序号；客户端本地 op 中为 undefined，ack/广播中必有 */
  seq: z.number().int().positive().optional(),
  /** 落库时间；本地 op 中为 undefined */
  createdAt: z.string().optional(),
});
export type ShapeOp = z.infer<typeof ShapeOpSchema>;

export const CursorSchema = z.object({
  x: CoordSchema,
  y: CoordSchema,
  tool: z.string().max(32).optional(),
});
export type Cursor = z.infer<typeof CursorSchema>;

export const PresenceMemberSchema = z.object({
  userId: UuidSchema,
  displayName: z.string().max(64),
  avatarColor: z.string().max(32),
  cursor: CursorSchema.nullable().optional(),
  onlineAt: z.string().optional(),
});
export type PresenceMember = z.infer<typeof PresenceMemberSchema>;

// ---------------------------------------------------------------------------
// 客户端 → 服务端 payload
// ---------------------------------------------------------------------------

export const JoinRoomPayloadSchema = z.object({
  roomId: UuidSchema,
  /** 重连补齐的起点：缺省表示首次加入，服务端下发全量快照 */
  sinceSeq: z.number().int().min(0).optional(),
});

export const LeaveRoomPayloadSchema = z.object({
  roomId: UuidSchema,
});

export const ShapeCreatePayloadSchema = z.object({
  boardId: UuidSchema,
  shape: ShapeSchema,
  clientOpId: UuidSchema,
});

export const ShapeUpdatePayloadSchema = z.object({
  boardId: UuidSchema,
  shapeId: UuidSchema,
  patch: ShapePatchSchema,
  /** 客户端认为的当前版本；不匹配则拒绝并让客户端基于 serverShape 重放 */
  baseVersion: z.number().int().positive(),
  clientOpId: UuidSchema,
});

export const ShapeDeletePayloadSchema = z.object({
  boardId: UuidSchema,
  shapeId: UuidSchema,
  clientOpId: UuidSchema,
});

export const ShapeBatchPayloadSchema = z.object({
  boardId: UuidSchema,
  ops: z.array(ShapeOpSchema).min(1).max(200),
});

export const CursorMovePayloadSchema = CursorSchema.extend({
  boardId: UuidSchema,
});

export const BoardSyncPayloadSchema = z.object({
  boardId: UuidSchema,
  sinceSeq: z.number().int().min(0),
});

export const PingPayloadSchema = z.object({});

// ---------------------------------------------------------------------------
// 服务端 → 客户端 payload
// ---------------------------------------------------------------------------

export const RoomJoinedPayloadSchema = z.object({
  roomId: UuidSchema,
  boardId: UuidSchema,
  self: PresenceMemberSchema,
  members: z.array(PresenceMemberSchema),
});

/** 全量快照；seq 用于"陈旧快照丢弃"：客户端本地 seq 更新时直接丢掉这条 */
export const BoardStatePayloadSchema = z.object({
  boardId: UuidSchema,
  seq: z.number().int().min(0),
  shapes: z.array(ShapeSchema),
});

/** 增量操作：`fromSeq + ops.length - 1 === latestSeq` 时客户端可安全推进 */
export const BoardOpsPayloadSchema = z.object({
  boardId: UuidSchema,
  fromSeq: z.number().int().positive(),
  ops: z.array(ShapeOpSchema),
  latestSeq: z.number().int().min(0),
});

export const ShapeCreatedPayloadSchema = z.object({
  seq: z.number().int().positive(),
  op: ShapeOpSchema,
});

export const ShapeUpdatedPayloadSchema = z.object({
  seq: z.number().int().positive(),
  op: ShapeOpSchema,
});

export const ShapeDeletedPayloadSchema = z.object({
  seq: z.number().int().positive(),
  op: ShapeOpSchema,
});

export const ShapeAckPayloadSchema = z.object({
  reqId: z.string(),
  clientOpId: UuidSchema,
  /** 批量操作时每个子 op 各有一个 seq */
  seq: z.number().int().positive().optional(),
  seqs: z.record(z.string(), z.number().int().positive()).optional(),
  serverShape: ShapeSchema.nullable(),
});

export const ShapeRejectedPayloadSchema = z.object({
  reqId: z.string(),
  clientOpId: UuidSchema,
  reason: ErrorCodeSchema,
  message: z.string().optional(),
  serverShape: ShapeSchema.nullable().optional(),
});

export const CursorUpdatedPayloadSchema = CursorSchema.extend({
  userId: UuidSchema,
});

export const PresenceJoinedPayloadSchema = z.object({
  userId: UuidSchema,
  displayName: z.string().max(64),
  avatarColor: z.string().max(32),
});

export const PresenceLeftPayloadSchema = z.object({
  userId: UuidSchema,
});

export const PresenceListPayloadSchema = z.object({
  roomId: UuidSchema,
  members: z.array(PresenceMemberSchema),
});

export const ErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});

// ---------------------------------------------------------------------------
// 事件注册表：事件名 → payload schema
// ---------------------------------------------------------------------------

/** 事件注册表里每个值都是 Zod schema；用最宽的约束以免与 zod 内部字段名冲突 */
type AnySchema = z.ZodTypeAny;

export const clientSchemas = {
  [CLIENT_EVENTS.ROOM_JOIN]: JoinRoomPayloadSchema,
  [CLIENT_EVENTS.ROOM_LEAVE]: LeaveRoomPayloadSchema,
  [CLIENT_EVENTS.SHAPE_CREATE]: ShapeCreatePayloadSchema,
  [CLIENT_EVENTS.SHAPE_UPDATE]: ShapeUpdatePayloadSchema,
  [CLIENT_EVENTS.SHAPE_DELETE]: ShapeDeletePayloadSchema,
  [CLIENT_EVENTS.SHAPE_BATCH]: ShapeBatchPayloadSchema,
  [CLIENT_EVENTS.CURSOR_MOVE]: CursorMovePayloadSchema,
  [CLIENT_EVENTS.BOARD_SYNC]: BoardSyncPayloadSchema,
  [CLIENT_EVENTS.PING]: PingPayloadSchema,
} as const satisfies Record<string, AnySchema>;

export const serverSchemas = {
  [SERVER_EVENTS.ROOM_JOINED]: RoomJoinedPayloadSchema,
  [SERVER_EVENTS.BOARD_STATE]: BoardStatePayloadSchema,
  [SERVER_EVENTS.BOARD_OPS]: BoardOpsPayloadSchema,
  [SERVER_EVENTS.SHAPE_CREATED]: ShapeCreatedPayloadSchema,
  [SERVER_EVENTS.SHAPE_UPDATED]: ShapeUpdatedPayloadSchema,
  [SERVER_EVENTS.SHAPE_DELETED]: ShapeDeletedPayloadSchema,
  [SERVER_EVENTS.SHAPE_ACK]: ShapeAckPayloadSchema,
  [SERVER_EVENTS.SHAPE_REJECTED]: ShapeRejectedPayloadSchema,
  [SERVER_EVENTS.CURSOR_UPDATED]: CursorUpdatedPayloadSchema,
  [SERVER_EVENTS.PRESENCE_JOINED]: PresenceJoinedPayloadSchema,
  [SERVER_EVENTS.PRESENCE_LEFT]: PresenceLeftPayloadSchema,
  [SERVER_EVENTS.PRESENCE_LIST]: PresenceListPayloadSchema,
  [SERVER_EVENTS.ERROR]: ErrorPayloadSchema,
} as const satisfies Record<string, AnySchema>;

// ---------------------------------------------------------------------------
// 从注册表派生的类型工具
// ---------------------------------------------------------------------------

/** 事件名联合类型由注册表的 key 派生——注册表加一个事件，类型自动收进来 */
export type ClientEventName = keyof typeof clientSchemas;
export type ServerEventName = keyof typeof serverSchemas;

/** 每个事件名对应的 payload 类型 */
export type ClientPayload<T extends ClientEventName> = z.output<(typeof clientSchemas)[T]>;
export type ServerPayload<T extends ServerEventName> = z.output<(typeof serverSchemas)[T]>;

/** 客户端上行信封：Envelope 的 type/payload 由事件名锁定 */
export type ClientEnvelope<T extends ClientEventName = ClientEventName> = {
  [K in T]: {
    v: 1;
    type: K;
    reqId?: string;
    roomId?: string;
    seq?: number;
    ts: number;
    payload: ClientPayload<K>;
  };
}[T];

/** 服务端下行信封：同上，额外允许服务端携带权威 seq */
export type ServerEnvelope<T extends ServerEventName = ServerEventName> = {
  [K in T]: {
    v: 1;
    type: K;
    reqId?: string;
    roomId?: string;
    seq?: number;
    ts: number;
    payload: ServerPayload<K>;
  };
}[T];

// ---------------------------------------------------------------------------
// 校验：按事件名分发的判别联合信封 schema
// ---------------------------------------------------------------------------

const envelopeOfRegistry = (schemas: Record<string, AnySchema>) =>
  z.union(
    Object.entries(schemas).map(([type, payloadSchema]) =>
      envelopeSchema.extend({
        type: z.literal(type),
        payload: payloadSchema,
      }),
    ) as unknown as [AnySchema, AnySchema, ...AnySchema[]],
  );

/** 客户端上行消息的判别联合 schema：非法 type 或 payload 都会 parse 失败 */
export const clientEnvelopeSchema = envelopeOfRegistry(clientSchemas);
/** 服务端下行消息的判别联合 schema */
export const serverEnvelopeSchema = envelopeOfRegistry(serverSchemas);

export type ClientEnvelopeParseResult =
  | { ok: true; envelope: ClientEnvelope }
  | { ok: false; error: string; detail?: unknown };

/** 网关入口用的安全解析：不抛异常，返回可判断的结果 */
export function parseClientEnvelope(raw: unknown): ClientEnvelopeParseResult {
  const parsed = clientEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'VALIDATION_FAILED', detail: parsed.error.issues };
  }
  return { ok: true, envelope: parsed.data as ClientEnvelope };
}

export type ServerEnvelopeParseResult =
  | { ok: true; envelope: ServerEnvelope }
  | { ok: false; error: string; detail?: unknown };

/** 前端收到下行消息时的安全解析 */
export function parseServerEnvelope(raw: unknown): ServerEnvelopeParseResult {
  const parsed = serverEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'VALIDATION_FAILED', detail: parsed.error.issues };
  }
  return { ok: true, envelope: parsed.data as ServerEnvelope };
}

// ---------------------------------------------------------------------------
// 构造器：前端发消息和服务端推消息都从这里出发，保证信封字段齐全
// ---------------------------------------------------------------------------

/** 客户端构造上行消息：type 与 payload 的类型必须配对，否则编译不過 */
export function makeClientEnvelope<T extends ClientEventName>(
  type: T,
  payload: ClientPayload<T>,
  opts?: { reqId?: string; roomId?: string },
): ClientEnvelope<T> {
  return {
    v: 1,
    type,
    reqId: opts?.reqId,
    roomId: opts?.roomId,
    ts: Date.now(),
    payload,
  } as ClientEnvelope<T>;
}

/** 服务端构造下行消息 */
export function makeServerEnvelope<T extends ServerEventName>(
  type: T,
  payload: ServerPayload<T>,
  opts?: { reqId?: string; roomId?: string; seq?: number },
): ServerEnvelope<T> {
  return {
    v: 1,
    type,
    reqId: opts?.reqId,
    roomId: opts?.roomId,
    seq: opts?.seq,
    ts: Date.now(),
    payload,
  } as ServerEnvelope<T>;
}

/** 把 ErrorPayloadSchema 的推断类型显式暴露给使用方 */
export type ErrorPayload = ProtocolError;

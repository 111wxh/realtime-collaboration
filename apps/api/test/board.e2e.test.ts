import { randomUUID } from 'node:crypto';

import { CLIENT_EVENTS, SERVER_EVENTS, makeClientEnvelope, type Shape } from '@collab/shared';
import type { INestApplication } from '@nestjs/common';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BoardService } from '../src/modules/board/board.service';
import {
  api,
  closeSockets,
  collectEvents,
  connectSocket,
  probeDependencies,
  registerUser,
  startTestApp,
  waitForEvent,
  type TestUser,
} from './e2e-helpers';

/**
 * 端到端主链路（计划书 §10 验收清单）：
 *   注册 → 登录 → 建房间 → 邀请码加入 → WS 握手鉴权 → room:join
 *   → shape:create 拿到带 seq 的 ack → 他人收到权威广播
 *   → 重复 clientOpId 无副作用 → 并发 update 冲突被拒
 *   → 断线重连按 sinceSeq 增量补齐 → 冷启动快照+op log 重建与投影一致
 *
 * 需要真实 PostgreSQL/Redis（docker compose up -d postgres redis）。
 * 依赖不可用时整个套件 skip 并打印原因，而不是红一片。
 */

const probe = await probeDependencies();

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * 图形 id 用随机 UUID：shapes.id 是全局主键（§5.2），
 * 固定 id 会让第二次运行的数据撞上上一次运行留下的行。
 */
const SHAPE_ID = randomUUID();

function makeWireShape(id: string, boardId: string, overrides: Partial<Shape> = {}): Shape {
  return {
    id,
    boardId,
    type: overrides.type ?? 'rect',
    x: overrides.x ?? 10,
    y: overrides.y ?? 20,
    w: overrides.w ?? 100,
    h: overrides.h ?? 60,
    rotation: overrides.rotation ?? 0,
    zIndex: overrides.zIndex ?? 0,
    style: overrides.style ?? { stroke: '#111111' },
    data: overrides.data ?? {},
    version: overrides.version ?? 1,
    createdBy: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe.skipIf(!probe.ok)(
  `实时协作主链路（真实 PG/Redis）${probe.ok ? '' : ` · 已跳过：${probe.reason}`}`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let alice: TestUser;
    let bob: TestUser;
    let carol: TestUser;
    let roomId: string;
    let boardId: string;
    let inviteCode: string;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      const context = await startTestApp();
      app = context.app;
      baseUrl = context.baseUrl;

      alice = await registerUser(baseUrl, 'alice');
      bob = await registerUser(baseUrl, 'bob');
      carol = await registerUser(baseUrl, 'carol');

      const created = await api<{ room: { id: string; inviteCode: string; boardId: string } }>(
        baseUrl,
        '/api/rooms',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${alice.accessToken}` },
          body: JSON.stringify({ name: 'e2e 房间' }),
        },
      );
      expect(created.status).toBe(201);
      roomId = created.body.room.id;
      boardId = created.body.room.boardId;
      inviteCode = created.body.room.inviteCode;

      const joined = await api(baseUrl, '/api/rooms/join', {
        method: 'POST',
        headers: { authorization: `Bearer ${bob.accessToken}` },
        body: JSON.stringify({ inviteCode }),
      });
      expect(joined.status).toBe(201);
    }, 60_000);

    afterAll(async () => {
      await closeSockets(sockets);
      await app?.close();
    });

    it('建房返回 8 位邀请码与 boardId；重复加入幂等', async () => {
      expect(inviteCode).toMatch(/^[A-Z2-9]{8}$/);
      expect(boardId).toMatch(/^[0-9a-f-]{36}$/);

      const again = await api<{ alreadyMember: boolean }>(baseUrl, '/api/rooms/join', {
        method: 'POST',
        headers: { authorization: `Bearer ${bob.accessToken}` },
        body: JSON.stringify({ inviteCode }),
      });
      expect(again.status).toBe(201);
      expect(again.body.alreadyMember).toBe(true);

      const members = await api<{ members: Array<{ userId: string; role: string }> }>(
        baseUrl,
        `/api/rooms/${roomId}/members`,
        { headers: { authorization: `Bearer ${alice.accessToken}` } },
      );
      expect(members.status).toBe(200);
      // 成员数没有因为重复加入而增加
      expect(members.body.members).toHaveLength(2);
    });

    it('非成员访问房间与画布一律 403 FORBIDDEN', async () => {
      const room = await api<{ code: string }>(baseUrl, `/api/rooms/${roomId}`, {
        headers: { authorization: `Bearer ${carol.accessToken}` },
      });
      expect(room.status).toBe(403);
      expect(room.body.code).toBe('FORBIDDEN');

      const state = await api<{ code: string }>(baseUrl, `/api/boards/${boardId}/state`, {
        headers: { authorization: `Bearer ${carol.accessToken}` },
      });
      expect(state.status).toBe(403);
      expect(state.body.code).toBe('FORBIDDEN');
    });

    it('无 token 的 WS 连接被拒绝；带 token 的连接成功', async () => {
      await expect(connectSocket(baseUrl, undefined)).rejects.toBeTruthy();

      // 探针连接用完即关，且**不入 sockets 数组**：
      // 后面的用例按下标取活跃连接，混进已断开的连接会让断言静默超时
      const probeSocket = await connectSocket(baseUrl, alice.accessToken);
      expect(probeSocket.connected).toBe(true);
      await closeSockets([probeSocket]);
    });

    it('room:join 返回 room:joined + 初始 board:state；落库的 op 从 seq=1 起', async () => {
      const aliceSocket = await connectSocket(baseUrl, alice.accessToken);
      const bobSocket = await connectSocket(baseUrl, bob.accessToken);
      sockets.push(aliceSocket, bobSocket); // 下标 0 = Alice，1 = Bob

      // Bob 先加入，Alice 加入时应当看到 Bob 在线（presence 来自 Redis）
      bobSocket.emit(
        CLIENT_EVENTS.ROOM_JOIN,
        makeClientEnvelope(CLIENT_EVENTS.ROOM_JOIN, { roomId }),
      );
      const bobJoined = await waitForEvent<{
        payload: { boardId: string; self: { userId: string } };
      }>(bobSocket, SERVER_EVENTS.ROOM_JOINED);
      expect(bobJoined.payload.boardId).toBe(boardId);
      expect(bobJoined.payload.self.userId).toBe(bob.id);
      const bobState = await waitForEvent<{ payload: { seq: number; shapes: Shape[] } }>(
        bobSocket,
        SERVER_EVENTS.BOARD_STATE,
      );
      expect(bobState.payload.seq).toBe(0);
      expect(bobState.payload.shapes).toEqual([]);

      const joinedBroadcast = waitForEvent<{ payload: { userId: string } }>(
        bobSocket,
        SERVER_EVENTS.PRESENCE_JOINED,
      );
      aliceSocket.emit(
        CLIENT_EVENTS.ROOM_JOIN,
        makeClientEnvelope(CLIENT_EVENTS.ROOM_JOIN, { roomId }),
      );
      const aliceJoined = await waitForEvent<{
        payload: { members: Array<{ userId: string }> };
      }>(aliceSocket, SERVER_EVENTS.ROOM_JOINED);
      expect(aliceJoined.payload.members.map((m) => m.userId).sort()).toEqual(
        [alice.id, bob.id].sort(),
      );
      expect((await joinedBroadcast).payload.userId).toBe(alice.id);
    });

    it('shape:create 提交后 ack 带 seq，另一客户端收到权威广播', async () => {
      const aliceSocket = sockets[0]!;
      const bobSocket = sockets[1]!;
      const shape = makeWireShape(SHAPE_ID, boardId);

      const createdBroadcast = waitForEvent<{ payload: { seq: number; op: { shape?: Shape } } }>(
        bobSocket,
        SERVER_EVENTS.SHAPE_CREATED,
      );
      aliceSocket.emit(
        CLIENT_EVENTS.SHAPE_CREATE,
        makeClientEnvelope(
          CLIENT_EVENTS.SHAPE_CREATE,
          { boardId, shape, clientOpId: uuid(2001) },
          { reqId: 'req-create-1' },
        ),
      );

      const ack = await waitForEvent<{
        payload: { reqId: string; clientOpId: string; seq: number; serverShape: Shape | null };
      }>(aliceSocket, SERVER_EVENTS.SHAPE_ACK);
      expect(ack.payload.reqId).toBe('req-create-1');
      expect(ack.payload.seq).toBe(1);
      expect(ack.payload.serverShape?.id).toBe(shape.id);
      expect(ack.payload.serverShape?.version).toBe(1);
      // 服务端认定的 createdBy 是创建者，而不是客户端声明的 null
      expect(ack.payload.serverShape?.createdBy).toBe(alice.id);

      const broadcast = await createdBroadcast;
      expect(broadcast.payload.seq).toBe(1);
      expect(broadcast.payload.op.shape?.id).toBe(shape.id);

      const state = await api<{ seq: number; shapes: Shape[] }>(
        baseUrl,
        `/api/boards/${boardId}/state`,
        { headers: { authorization: `Bearer ${bob.accessToken}` } },
      );
      expect(state.body.seq).toBe(1);
      expect(state.body.shapes.map((s) => s.id)).toEqual([shape.id]);
    });

    it('重复提交同一 clientOpId：ack 回原 seq，不产生副作用、不重复广播', async () => {
      const aliceSocket = sockets[0]!;
      const bobSocket = sockets[1]!;
      const shape = makeWireShape(SHAPE_ID, boardId); // 与上一条相同的图形 id

      const noBroadcast = collectEvents(bobSocket, SERVER_EVENTS.SHAPE_CREATED, 400);
      aliceSocket.emit(
        CLIENT_EVENTS.SHAPE_CREATE,
        makeClientEnvelope(CLIENT_EVENTS.SHAPE_CREATE, {
          boardId,
          shape,
          clientOpId: uuid(2001),
        }),
      );
      const ack = await waitForEvent<{ payload: { seq: number } }>(
        aliceSocket,
        SERVER_EVENTS.SHAPE_ACK,
      );
      expect(ack.payload.seq).toBe(1);
      expect(await noBroadcast).toEqual([]);

      const state = await api<{ seq: number; shapes: Shape[] }>(
        baseUrl,
        `/api/boards/${boardId}/state`,
        { headers: { authorization: `Bearer ${alice.accessToken}` } },
      );
      expect(state.body.seq).toBe(1);
      expect(state.body.shapes).toHaveLength(1);
    });

    it('乐观并发：版本一致的 update 成功，baseVersion 落后的 update 被拒并带回最新 serverShape', async () => {
      const aliceSocket = sockets[0]!;
      const bobSocket = sockets[1]!;

      // Alice 先改：version 1 → 2
      const appliedBroadcast = waitForEvent<{ payload: { seq: number; op: { patch?: unknown } } }>(
        bobSocket,
        SERVER_EVENTS.SHAPE_UPDATED,
      );
      aliceSocket.emit(
        CLIENT_EVENTS.SHAPE_UPDATE,
        makeClientEnvelope(CLIENT_EVENTS.SHAPE_UPDATE, {
          boardId,
          shapeId: SHAPE_ID,
          patch: { x: 500 },
          baseVersion: 1,
          clientOpId: uuid(2002),
        }),
      );
      const ack = await waitForEvent<{ payload: { seq: number; serverShape: Shape | null } }>(
        aliceSocket,
        SERVER_EVENTS.SHAPE_ACK,
      );
      expect(ack.payload.seq).toBe(2);
      expect(ack.payload.serverShape?.version).toBe(2);
      expect(ack.payload.serverShape?.x).toBe(500);
      expect((await appliedBroadcast).payload.seq).toBe(2);

      // Bob 拿着旧版本改 → 被拒
      bobSocket.emit(
        CLIENT_EVENTS.SHAPE_UPDATE,
        makeClientEnvelope(
          CLIENT_EVENTS.SHAPE_UPDATE,
          {
            boardId,
            shapeId: SHAPE_ID,
            patch: { x: 999 },
            baseVersion: 1,
            clientOpId: uuid(2003),
          },
          { reqId: 'req-conflict' },
        ),
      );
      const rejected = await waitForEvent<{
        payload: { reqId: string; reason: string; serverShape: Shape | null };
      }>(bobSocket, SERVER_EVENTS.SHAPE_REJECTED);
      expect(rejected.payload.reqId).toBe('req-conflict');
      expect(rejected.payload.reason).toBe('VERSION_CONFLICT');
      expect(rejected.payload.serverShape?.version).toBe(2);
      expect(rejected.payload.serverShape?.x).toBe(500);

      // 被拒不产生 op：seq 仍是 2
      const state = await api<{ seq: number }>(baseUrl, `/api/boards/${boardId}/state`, {
        headers: { authorization: `Bearer ${alice.accessToken}` },
      });
      expect(state.body.seq).toBe(2);
    });

    it('非法消息只回 error 事件且连接不受影响', async () => {
      const aliceSocket = sockets[0]!;
      aliceSocket.emit(CLIENT_EVENTS.SHAPE_CREATE, { v: 1, type: 'shape:create' }); // 缺 ts/payload
      const error = await waitForEvent<{ payload: { code: string } }>(
        aliceSocket,
        SERVER_EVENTS.ERROR,
      );
      expect(error.payload.code).toBe('VALIDATION_FAILED');

      // 连接还活着：随后一条合法 ping 依然能拿到 ack
      const ack = await new Promise<{ v: 1; ts: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ping ack 超时')), 3000);
        aliceSocket.emit(
          CLIENT_EVENTS.PING,
          makeClientEnvelope(CLIENT_EVENTS.PING, {}),
          (reply: { v: 1; ts: number }) => {
            clearTimeout(timer);
            resolve(reply);
          },
        );
      });
      expect(ack.v).toBe(1);
      expect(typeof ack.ts).toBe('number');
    });

    it('shape:batch 整批一个事务：ack 带 seqs，其他客户端按 op 类型收到广播', async () => {
      const aliceSocket = sockets[0]!;
      const bobSocket = sockets[1]!;
      const batchShapeId = randomUUID();

      const createdBroadcast = waitForEvent<{ payload: { seq: number; op: { shape?: Shape } } }>(
        bobSocket,
        SERVER_EVENTS.SHAPE_CREATED,
      );
      const updatedBroadcast = waitForEvent<{ payload: { seq: number; op: { zIndex?: number } } }>(
        bobSocket,
        SERVER_EVENTS.SHAPE_UPDATED,
      );

      aliceSocket.emit(
        CLIENT_EVENTS.SHAPE_BATCH,
        makeClientEnvelope(
          CLIENT_EVENTS.SHAPE_BATCH,
          {
            boardId,
            ops: [
              {
                opType: 'create',
                shapeId: batchShapeId,
                clientOpId: uuid(2601),
                shape: makeWireShape(batchShapeId, boardId, { zIndex: 0 }),
              },
              // 同一批里再 reorder：seq 必须接着 +1（连续分配）
              { opType: 'reorder', shapeId: batchShapeId, clientOpId: uuid(2602), zIndex: 7 },
            ],
          },
          { reqId: 'req-batch' },
        ),
      );

      const ack = await waitForEvent<{
        payload: { reqId: string; seqs: Record<string, number>; serverShape: Shape | null };
      }>(aliceSocket, SERVER_EVENTS.SHAPE_ACK);
      expect(ack.payload.reqId).toBe('req-batch');
      const seqs = Object.values(ack.payload.seqs).sort((a, b) => a - b);
      expect(seqs).toHaveLength(2);
      expect(seqs[1]).toBe(seqs[0]! + 1);

      expect((await createdBroadcast).payload.op.shape?.id).toBe(batchShapeId);
      expect((await updatedBroadcast).payload.op.zIndex).toBe(7);

      // reorder 生效
      const state = await api<{ shapes: Shape[] }>(baseUrl, `/api/boards/${boardId}/state`, {
        headers: { authorization: `Bearer ${alice.accessToken}` },
      });
      expect(state.body.shapes.find((s) => s.id === batchShapeId)?.zIndex).toBe(7);
    });

    it('断线重连：按 sinceSeq 增量补齐缺失的 op', async () => {
      const bobSocket = sockets[1]!;
      // Bob 断线
      bobSocket.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 断线期间 Alice 改了两次（seq 3、4）
      const aliceSocket = sockets[0]!;
      // 权威 seq 从 REST 读，而不是硬编码：用例之间不该靠"上一条用例刚好用掉几个 seq"耦合
      const before = await api<{ seq: number }>(baseUrl, `/api/boards/${boardId}/state`, {
        headers: { authorization: `Bearer ${alice.accessToken}` },
      });
      const knownSeq = before.body.seq;
      const appliedSeqs: number[] = [];
      for (const [index, x] of [600, 700].entries()) {
        const ackPromise = waitForEvent<{ payload: { seq: number } }>(
          aliceSocket,
          SERVER_EVENTS.SHAPE_ACK,
        );
        aliceSocket.emit(
          CLIENT_EVENTS.SHAPE_UPDATE,
          makeClientEnvelope(CLIENT_EVENTS.SHAPE_UPDATE, {
            boardId,
            shapeId: SHAPE_ID,
            patch: { x },
            baseVersion: 2 + index,
            clientOpId: uuid(2100 + index),
          }),
        );
        const ack = await ackPromise;
        expect(ack.payload.seq).toBe(knownSeq + index + 1);
        appliedSeqs.push(ack.payload.seq);
      }

      // Bob 重连，带上断线前已知的 seq
      const reconnected = await connectSocket(baseUrl, bob.accessToken);
      sockets.push(reconnected);
      reconnected.emit(
        CLIENT_EVENTS.ROOM_JOIN,
        makeClientEnvelope(CLIENT_EVENTS.ROOM_JOIN, { roomId, sinceSeq: knownSeq }),
      );
      const ops = await waitForEvent<{
        payload: {
          boardId: string;
          fromSeq: number;
          latestSeq: number;
          ops: Array<{ seq: number }>;
        };
      }>(reconnected, SERVER_EVENTS.BOARD_OPS);
      expect(ops.payload.boardId).toBe(boardId);
      expect(ops.payload.fromSeq).toBe(knownSeq + 1);
      expect(ops.payload.latestSeq).toBe(knownSeq + appliedSeqs.length);
      expect(ops.payload.ops.map((op) => op.seq)).toEqual(appliedSeqs);

      // 再补一次（sinceSeq 已最新）→ 空增量
      reconnected.emit(
        CLIENT_EVENTS.BOARD_SYNC,
        makeClientEnvelope(CLIENT_EVENTS.BOARD_SYNC, {
          boardId,
          sinceSeq: ops.payload.latestSeq,
        }),
      );
      const empty = await waitForEvent<{ payload: { ops: unknown[]; latestSeq: number } }>(
        reconnected,
        SERVER_EVENTS.BOARD_OPS,
      );
      expect(empty.payload.ops).toEqual([]);
      expect(empty.payload.latestSeq).toBe(knownSeq + appliedSeqs.length);
    });

    it('跨画布重用图形 ID：被拒为 CONFLICT，不落库（shapes.id 是全局主键）', async () => {
      const aliceSocket = sockets[0]!;
      // Alice 再建一个房间（同一个人可以在多个房间里）
      const second = await api<{ room: { boardId: string } }>(baseUrl, '/api/rooms', {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ name: 'e2e 房间 2' }),
      });
      expect(second.status).toBe(201);
      const otherBoardId = second.body.room.boardId;
      expect(otherBoardId).not.toBe(boardId);

      aliceSocket.emit(
        CLIENT_EVENTS.SHAPE_CREATE,
        makeClientEnvelope(
          CLIENT_EVENTS.SHAPE_CREATE,
          {
            boardId: otherBoardId,
            shape: makeWireShape(SHAPE_ID, otherBoardId), // 与第一个画布相同的 id
            clientOpId: uuid(2500),
          },
          { reqId: 'req-dup-id' },
        ),
      );
      const rejected = await waitForEvent<{ payload: { reqId: string; reason: string } }>(
        aliceSocket,
        SERVER_EVENTS.SHAPE_REJECTED,
      );
      expect(rejected.payload.reqId).toBe('req-dup-id');
      expect(rejected.payload.reason).toBe('CONFLICT');
    });

    it('光标节流后仍能广播到同房间的其他连接', async () => {
      const aliceSocket = sockets[0]!;
      const bobSocket = sockets[2]!;
      const cursor = waitForEvent<{ payload: { userId: string; x: number; y: number } }>(
        bobSocket,
        SERVER_EVENTS.CURSOR_UPDATED,
      );
      for (let i = 0; i < 5; i += 1) {
        aliceSocket.emit(
          CLIENT_EVENTS.CURSOR_MOVE,
          makeClientEnvelope(CLIENT_EVENTS.CURSOR_MOVE, { boardId, x: i, y: i, tool: 'rect' }),
        );
      }
      const payload = await cursor;
      expect(payload.payload.userId).toBe(alice.id);
      expect(typeof payload.payload.x).toBe('number');
    });

    it('冷启动重建（快照 + op log 回放）与数据库投影一致', async () => {
      const boardService = app.get(BoardService);
      const projection = await boardService.getState(alice.id, boardId);
      const rebuilt = await boardService.rebuildFromLog(alice.id, boardId);
      expect(rebuilt.seq).toBe(projection.seq);
      expect(rebuilt.shapes).toEqual(projection.shapes);
    });

    it('presence：断开连接后其他成员看到 presence:left', async () => {
      const carolJoin = await api(baseUrl, '/api/rooms/join', {
        method: 'POST',
        headers: { authorization: `Bearer ${carol.accessToken}` },
        body: JSON.stringify({ inviteCode }),
      });
      expect(carolJoin.status).toBe(201);

      const carolSocket = await connectSocket(baseUrl, carol.accessToken);
      carolSocket.emit(
        CLIENT_EVENTS.ROOM_JOIN,
        makeClientEnvelope(CLIENT_EVENTS.ROOM_JOIN, { roomId }),
      );
      await waitForEvent(carolSocket, SERVER_EVENTS.ROOM_JOINED);

      const aliceSocket = sockets[0]!;
      const left = waitForEvent<{ payload: { userId: string } }>(
        aliceSocket,
        SERVER_EVENTS.PRESENCE_LEFT,
        { timeoutMs: 5000 },
      );
      carolSocket.disconnect();
      expect((await left).payload.userId).toBe(carol.id);
    });
  },
);

if (!probe.ok) {
  // 明确打印跳过原因，避免"绿了但什么也没跑"的误读
  console.warn(`[e2e] 跳过实时协作主链路：${probe.reason}`);
}

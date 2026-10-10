/**
 * 端到端验收脚本（REST + WebSocket）——由集成方（主智能体）在子智能体交付后运行。
 *
 * 覆盖计划书 §10 验收清单里可自动化的部分：
 *   1. 注册 / 登录 / 会话恢复（refresh 拿新 access）
 *   2. 建房间 → 两个客户端用邀请码加入 → 互相可见，presence 列表 2 人
 *   3. 形状 create → ack 带权威 seq → 另一端收到 shape:created
 *   4. 同一 clientOpId 重复提交 → 第二次无副作用（同一 seq、不产生第二条 op）
 *   5. baseVersion 冲突 → 第二个 update 被拒（VERSION_CONFLICT）且带最新 serverShape
 *
 * 用法：node scripts/e2e-verify.mjs
 *   依赖：postgres/redis 已起（docker compose up -d postgres redis），API 已在 3001 运行。
 *   可用环境变量覆盖：API_BASE（默认 http://localhost:3001）
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 依赖从 apps/web 解析（根目录不装这些包）：@collab/shared 用已构建的 dist（CommonJS，
// import() 会做命名空间包装，命名导出可用）；socket.io-client 用 web 端同一份，避免版本漂移。
const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const sharedPkgDir = requireFromWeb.resolve('@collab/shared'); // exports[.].require → dist/index.js
const sharedDistUrl = pathToFileURL(sharedPkgDir).href;
const socketClientUrl = pathToFileURL(requireFromWeb.resolve('socket.io-client')).href;

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const WS_BASE = API_BASE;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function assertEqual(name, actual, expected) {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, setCookie: res.headers.getSetCookie?.() ?? [] };
}

async function main() {
  const { io } = await import(socketClientUrl);
  const { CLIENT_EVENTS, SERVER_EVENTS, ERROR_CODES, makeClientEnvelope } = await import(
    sharedDistUrl
  );

  // ---------------------------------------------------------------- 1. REST
  const suffix = Date.now().toString(36);
  const userA = { email: `a-${suffix}@example.com`, password: 'passw0rd!', displayName: '用户A' };
  const userB = { email: `b-${suffix}@example.com`, password: 'passw0rd!', displayName: '用户B' };

  const regA = await api('/api/auth/register', { method: 'POST', body: userA });
  check('注册 A 成功 (201)', regA.status === 201 || regA.status === 200, `status=${regA.status}`);

  const regDup = await api('/api/auth/register', { method: 'POST', body: userA });
  check('重复邮箱注册被拒 (409)', regDup.status === 409, `status=${regDup.status}`);

  const loginA = await api('/api/auth/login', {
    method: 'POST',
    body: { email: userA.email, password: userA.password },
  });
  check('登录 A 返回 accessToken', Boolean(loginA.body?.accessToken), `status=${loginA.status}`);
  const tokenA = loginA.body?.accessToken;
  const refreshCookieA = loginA.setCookie.find((c) => c.startsWith('refresh_token='));

  const meA = await api('/api/auth/me', { token: tokenA });
  assertEqual('GET /me 返回本人', meA.body?.user?.email, userA.email);

  if (refreshCookieA) {
    const refresh = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { cookie: refreshCookieA.split(';')[0] },
    });
    const body = await refresh.json().catch(() => ({}));
    check('refresh 换新 accessToken', refresh.status === 200 && Boolean(body.accessToken), `status=${refresh.status}`);
  } else {
    check('refresh 换新 accessToken', false, '未收到 refresh_token cookie');
  }

  await api('/api/auth/register', { method: 'POST', body: userB });
  const loginB = await api('/api/auth/login', {
    method: 'POST',
    body: { email: userB.email, password: userB.password },
  });
  const tokenB = loginB.body?.accessToken;
  check('登录 B 返回 accessToken', Boolean(tokenB));

  // ---------------------------------------------------------------- 2. 房间
  const createRoom = await api('/api/rooms', {
    method: 'POST',
    body: { name: `验收房间-${suffix}` },
    token: tokenA,
  });
  const room = createRoom.body?.room;
  const inviteCode = room?.inviteCode;
  check('创建房间返回邀请码', Boolean(inviteCode), `inviteCode=${inviteCode}`);

  const joinB = await api('/api/rooms/join', { method: 'POST', body: { inviteCode }, token: tokenB });
  check('B 用邀请码加入房间', joinB.status === 200 || joinB.status === 201, `status=${joinB.status}`);

  const joinB2 = await api('/api/rooms/join', { method: 'POST', body: { inviteCode }, token: tokenB });
  check('重复加入幂等（不报错）', joinB2.status === 200 || joinB2.status === 201, `status=${joinB2.status}`);

  const roomDetail = await api(`/api/rooms/${room.id}`, { token: tokenA });
  assertEqual('房间成员数 = 2（RoomView.memberCount）', roomDetail.body?.room?.memberCount, 2);

  // ---------------------------------------------------------------- 3. WS 双客户端
  async function openSocket(token) {
    const socket = io(WS_BASE, { auth: { token }, transports: ['websocket'] });
    const received = [];
    socket.onAny((event, ...args) => received.push({ event, args }));
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', (err) => reject(new Error(`connect_error: ${err.message}`)));
      setTimeout(() => reject(new Error('connect timeout')), 8000);
    });
    return { socket, received };
  }

  function waitFor(socket, event, { predicate, timeout = 10000, label } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const trace = recent.map((r) => r.event).join(', ') || '(无事件)';
        reject(new Error(`timeout waiting ${label ?? event}；最近收到的事件：${trace}`));
      }, timeout);
      socket.on(event, (msg) => {
        if (!predicate || predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  }

  // 最近事件轨迹：超时错误里带上它，避免"等到超时却不知道服务端说了什么"
  let recent = [];
  const track = (client) => {
    client.socket.onAny((event) => {
      recent.push({ event, at: Date.now() });
      if (recent.length > 30) recent = recent.slice(-30);
    });
  };

  const clientA = await openSocket(tokenA);
  track(clientA);
  check('客户端 A WS 连接成功', clientA.socket.connected);

  const badAuth = io(WS_BASE, { auth: { token: 'garbage' }, transports: ['websocket'] });
  const rejected = await new Promise((resolve) => {
    badAuth.on('connect', () => resolve(false));
    badAuth.on('connect_error', () => resolve(true));
    setTimeout(() => resolve(false), 5000);
  });
  badAuth.close();
  check('无有效 token 的连接被拒绝', rejected);

  const joinedA = waitFor(clientA.socket, SERVER_EVENTS.ROOM_JOINED);
  clientA.socket.emit(
    CLIENT_EVENTS.ROOM_JOIN,
    makeClientEnvelope(CLIENT_EVENTS.ROOM_JOIN, { roomId: room.id }, { roomId: room.id }),
  );
  const joinedAmsg = await joinedA;
  const boardId = joinedAmsg?.payload?.boardId;
  check('A 收到 room:joined 且带 boardId', Boolean(boardId));
  const snapA = await waitFor(clientA.socket, SERVER_EVENTS.BOARD_STATE);
  assertEqual('A 收到初始快照 seq=0', snapA.payload?.seq, 0);

  const clientB = await openSocket(tokenB);
  track(clientB);
  const joinedB = waitFor(clientB.socket, SERVER_EVENTS.ROOM_JOINED);
  clientB.socket.emit(
    CLIENT_EVENTS.ROOM_JOIN,
    makeClientEnvelope(CLIENT_EVENTS.ROOM_JOIN, { roomId: room.id }, { roomId: room.id }),
  );
  const joinedBmsg = await joinedB;
  check('B 收到 room:joined', Boolean(joinedBmsg));
  await waitFor(clientB.socket, SERVER_EVENTS.BOARD_STATE);

  // ---------------------------------------------------------------- 4. 形状 create + ack + 广播
  const nowIso = new Date().toISOString();
  const shapeId = randomUUID();
  const clientOpId = randomUUID();
  const shape = {
    id: shapeId,
    boardId,
    type: 'rect',
    x: 40,
    y: 60,
    w: 120,
    h: 80,
    rotation: 0,
    zIndex: 1,
    style: { stroke: '#16181d', fill: '#4C8DFF', strokeWidth: 2 },
    data: {},
    version: 1,
    createdBy: meA.body.user.id,
    deletedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const ackPromise = waitFor(clientA.socket, SERVER_EVENTS.SHAPE_ACK, {
    predicate: (m) => m?.payload?.clientOpId === clientOpId,
  });
  const broadcastToB = waitFor(clientB.socket, SERVER_EVENTS.SHAPE_CREATED);
  clientA.socket.emit(
    CLIENT_EVENTS.SHAPE_CREATE,
    makeClientEnvelope(
      CLIENT_EVENTS.SHAPE_CREATE,
      { boardId, shape, clientOpId },
      { reqId: 'req-create-1', roomId: room.id },
    ),
  );
  const ack = await ackPromise;
  check('create 收到 ack 且带权威 seq', Number.isInteger(ack.payload?.seq), `seq=${ack.payload?.seq}`);
  const broadcast = await broadcastToB;
  assertEqual('另一端收到 shape:created（同一 seq）', broadcast.payload?.seq, ack.payload?.seq);

  // ---------------------------------------------------------------- 5. 幂等
  const ack2Promise = waitFor(clientA.socket, SERVER_EVENTS.SHAPE_ACK, {
    predicate: (m) => m?.payload?.clientOpId === clientOpId,
  });
  clientA.socket.emit(
    CLIENT_EVENTS.SHAPE_CREATE,
    makeClientEnvelope(
      CLIENT_EVENTS.SHAPE_CREATE,
      { boardId, shape, clientOpId },
      { reqId: 'req-create-2', roomId: room.id },
    ),
  );
  const ack2 = await ack2Promise;
  assertEqual('重复 clientOpId 返回原 seq（无副作用）', ack2.payload?.seq, ack.payload?.seq);

  const stateAfter = await api(`/api/boards/${boardId}/state`, { token: tokenA });
  assertEqual('重复提交后状态里只有 1 个图形', stateAfter.body?.shapes?.length, 1);
  assertEqual('board.last_seq 未因重复提交增长', stateAfter.body?.seq, ack.payload?.seq);

  // ---------------------------------------------------------------- 6. 版本冲突
  const updateOk = waitFor(clientA.socket, SERVER_EVENTS.SHAPE_ACK, {
    predicate: (m) => m?.payload?.clientOpId === randomUUID(),
  });
  const op1 = randomUUID();
  const ack1Promise = waitFor(clientA.socket, SERVER_EVENTS.SHAPE_ACK, {
    predicate: (m) => m?.payload?.clientOpId === op1,
  });
  clientA.socket.emit(
    CLIENT_EVENTS.SHAPE_UPDATE,
    makeClientEnvelope(
      CLIENT_EVENTS.SHAPE_UPDATE,
      { boardId, shapeId, patch: { x: 100 }, baseVersion: 1, clientOpId: op1 },
      { reqId: 'req-update-1', roomId: room.id },
    ),
  );
  const ack1 = await ack1Promise;
  assertEqual('update 后版本 +1', ack1.payload?.serverShape?.version, 2);

  const op2 = randomUUID();
  const rejectedPromise = waitFor(clientA.socket, SERVER_EVENTS.SHAPE_REJECTED, {
    predicate: (m) => m?.payload?.clientOpId === op2,
  });
  clientA.socket.emit(
    CLIENT_EVENTS.SHAPE_UPDATE,
    makeClientEnvelope(
      CLIENT_EVENTS.SHAPE_UPDATE,
      { boardId, shapeId, patch: { x: 200 }, baseVersion: 1, clientOpId: op2 },
      { reqId: 'req-update-2', roomId: room.id },
    ),
  );
  const rejectedMsg = await rejectedPromise;
  assertEqual('陈旧 baseVersion 被拒 (VERSION_CONFLICT)', rejectedMsg.payload?.reason, ERROR_CODES.VERSION_CONFLICT);
  assertEqual('拒绝时带最新 serverShape', rejectedMsg.payload?.serverShape?.version, 2);
  updateOk.catch(() => {});

  // ---------------------------------------------------------------- 收尾
  clientA.socket.close();
  clientB.socket.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('验收脚本异常终止：', err);
  process.exit(1);
});

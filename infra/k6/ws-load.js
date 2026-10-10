/**
 * k6 压测脚本：WebSocket（socket.io）+ HTTP 混合负载
 * ============================================================================
 * 场景：N 个 VU 各自 —— 登录 → 建立 socket.io 连接 → 进房间 → 周期性发图形操作
 * （shape:create / shape:update / shape:delete）与多人光标（cursor:move），
 *       并对图形操作的 ACK 做 P95 延迟统计与阈值断言（计划书 §10 压测层）。
 *
 * 为什么能用 k6/ws 直接压 socket.io：
 *   socket.io 的传输层是 engine.io，engine.io v4 的 WebSocket 直连就是
 *   `GET /socket.io/?EIO=4&transport=websocket` 一次升级；之后全部是文本帧：
 *     '0{...sid...}'      ← engine.io OPEN（拿到 sid、心跳参数）
 *     '2' / '3'           ← engine.io PING / PONG（v4 由服务端发 ping，客户端回 pong）
 *     '40{"token":"..."}' → socket.io CONNECT（auth 载荷，等价于 JS 客户端的 auth 选项）
 *     '40{"sid":"..."}'   ← 连接成功
 *     '42["event:name", payload]'  → 发事件（原名/信封见下方 WS_EVENT / WS_PAYLOAD 开关）
 *     '42...' / '43<id>[...]' / '44{...}' ← 服务端事件 / ACK / CONNECT_ERROR
 *   因此不需要 socket.io-client，用 k6 内置的 k6/ws 即可（k6 的 ws 是实验性模块，
 *   但 e2e 压测场景足够稳定；协议细节以 socket.io v4 官方文档为准）。
 *
 * 运行（无需 k6 时见根 README「压测」一节）：
 *   k6 run infra/k6/ws-load.js                        # 默认 10 VU / 30s
 *   k6 run -e VUS=50 -e DURATION=2m infra/k6/ws-load.js
 *   k6 run --vus 50 --duration 2m infra/k6/ws-load.js # k6 原生写法：CLI 会整体覆盖 scenarios
 *                                                     #   （k6 会打一条 warn 说明覆盖，属预期）
 *   k6 run -e API_BASE=http://127.0.0.1:3001 -e ROOM_ID=<uuid> -e TOKEN=<jwt> infra/k6/ws-load.js
 *   k6 run --summary-export=infra/k6/summary.json infra/k6/ws-load.js
 *
 * 环境变量（全部可选，除 API_BASE 外都有本地默认值）：
 *   API_BASE        HTTP 基址，默认 http://localhost:3001
 *   WS_BASE         WS 基址，默认由 API_BASE 把 http→ws 推出来（Docker 里跑 k6 时
 *                   用 -e API_BASE=http://host.docker.internal:3001 即可）
 *   SOCKET_PATH     socket.io 路径，默认 /socket.io/
 *   VUS / DURATION  并发数与时长，默认 10 / 30s
 *   SESSION_MS      单条连接保持时长，默认 0 = 整个场景期间不主动断开
 *   SHAPE_INTERVAL_MS  图形操作间隔，默认 1000
 *   CURSOR_INTERVAL_MS 光标间隔，默认 40（对齐计划书 §7.4 的 30–50ms 节流）
 *   TOKEN / ROOM_ID / BOARD_ID  直接复用已有凭据/房间（跳过登录与建房）
 *   EMAIL / PASSWORD            复用已有账号（不给则自动注册 k6-<随机>@example.com）
 *   REGISTER_PATH / LOGIN_PATH / ROOMS_PATH  REST 路径，默认 /api/auth/register、
 *                   /api/auth/login、/api/rooms（按 web 侧 /api 反向代理约定）
 *   WS_EVENT        typed（默认，事件名就是 room:join / shape:create…）| generic（统一发到
 *                   GENERIC_EVENT 指定的单一事件名；该模式需配合 envelope 载荷才有 type 可分派）
 *   WS_PAYLOAD      envelope（默认，载荷为 {v,type,reqId,roomId,ts,payload} 信封）| raw（裸 payload）
 *   ACK_P95_MS      shape_ack_latency 的 P95 阈值（毫秒），默认 300
 *   JOIN_TIMEOUT_MS 进房看门狗，默认 10000
 *
 * 断言（thresholds）：
 *   checks.rate>0.98、ws_connecting p(95)<800ms、room_join_latency p(95)<500ms、
 *   shape_ack_latency p(95)<ACK_P95_MS、ws_session_ok rate>0.95。
 *   注：若某指标没有样本（例如没发图形操作），k6 会把对应阈值判为失败——这是有意的：
 *   压测必须真的打到了目标路径。
 */
import { check, fail, sleep } from 'k6';
import http from 'k6/http';
import ws from 'k6/ws';
import { Counter, Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const API_BASE = (__ENV.API_BASE || 'http://localhost:3001').replace(/\/+$/, '');
const WS_BASE = (__ENV.WS_BASE || API_BASE.replace(/^http/, 'ws')).replace(/\/+$/, '');
const SOCKET_PATH = __ENV.SOCKET_PATH || '/socket.io/';

const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30s';
const SESSION_MS = Number(__ENV.SESSION_MS || 0);
const SHAPE_INTERVAL_MS = Number(__ENV.SHAPE_INTERVAL_MS || 1000);
const CURSOR_INTERVAL_MS = Number(__ENV.CURSOR_INTERVAL_MS || 40);
const PING_INTERVAL_MS = Number(__ENV.PING_INTERVAL_MS || 5000);
const JOIN_TIMEOUT_MS = Number(__ENV.JOIN_TIMEOUT_MS || 10000);

const TOKEN = __ENV.TOKEN || '';
const EMAIL = __ENV.EMAIL || '';
const PASSWORD = __ENV.PASSWORD || 'k6-load-test-pass';
const ROOM_ID = __ENV.ROOM_ID || '';
const BOARD_ID = __ENV.BOARD_ID || '';

const REGISTER_PATH = __ENV.REGISTER_PATH || '/api/auth/register';
const LOGIN_PATH = __ENV.LOGIN_PATH || '/api/auth/login';
const ROOMS_PATH = __ENV.ROOMS_PATH || '/api/rooms';

const WS_EVENT = __ENV.WS_EVENT || 'typed'; // typed | generic
const GENERIC_EVENT = __ENV.GENERIC_EVENT || 'message';
const WS_PAYLOAD = __ENV.WS_PAYLOAD || 'envelope'; // envelope | raw
const ACK_P95_MS = Number(__ENV.ACK_P95_MS || 300);

// 事件名（与 packages/shared/src/events.ts 一一对应；此处硬编码是为了让脚本
// 不依赖构建产物，改了协议记得同步这里）
const EV = {
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  SHAPE_CREATE: 'shape:create',
  SHAPE_UPDATE: 'shape:update',
  SHAPE_DELETE: 'shape:delete',
  CURSOR_MOVE: 'cursor:move',
  PING: 'ping',
  ROOM_JOINED: 'room:joined',
  BOARD_STATE: 'board:state',
  BOARD_OPS: 'board:ops',
  SHAPE_ACK: 'shape:ack',
  SHAPE_REJECTED: 'shape:rejected',
  SHAPE_CREATED: 'shape:created',
  SHAPE_UPDATED: 'shape:updated',
  SHAPE_DELETED: 'shape:deleted',
  CURSOR_UPDATED: 'cursor:updated',
  ERROR: 'error',
};

// ---------------------------------------------------------------------------
// 自定义指标
// ---------------------------------------------------------------------------
const roomJoinLatency = new Trend('room_join_latency', true);
const shapeAckLatency = new Trend('shape_ack_latency', true);
const shapeOpsSent = new Counter('shape_ops_sent');
const shapeAcks = new Counter('shape_acks');
const shapeRejects = new Counter('shape_rejects');
const shapeBroadcasts = new Counter('shape_broadcasts');
const cursorSent = new Counter('cursor_sent');
const cursorUpdated = new Counter('cursor_updated');
const wsErrors = new Counter('ws_protocol_errors');
const wsSessionOk = new Rate('ws_session_ok');

export const options = {
  // 单场景（constant-vus）：并发与时长来自 VUS / DURATION（可用 -e 覆盖）。
  // 用 scenarios 而不是顶层 vus/duration 的唯一理由是 gracefulStop 只能配在场景上：
  // 连接是长连接，场景结束时需要 k6 主动断开，给 5s 收尾别让 summary 干等 30s。
  scenarios: {
    board: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '5s',
      exec: 'boardVU',
    },
  },
  thresholds: {
    checks: ['rate>0.98'],
    ws_connecting: ['p(95)<800'],
    room_join_latency: ['p(95)<500'],
    shape_ack_latency: [`p(95)<${ACK_P95_MS}`],
    ws_session_ok: ['rate>0.95'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
let uuidCounter = 0;
/**
 * UUID v4 —— 必须是**格式合法**的 UUID：协议层用 zod 的 `.uuid()` 校验，
 * 形状不对（长度、版本位、variant 位）会被服务端直接判 VALIDATION_FAILED。
 * 不需要密码学强度，只需要唯一 + 格式正确。
 */
function uuid() {
  uuidCounter += 1;
  const hexChar = () => Math.floor(Math.random() * 16).toString(16);
  const seg = (n) => {
    let out = '';
    for (let i = 0; i < n; i += 1) out += hexChar();
    return out;
  };
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  const time = Date.now().toString(16).slice(-8).padStart(8, '0');
  const seq = (uuidCounter & 0xfff).toString(16).padStart(3, '0');
  return `${time}-${seg(4)}-4${seg(3)}-${variant}${seg(3)}-${seg(9)}${seq}`;
}

/** 从（可能嵌套的）响应里取第一个存在的字段：不同实现的 REST 形状都能吃 */
function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function jsonSafe(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

/**
 * socket.io 帧编码。
 * WS_PAYLOAD=envelope 时按计划书 §6.2 封装 {v,type,reqId,roomId,ts,payload}；
 * WS_PAYLOAD=raw 时只发裸 payload（个别实现可能只收裸 payload）。
 */
function frame(eventName, payload, opts) {
  const o = opts || {};
  let body = payload;
  if (WS_PAYLOAD === 'envelope') {
    const envelope = { v: 1, type: eventName, ts: Date.now(), payload };
    if (o.reqId) envelope.reqId = o.reqId;
    if (o.roomId) envelope.roomId = o.roomId;
    body = envelope;
  }
  const channel = WS_EVENT === 'generic' ? GENERIC_EVENT : eventName;
  return `42${JSON.stringify([channel, body])}`;
}

// ---------------------------------------------------------------------------
// setup：只跑一次 —— 探活、准备账号（注册/登录）、准备房间
// ---------------------------------------------------------------------------
export function setup() {
  const health = http.get(`${API_BASE}/health`, { tags: { kind: 'setup' } });
  if (health.status !== 200) {
    fail(
      `API 不健康：GET ${API_BASE}/health → ${health.status}。` +
        `请先起后端（容器：docker compose --profile full up -d；本地：pnpm dev）。`,
    );
  }

  let token = TOKEN;
  let userId = __ENV.USER_ID || '';
  const email = EMAIL || `k6-${Math.floor(Math.random() * 1e9)}@example.com`;

  if (!token) {
    // 先注册（已存在会被忽略），再登录；两条路径都容忍 4xx —— 真实判据是拿到 token
    http.post(
      `${API_BASE}${REGISTER_PATH}`,
      JSON.stringify({ email, password: PASSWORD, displayName: 'k6 load' }),
      { headers: { 'Content-Type': 'application/json' }, tags: { kind: 'setup' } },
    );

    const login = http.post(
      `${API_BASE}${LOGIN_PATH}`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' }, tags: { kind: 'setup' } },
    );
    if (login.status >= 400) {
      fail(
        `登录失败：POST ${API_BASE}${LOGIN_PATH} → ${login.status} ${login.body}` +
          `（可用 -e TOKEN=<jwt> 直接跳过登录，或用 -e EMAIL/-e PASSWORD 指定已有账号）`,
      );
    }
    const body = jsonSafe(login) || {};
    token = pick(body, ['accessToken', 'access_token', 'token', 'data.accessToken', 'data.token']);
    userId = pick(body, ['user.id', 'userId', 'data.user.id', 'id']) || '';
    if (!token) {
      fail(
        `登录响应里找不到 access token（已尝试 accessToken/access_token/token）。` +
          `响应：${login.body}；可用 -e TOKEN=<jwt> 绕过`,
      );
    }
  }

  let roomId = ROOM_ID;
  let boardId = BOARD_ID;
  if (!roomId) {
    const created = http.post(
      `${API_BASE}${ROOMS_PATH}`,
      JSON.stringify({ name: `k6-load-${Date.now()}`, isPublic: true }),
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        tags: { kind: 'setup' },
      },
    );
    if (created.status >= 400) {
      fail(
        `建房失败：POST ${API_BASE}${ROOMS_PATH} → ${created.status} ${created.body}` +
          `（可用 -e ROOM_ID=<uuid> 指定已有房间）`,
      );
    }
    const body = jsonSafe(created) || {};
    roomId = pick(body, ['room.id', 'roomId', 'id', 'data.room.id', 'data.id']);
    boardId =
      pick(body, [
        'room.boardId', // 实测形状：POST /api/rooms → { room: { id, boardId, ... } }
        'board.id',
        'boardId',
        'data.board.id',
        'room.board.id',
        'data.room.boardId',
        'data.boardId',
      ]) || '';
    if (!roomId) {
      fail(`建房响应里找不到 roomId。响应：${created.body}；可用 -e ROOM_ID=<uuid> 指定`);
    }
  }

  console.log(`[k6] room=${roomId} board=${boardId || '(等待 room:joined 下发)'} user=${userId || '(未知)'}`);
  return { token, userId: userId || null, roomId, boardId };
}

// ---------------------------------------------------------------------------
// VU：一条 socket.io 连接的生命周期
// 同时作为默认导出：k6 的 CLI 选项 --vus/--duration 会整体覆盖 scenarios 配置，
// 那种情况下 k6 用 "default" 执行器并要求存在 default 导出（脚本内容不变）。
// ---------------------------------------------------------------------------
export function boardVU(data) {
  const url = `${WS_BASE}${SOCKET_PATH}?EIO=4&transport=websocket`;
  const params = {
    headers: { Authorization: `Bearer ${data.token}` }, // auth 走握手头（若网关只认 auth.token，下方 40 帧也带）
    tags: { kind: 'ws' },
  };

  const res = ws.connect(url, params, function (socket) {
    // --- 会话状态 ---
    let connected = false; // socket.io CONNECT 完成
    let joined = false; // 收到 room:joined
    let boardId = data.boardId; // 缺省时由 room:joined 下发
    let joinStartedAt = 0;
    let closed = false;
    // k6 的 socket 是 Go 宿主机对象：**不能**往它身上挂自定义属性（会 TypeError:
    // Cannot assign to property ... of a host object），所以定时器 id 必须存在普通
    // JS 变量里，而不是 socket.xxx。
    let joinWatchdogId;
    let shapeTimerId;
    let cursorTimerId;
    let pingTimerId;
    let sessionTimerId;
    const pendingAcks = {}; // reqId -> 发送时间戳
    const liveShapeIds = []; // 已创建的图形 id（供 update/delete 使用）
    let opCounter = 0;

    /** 清定时器：k6 各版本 socket 上可用的清理函数不完全一致，探测后再调 */
    function clearTimer(id) {
      if (id === undefined || id === null) return;
      ['clearInterval', 'clearTimeout'].forEach((fn) => {
        if (typeof socket[fn] === 'function') {
          try {
            socket[fn](id);
          } catch (e) {
            /* 忽略：定时器可能已经触发过 */
          }
        }
      });
    }

    function clearTimers() {
      [joinWatchdogId, shapeTimerId, cursorTimerId, pingTimerId, sessionTimerId].forEach(clearTimer);
      joinWatchdogId = undefined;
      shapeTimerId = undefined;
      cursorTimerId = undefined;
      pingTimerId = undefined;
      sessionTimerId = undefined;
    }

    function send(eventName, payload, opts) {
      socket.send(frame(eventName, payload, opts || {}));
    }

    function nowIso() {
      return new Date().toISOString();
    }

    function sendShapeCreate() {
      const shapeId = uuid();
      liveShapeIds.push(shapeId);
      if (liveShapeIds.length > 8) liveShapeIds.shift(); // 只留少量活跃图形，控制状态膨胀
      const x = Math.round(Math.random() * 2000 - 1000);
      const y = Math.round(Math.random() * 2000 - 1000);
      const clientOpId = uuid();
      const reqId = uuid();
      pendingAcks[reqId] = Date.now();
      send(
        EV.SHAPE_CREATE,
        {
          boardId,
          clientOpId,
          shape: {
            id: shapeId,
            boardId,
            type: 'rect',
            x,
            y,
            w: 80,
            h: 60,
            rotation: 0,
            zIndex: opCounter,
            style: { stroke: '#1f2937', fill: '#93c5fd', strokeWidth: 2, opacity: 1 },
            data: {},
            version: 1,
            createdBy: data.userId,
            deletedAt: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        },
        { reqId },
      );
      shapeOpsSent.add(1, { op: 'create' });
    }

    function sendShapeUpdate() {
      if (liveShapeIds.length === 0) return sendShapeCreate();
      const shapeId = liveShapeIds[0];
      const patch = { x: Math.round(Math.random() * 2000 - 1000), y: Math.round(Math.random() * 2000 - 1000) };
      const clientOpId = uuid();
      const reqId = uuid();
      pendingAcks[reqId] = Date.now();
      send(
        EV.SHAPE_UPDATE,
        { boardId, shapeId, patch, baseVersion: __ENV.BASE_VERSION ? Number(__ENV.BASE_VERSION) : 1, clientOpId },
        { reqId },
      );
      shapeOpsSent.add(1, { op: 'update' });
    }

    function sendShapeDelete() {
      if (liveShapeIds.length === 0) return sendShapeCreate();
      const shapeId = liveShapeIds.shift();
      const clientOpId = uuid();
      const reqId = uuid();
      pendingAcks[reqId] = Date.now();
      send(EV.SHAPE_DELETE, { boardId, shapeId, clientOpId }, { reqId });
      shapeOpsSent.add(1, { op: 'delete' });
    }

    function sendCursor() {
      send(EV.CURSOR_MOVE, {
        boardId,
        x: Math.round(Math.random() * 2000 - 1000),
        y: Math.round(Math.random() * 2000 - 1000),
        tool: 'pen',
      });
      cursorSent.add(1);
    }

    /** 收到服务端 '42[...]' 事件 */
    function onServerEvent(frameBody) {
      let name;
      let payload;
      try {
        const parsed = JSON.parse(frameBody); // 可能是 ["name", payload] 或 [payload]（信封模式）
        if (Array.isArray(parsed)) {
          name = parsed.length > 1 ? parsed[0] : undefined;
          payload = parsed.length > 1 ? parsed[1] : parsed[0];
        } else {
          payload = parsed;
        }
      } catch (e) {
        wsErrors.add(1, { reason: 'bad_event_frame' });
        return;
      }
      // 统一解析出事件名：优先 socket.io 事件名；通用通道/裸载荷则回落到信封上的 type
      if ((name === undefined || name === GENERIC_EVENT) && payload && payload.type) {
        name = payload.type;
      }
      const inner = payload && payload.payload !== undefined && WS_PAYLOAD === 'envelope' ? payload.payload : payload;
      const reqId = (payload && payload.reqId) || (inner && inner.reqId);

      switch (name) {
        case EV.ROOM_JOINED: {
          joined = true;
          roomJoinLatency.add(Date.now() - joinStartedAt);
          wsSessionOk.add(true); // 会话成功 = 建连 + 进房都通过
          if (inner && inner.boardId) boardId = inner.boardId;
          check(true, { 'room join ok': () => true });
          startWorkTimers();
          break;
        }
        case EV.BOARD_STATE:
        case EV.BOARD_OPS:
          // 快照/补齐到达都算健康信号；不在这里做状态哈希（由对账脚本负责）
          break;
        case EV.SHAPE_ACK: {
          shapeAcks.add(1);
          const key = (inner && inner.reqId) || reqId;
          if (key && pendingAcks[key]) {
            shapeAckLatency.add(Date.now() - pendingAcks[key]);
            delete pendingAcks[key];
          }
          break;
        }
        case EV.SHAPE_REJECTED: {
          shapeRejects.add(1);
          const key = (inner && inner.reqId) || reqId;
          if (key && pendingAcks[key]) delete pendingAcks[key];
          break;
        }
        case EV.SHAPE_CREATED:
        case EV.SHAPE_UPDATED:
        case EV.SHAPE_DELETED:
          shapeBroadcasts.add(1);
          break;
        case EV.CURSOR_UPDATED:
          cursorUpdated.add(1);
          break;
        case EV.ERROR:
          wsErrors.add(1, { reason: 'server_error_event' });
          break;
        default:
          break;
      }
    }

    function startWorkTimers() {
      if (shapeTimerId === undefined) {
        shapeTimerId = socket.setInterval(() => {
          if (closed) return;
          opCounter += 1;
          if (opCounter % 10 === 0) sendShapeDelete();
          else if (opCounter % 2 === 0) sendShapeUpdate();
          else sendShapeCreate();
        }, SHAPE_INTERVAL_MS);
      }
      if (cursorTimerId === undefined) {
        cursorTimerId = socket.setInterval(() => {
          if (closed) return;
          sendCursor();
        }, CURSOR_INTERVAL_MS);
      }
      if (pingTimerId === undefined) {
        pingTimerId = socket.setInterval(() => {
          if (closed) return;
          send(EV.PING, {});
        }, PING_INTERVAL_MS);
      }
    }

    socket.on('open', () => {
      check(true, { 'ws upgrade 101': () => true });
    });

    socket.on('message', (msg) => {
      if (typeof msg !== 'string' || msg.length === 0) return;
      const type = msg[0];

      if (type === '0') {
        // engine.io OPEN → 立刻发 socket.io CONNECT（auth 载荷：网关按 auth.token 校验）
        socket.send(`40${JSON.stringify({ token: data.token })}`);
        return;
      }
      if (type === '2') {
        // engine.io v4：服务端 ping，客户端回 pong（不回会被判死连接）
        socket.send('3');
        return;
      }
      if (type === '3') return; // pong：忽略

      if (type === '4') {
        const sub = msg[1];
        if (sub === '0') {
          // '40' / '40{"sid":...}' → socket.io 连接成功 → 进房
          connected = true;
          check(true, { 'socket.io connected': () => true });
          joinStartedAt = Date.now();
          send(EV.ROOM_JOIN, { roomId: data.roomId, sinceSeq: 0 }, { roomId: data.roomId });
          return;
        }
        if (sub === '2') {
          // '42[...]'：去掉前缀与可选 ackId，得到 JSON 数组
          const jsonStart = msg.indexOf('[');
          if (jsonStart > 0) onServerEvent(msg.slice(jsonStart));
          return;
        }
        if (sub === '4') {
          wsErrors.add(1, { reason: 'connect_error' });
          wsSessionOk.add(false);
          check(false, { 'socket.io connect ok': () => false });
          socket.close();
          return;
        }
        return; // '43'（socket.io ack）本脚本不依赖：权威回执走 shape:ack 事件
      }
    });

    socket.on('error', () => {
      wsErrors.add(1, { reason: 'ws_error' });
      wsSessionOk.add(false);
    });

    socket.on('close', () => {
      closed = true;
      clearTimers();
      Object.keys(pendingAcks).forEach((k) => delete pendingAcks[k]);
    });

    // 进房看门狗：超时未 joined 说明鉴权/成员校验没过，记录失败并断开，避免静默压空气
    joinWatchdogId = socket.setTimeout(() => {
      if (!joined) {
        wsSessionOk.add(false);
        check(false, { 'room join within timeout': () => false });
        socket.close();
      }
    }, JOIN_TIMEOUT_MS);

    // SESSION_MS>0 时主动断开（模拟重连）；=0 时不主动断，由 k6 在场景结束时关闭
    if (SESSION_MS > 0) {
      sessionTimerId = socket.setTimeout(() => socket.close(), SESSION_MS);
    }

    // 让回调保持存活：k6 的 ws.connect 会一直阻塞到这里（由 close / 场景结束触发）。
    // SESSION_MS=0 时给一个远大于场景时长的兜底值，实际由 k6 在场景结束时强制关闭
    // （summary 里体现为 "interrupted iterations"，长连接压测下属正常）。
    socket.setTimeout(() => {
      if (!closed) socket.close();
    }, SESSION_MS > 0 ? SESSION_MS + 1 : 60 * 60 * 1000);
  });

  check(res, { 'ws handshake ok (101)': (r) => !!r && r.status === 101 });
  if (res && res.status !== 101) {
    wsErrors.add(1, { reason: 'handshake_' + res.status });
  }
  sleep(0.1);
}

export default boardVU;

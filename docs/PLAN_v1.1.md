# 实时协作项目（Realtime Collaboration）计划书

| 项目代号 | realtime-collaboration |
| --- | --- |
| 文档版本 | v1.1（执行稿） |
| 项目定位 | 实时全栈 / 后端系统 |
| 技术栈 | TypeScript · Next.js · NestJS · WebSocket · Redis · PostgreSQL · Docker |
| 路线 | 第一版：多人在线白板 → 第二版：多人文本协同（OT / CRDT） |
| 当前状态 | 计划完成，准备进入 M0；开发采用本地 dev + Docker 依赖，生产提供 Compose |

---

## 1. 项目背景与目标

### 1.1 起点与终点

起点只是一个"多人一起画画"的小玩具。一旦把它放到分布式环境下，真正的问题就浮现出来了：

> **多个分布式客户端之间，如何保持共享状态一致？**

这个问题一旦被提出来，项目性质就从"前端小玩具"变成了"有技术含量的全栈 / 分布式系统"。本计划书要交付的，正是这条从玩具到系统的完整路径。

### 1.2 两版路线图

**第一版：多人在线白板**

```
多人在线白板
├── 登录
├── 创建房间
├── 加入房间
├── WebSocket
├── 创建 / 移动 / 删除图形
├── 实时同步
├── 在线用户
├── 光标
└── Redis + PostgreSQL
```

**第二版：多人文本编辑**

```
多人文本编辑
    ↓
并发修改
    ↓
冲突
    ↓
OT / CRDT
```

### 1.3 项目目标

| 编号 | 目标 | 衡量方式 |
| --- | --- | --- |
| G1 | 打通端到端实时链路 | 两个浏览器窗口的操作延迟 < 100ms（同局域网） |
| G2 | 状态最终一致 | 任意客户端在停止操作 500ms 后状态与服务端权威状态一致 |
| G3 | 具备可恢复性 | 断线 30s 内重连可自动补齐缺失操作，无需刷新页面 |
| G4 | 具备可扩展性 | 单实例 50 房间 / 200 并发连接下功能正常；架构支持多实例扩容 |
| G5 | 工程可交付 | `docker compose up` 一条命令起全栈，含健康检查与迁移 |

---

## 2. 范围界定

### 2.1 第一版范围内（In Scope）

- 账号体系：注册、登录、JWT 鉴权、（可选）匿名游客
- 房间：创建、加入（房间号 / 邀请码）、成员列表、房间列表
- 白板：矩形、椭圆、直线、箭头、自由画笔、文本
- 图形操作：创建、选中、移动、缩放、删除、层级调整、撤销 / 重做
- 实时同步：图形增量同步、在线用户、多人光标、选区高亮
- 断线重连：心跳、自动重连、增量补齐
- 持久化：房间与图形落 PostgreSQL，热数据与广播走 Redis
- 部署：Dockerfile + docker-compose，环境变量配置化

### 2.2 第一版不做（Out of Scope）

- 细粒度权限（只读 / 评论 / 审批流），第一版只区分 owner / member
- 图形富样式（渐变、阴影、滤镜）、图片上传、模板库
- 音视频通话、屏幕共享
- 移动端手势适配与触屏优化（仅保证可用）
- 历史版本回放、审计日志导出
- 多租户与计费

### 2.3 第二版新增范围

- 多人文本编辑器（富文本，基于 ProseMirror / TipTap）
- 并发修改合并（CRDT 为主，见 §7.6）
- 协同光标与选区、离线编辑后合并
- 文本与白板同房间共存（同一房间两种文档类型）

---

## 3. 技术选型

### 3.1 选型总表

| 层次 | 选型 | 理由 | 备选 |
| --- | --- | --- | --- |
| 语言 | TypeScript | 前后端 + 共享包同构，协议类型只定义一次 | — |
| 前端框架 | Next.js（App Router） | 路由 / SSR 外壳 / 生态成熟，便于后续加登录页与分享页 | Vite + React Router |
| 前端状态 | Zustand + Immer | 轻量、无样板、易做乐观更新与撤销栈 | Redux Toolkit |
| 画布渲染 | Canvas 2D（自研渲染层） | 可控性最高，便于做增量重绘与命中测试 | Konva / PixiJS |
| 后端框架 | NestJS | 模块化 + DI + 守卫 + 网关，适合长期演进 | Fastify 裸写 |
| 实时通道 | Socket.IO（`@nestjs/websockets`） | 自带房间、心跳、自动重连、Redis Adapter，第一版性价比最高 | 原生 `ws` + 自研协议 |
| 热数据 / 广播 | Redis | Presence、跨实例广播、限流计数；不承担最终一致性状态 | NATS / Kafka（过重） |
| 持久化 | PostgreSQL | 关系模型 + JSONB 存图形数据；事务负责 seq、op log 与状态投影的一致提交 | MySQL |
| ORM | Prisma | 类型安全、迁移与 seed 体验好 | TypeORM / Drizzle |
| 校验 | Zod（共享包） | 前后端共用同一套 schema，协议即类型 | class-validator |
| 测试 | Vitest + Supertest + Playwright + k6 | 单测 / 集成 / 多客户端 e2e / 压测四层 | Jest |
| 容器 | Docker + Docker Compose | 与题目要求一致，一键起依赖 | — |

### 3.2 关键选型说明

**Socket.IO vs 原生 ws。** 第一版选 Socket.IO：房间语义、断线重连、ack 回调、Redis Adapter 都是现成的，能把精力留给一致性逻辑本身。第二版接 CRDT 时，二进制增量（Yjs update）作为 `Uint8Array` 走同一通道即可，也可以按需为文档通道单独挂 `y-websocket`，两种方式都保留，见 §7.6。

**Prisma 迁移策略。** 开发期 `prisma migrate dev`，生产用 `prisma migrate deploy`，容器启动时以 init 容器或 entrypoint 顺序执行，避免应用实例并发迁移。

---

## 4. 系统架构

### 4.1 架构总览

```
┌──────────────────────┐        ┌──────────────────────┐
│  Browser Client A    │        │  Browser Client B    │
│  Next.js + Canvas    │        │  Next.js + Canvas    │
│  ├─ 乐观更新层        │        │  ├─ 乐观更新层        │
│  ├─ 本地撤销栈        │        │  └─ 重连 / 补齐       │
│  └─ 重连 / 补齐       │        └──────────┬───────────┘
└──────────┬───────────┘                   │
           │  HTTP (REST: 认证 / 房间)      │  WebSocket (实时通道)
           │  WS   (实时: 图形 / 光标 / 在线) │
           └───────────────┬───────────────┘
                           ▼
              ┌────────────────────────────┐
              │        NestJS API          │
              │  AuthModule  RoomModule    │
              │  BoardModule RealtimeGw    │
              │  PresenceModule            │
              │  ┌──────────────────────┐  │
              │  │ RoomActor（串行写）   │  │  每房间一个逻辑写者
              │  │ seq 分配 / 广播 / 快照 │  │
              │  └──────────────────────┘  │
              └───────┬────────────┬───────┘
                      │            │
        ┌─────────────▼──┐   ┌─────▼──────────────┐
        │   PostgreSQL   │   │      Redis         │
        │ users / rooms  │   │ presence / cursor  │
        │ shapes / ops   │   │ pub-sub / lock     │
        │ snapshots      │   │ rate-limit 计数    │
        └────────────────┘   └────────────────────┘
                      ▲
                      │ 多实例横向扩展：Redis Pub/Sub 广播
              ┌───────┴────────┐
              │  API Instance 2 │  ...（socket.io-redis-adapter）
              └────────────────┘
```

### 4.2 分层职责

| 层 | 职责 | 不做什么 |
| --- | --- | --- |
| 客户端渲染层 | 绘制、命中测试、交互 | 不做最终裁决 |
| 客户端同步层 | 乐观更新、op 队列、seq 对齐、重连补齐 | 不直接改权威状态 |
| 网关层（Gateway） | 握手鉴权、订阅管理、消息校验、限流 | 不写业务规则 |
| 领域层（RoomActor） | 排序、校验、seq 分配、广播、快照 | 不碰传输细节 |
| 持久层 | 事务写入、操作日志、快照 | 不做广播 |

### 4.3 三条设计原则

1. **服务端权威（Server-Authoritative）。** 客户端可以先画出来（乐观更新），但只有服务端确认的 `seq` 才是真相。任何客户端冲突以服务端裁决为准。
2. **写入必须可原子提交。** 第一版不依赖“进程内 Actor + Redis 锁”作为一致性的最终保障；真正的权威顺序由 PostgreSQL 事务产生。写操作在同一个事务中完成 `seq` 分配、`shape_ops` 写入和 `shapes` 投影更新。这样即使进程崩溃、重试或多实例并发，也不会出现“seq 已分配但 op 没落库”的永久空洞。
3. **操作日志即真相（轻量 Event Sourcing）。** `shape_ops` 不可变追加，`shapes` 是当前状态投影，快照只用于加速恢复。断线补齐读取 op log；冷启动从快照 + op log 重建。

---

## 5. 数据模型（PostgreSQL）

### 5.1 实体关系

```
users 1───n room_members n───1 rooms
rooms 1───1 boards 1───n shapes
boards 1──n shape_ops         (append-only)
boards 1──1 board_snapshots   (加速冷启动)
rooms 1──n documents 1──n document_updates   (第二版)
```

### 5.2 表结构（DDL 草案）

```sql
-- 用户
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  avatar_color  text NOT NULL DEFAULT '#4C8DFF',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 房间
CREATE TABLE rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  owner_id    uuid NOT NULL REFERENCES users(id),
  invite_code text UNIQUE NOT NULL,          -- 短码，用于加入
  is_public   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- 成员
CREATE TABLE room_members (
  room_id      uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member',   -- owner | member
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  PRIMARY KEY (room_id, user_id)
);

-- 画布（一个房间第一版一张画布，预留多画布能力）
CREATE TABLE boards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name       text NOT NULL DEFAULT 'main',
  last_seq   bigint NOT NULL DEFAULT 0,          -- 当前已提交的最大 seq
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 图形（操作日志的物化视图）
CREATE TABLE shapes (
  id         uuid PRIMARY KEY,                   -- 客户端生成，天然幂等
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type       text NOT NULL,                      -- rect|ellipse|line|arrow|freedraw|text
  x          double precision NOT NULL,
  y          double precision NOT NULL,
  w          double precision NOT NULL,
  h          double precision NOT NULL,
  rotation   double precision NOT NULL DEFAULT 0,
  z_index    integer NOT NULL DEFAULT 0,
  style      jsonb NOT NULL DEFAULT '{}',
  data       jsonb NOT NULL DEFAULT '{}',        -- freedraw 点集 / 文本内容
  version    bigint NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_shapes_board_alive ON shapes(board_id) WHERE deleted_at IS NULL;

-- 操作日志（append-only，一致性的核心）
CREATE TABLE shape_ops (
  id           bigserial PRIMARY KEY,
  board_id     uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq          bigint NOT NULL,                  -- 每 board 单调递增，权威顺序
  actor_id     uuid REFERENCES users(id),
  op_type      text NOT NULL,                    -- create|update|delete|restore|reorder
  shape_id     uuid,
  payload      jsonb NOT NULL,
  client_op_id uuid NOT NULL,                    -- 幂等键
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, seq),
  UNIQUE (board_id, client_op_id)
);
CREATE INDEX idx_shape_ops_board_seq ON shape_ops(board_id, seq);

-- 快照（每 N 个 op 或每 M 秒生成一次）
CREATE TABLE board_snapshots (
  board_id   uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  seq        bigint NOT NULL,
  state      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 刷新令牌
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
```

### 5.3 第二版补充

```sql
CREATE TABLE documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'untitled',
  state      bytea,                              -- Yjs 编码后的文档状态
  last_seq   bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_updates (
  id         bigserial PRIMARY KEY,
  doc_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq        bigint NOT NULL,
  update     bytea NOT NULL,                     -- Yjs update（二进制增量）
  actor_id   uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, seq)
);
```

> 说明：CRDT 的 update 本身可交换、可重复合并，`seq` 只用于恢复顺序与日志排查，不作为冲突裁决依据。

### 5.4 关键数据设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 图形 ID | 客户端生成 UUID | 乐观更新时本地已有稳定 ID，重试天然幂等 |
| seq 分配 | PostgreSQL 事务内锁定 `boards` 行并 `last_seq + 1` | seq 与 op/state 同事务提交，避免 Redis INCR 后事务失败产生永久空洞 |
| 软删除 | `deleted_at` | 断线客户端补齐时能看到"删除"操作，而不是状态凭空消失 |
| 样式/点集 | JSONB | 图形类型多、字段差异大，关系化收益低 |
| 快照阈值 | 每 200 个 op 或每 60s | 冷启动重放成本与写放大之间的平衡 |

---

## 6. 实时通信协议设计

### 6.1 通道划分

| 通道 | 内容 | 可靠性 | 是否落库 |
| --- | --- | --- | --- |
| 控制通道 | `room:join` / `room:leave` / `board:sync` / 错误 | 可靠（ack） | 部分 |
| 操作通道 | `shape:*` 图形增删改 | 可靠（ack + seq） | 是 |
| 瞬时通道 | `cursor:move` / 拖拽预览 | 尽力而为（可丢） | 否 |
| 状态通道 | `presence:*` 在线状态 | 可靠 | 否（Redis） |

### 6.2 消息信封

所有消息统一信封，便于日志、追踪与版本演进：

```ts
interface Envelope<T extends string, P> {
  v: 1;              // 协议版本
  type: T;           // 事件名
  reqId?: string;    // 客户端请求 id，用于 ack 关联
  roomId?: string;
  seq?: number;      // 服务端权威序号（服务端下发时携带）
  ts: number;        // 毫秒时间戳
  payload: P;
}
```

### 6.3 客户端 → 服务端

| 事件 | payload | 说明 |
| --- | --- | --- |
| `room:join` | `{ roomId, sinceSeq? }` | 进入房间；`sinceSeq` 用于增量补齐 |
| `room:leave` | `{ roomId }` | 主动离开 |
| `shape:create` | `{ boardId, shape, clientOpId }` | 创建图形 |
| `shape:update` | `{ boardId, shapeId, patch, baseVersion, clientOpId }` | 局部更新（移动/缩放/样式） |
| `shape:delete` | `{ boardId, shapeId, clientOpId }` | 软删除 |
| `shape:batch` | `{ boardId, ops: [...] }` | 批量（多选移动、撤销重做） |
| `cursor:move` | `{ boardId, x, y, tool }` | 高频，服务端按 30–50ms 节流 |
| `board:sync` | `{ boardId, sinceSeq }` | 请求增量操作 |
| `ping` | `{}` | 应用层心跳（与 Socket.IO 心跳并存，用于 RTT 统计） |

### 6.4 服务端 → 客户端

| 事件 | payload | 说明 |
| --- | --- | --- |
| `room:joined` | `{ roomId, self, members, boardId }` | 加入成功回执 |
| `board:state` | `{ boardId, seq, shapes }` | 全量快照（首次加入或 `sinceSeq` 过旧） |
| `board:ops` | `{ boardId, fromSeq, ops }` | 增量操作（重连补齐） |
| `shape:created` / `shape:updated` / `shape:deleted` | `{ seq, op }` | 权威广播 |
| `shape:ack` | `{ reqId, clientOpId, seq, serverShape }` | 确认 + 服务端裁决结果 |
| `shape:rejected` | `{ reqId, clientOpId, reason }` | 拒绝并让客户端回滚 |
| `cursor:updated` | `{ userId, x, y, tool }` | 他人光标 |
| `presence:joined` / `presence:left` / `presence:list` | `{ userId, ... }` | 在线用户 |
| `error` | `{ code, message }` | 统一错误 |

### 6.5 一致性规则（必须实现的六条）

1. **幂等**：`clientOpId` 唯一约束；重复提交时查询已有 op 并返回原 `seq`，不得再次修改状态。
2. **单调序**：服务端在 PostgreSQL 事务中为每个 `board` 分配下一个 `seq`；只有提交成功的 op 才进入日志与广播。
3. **检漏**：客户端发现收到的 `seq` 与本地期望不连续（`seq > expected`）→ 立即 `board:sync { sinceSeq: expected-1 }`。
4. **乐观更新 + 回滚**：本地先应用（标记 `pending`），收到 `shape:ack` 转正；收到 `shape:rejected` 回滚到服务端返回的状态。
5. **瞬时消息节流**：光标/拖拽预览本地按 30–50ms 合并发送，服务端不保证顺序与到达，前端直接覆盖式更新（带时间戳防抖）。
6. **陈旧快照丢弃**：`board:state` 携带 `seq`，若客户端本地 `seq` 更新则丢弃该快照，避免状态回退。

### 6.6 重连补齐时序

```
Client                          Server
  │  (TCP 断开)
  │                               ├─ presence:left 广播给其他人
  │  (后端重连，Socket.IO 自动重试)
  ├─ room:join { roomId, sinceSeq: 137 }
  │                               ├─ 校验成员身份
  │                               ├─ 若 sinceSeq >= snapshot.seq 且 op 日志完整
  │                               │     → board:ops { fromSeq: 138, ops: [...] }
  │                               └─ 否则 → board:state { seq: 210, shapes: [...] }
  ├─ 应用增量，重建本地视图
  └─ 恢复 pending 队列（未 ack 的操作重新提交，靠 clientOpId 去重）
```

---

## 7. 核心难点与解决方案

### 7.1 实时一致性（本项目的心脏）

问题本质：网络乱序 + 重试 + 多实例并发，会产生重复、丢失、乱序三种偏差。

方案：**数据库事务 + 服务端权威序列 + 客户端乐观更新**。
- PostgreSQL 事务负责 `seq + op log + state projection` 原子提交；
- `seq` 提供 board 内可比较的提交顺序；
- 客户端只做预测、缓存与补齐，不做最终裁决；
- 所有写操作进入 op log，缺失操作通过 `sinceSeq` 重放修复。

### 7.2 状态恢复（快照 + 重放）

`board:state` 全量快照 + `board:ops` 增量重放的组合。判断能否增量：客户端 `sinceSeq` 与快照 `seq` 之差是否小于保留窗口（建议 op log 保留 7 天，或按量保留最近 5 万条）。超出窗口就回落到全量快照，保证恢复永远可行。

### 7.3 横向扩展（多实例广播）

- 使用 `@socket.io/redis-adapter`，跨实例房间广播；
- **回音抑制**：优先用 adapter 自带的房间广播（`server.to(room).emit()`），避免"自己发的消息被自己再收一遍"；如需自定义 Redis 频道，消息带上 `instanceId`，发布者自身忽略；
- **写入一致性**：不要求同一房间永久粘在同一实例；多个实例都可接收写请求，数据库事务负责最终串行化与一致性。若后续压测证明需要，再增加房间级路由/队列优化；
- **广播风暴防护**：批量操作合并、光标节流、单房间广播频率上限（如 60 msg/s），超限合并为一次批广播。

### 7.4 高频事件性能

| 手段 | 做法 |
| --- | --- |
| 节流 | 光标 30–50ms 合并；拖拽中只发 `patch{x,y}`，不做完整对象序列化 |
| 压缩 | Socket.IO `perMessageDeflate` 对大批量文本有效；CRDT 走二进制 |
| 增量 | 图形更新只发送变化字段（`patch`），配合 `baseVersion` 做覆盖判断 |
| 背压 | 客户端 op 队列上限（如 500），超限降级为"仅发最终态" |
| 索引 | `shape_ops(board_id, seq)` 覆盖索引；`shapes` 部分索引排除软删 |

### 7.5 第一版冲突处理：版本校验 + 服务端裁决

第一版不做 CRDT，采用 **基于 `baseVersion` 的乐观并发控制**。这比直接称为“字段级 LWW”更准确：

1. 每个 `shape:update` 带 `baseVersion`；
2. 服务端事务中检查当前 `version` 是否等于 `baseVersion`；
3. 相等则应用 patch、`version + 1`、追加 op，并一起提交；不相等则返回 `shape:rejected`，附带最新 `serverShape`；
4. 客户端收到拒绝后，将本地 pending patch 重新基于 `serverShape` 尝试应用/重试；无法安全合并时才放弃该操作并提示用户；
5. 同一图形的复杂文本内容留到第二版 CRDT。

> 这套版本校验是**第一版的有意简化**：它优先保证状态可解释、可恢复，而不是解决任意细粒度并发编辑。第二版文本协作再由 CRDT 负责合并。

### 7.6 第二版：OT vs CRDT

| 维度 | OT（Operational Transformation） | CRDT（Yjs / Automerge） |
| --- | --- | --- |
| 核心思想 | 操作经过变换函数后可交换 | 数据结构本身满足交换律 / 幂等 |
| 服务端职责 | 需要中心化 transform server，维护版本与操作历史 | 只需存储与转发二进制 update |
| 离线支持 | 弱（依赖服务端序列） | 强（本地随意改，联网后合并） |
| 正确性难度 | 变换函数随操作类型暴增，易漏 case | 库已封装，正确性有形式化保证 |
| 数据体积 | 小（操作文本） | 大（含 tombstone 元数据），需 GC |
| 生态 | ShareDB、ot.js | Yjs（`y-prosemirror` / `y-websocket` / `y-redis`）、Automerge |
| 调试 | 变换 bug 极难复现 | 相对直观 |

**决策：第二版选 CRDT（Yjs）。** 理由：a) 无需自研并维护正确性极难的 transform 函数；b) 天然支持离线编辑与 P2P 场景；c) 与 ProseMirror/TipTap 集成成熟，协作光标、撤销、富文本开箱可用；d) 服务端退化为"持久化 + 转发"，与第一版已有的 `seq` / op log 架构天然兼容。

**接入方式（两种，择一或并存）：**

1. **同通道**：新增 `doc:update` 事件，payload 为 `Uint8Array`（Yjs update）。复用现有 Socket.IO 鉴权、房间与 Redis 广播，一致性语义由 CRDT 自己保证，服务端只追加 `document_updates`。
2. **独立 Provider**：文档通道单独挂 `y-websocket`（配 `y-redis`），白板通道保持现状，职责彻底分离。

第一版建议按方式 1 设计协议（预留 `doc:*` 事件类型），第二版按实测决定是否拆分。

### 7.7 安全

| 面 | 措施 |
| --- | --- |
| 认证 | 短时 JWT（access 15min）+ 可撤销 refresh token；WS 握手时校验 `auth.token` |
| 授权 | 每次 `room:join` 与每个写事件都校验 `room_members`（不信任客户端声明的 roomId） |
| 输入校验 | 共享包内 Zod schema 在网关层统一 parse；图形坐标/尺寸做数值上界（防 NaN / Infinity） |
| 消息体限制 | `maxHttpBufferSize` 限制（如 1MB），超限断开 |
| 限流 | 每用户每房间写事件令牌桶（如 60/s），光标事件（如 30/s）；Redis 计数支持多实例 |
| 注入 | Prisma 参数化查询；文本内容前端以文本节点渲染，禁用 `dangerouslySetInnerHTML` |
| 容器 | 镜像非 root 运行、`--read-only` 根文件系统（可选）、仅暴露必要端口 |
| 密钥 | 全部走环境变量，`.env` 不入库，提供 `.env.example` |

### 7.8 可观测性

- 结构化日志（pino）：每条消息带 `traceId` / `roomId` / `userId` / `seq`
- 关键指标：在线连接数、房间数、消息吞吐、广播延迟 P50/P95/P99、op 队列积压、重连次数
- 健康检查：`/health`（存活）与 `/ready`（DB + Redis 可连通）
- 一致性对账脚本：随机操作序列跑完后，比对各客户端与服务端最终状态哈希

---

## 8. 目录结构（Monorepo 规划）

```
realtime-collaboration/
├── apps/
│   ├── web/                    # Next.js 前端
│   │   ├── app/                # App Router：登录、房间列表、白板页
│   │   ├── components/         # Canvas、工具栏、在线头像、光标层
│   │   ├── lib/
│   │   │   ├── socket/         # 连接管理、重连、op 队列、seq 对齐
│   │   │   └── board/          # 渲染、命中测试、乐观更新、撤销栈
│   │   └── stores/             # Zustand：board / presence / session
│   └── api/                    # NestJS 后端
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/       # 注册登录、JWT、守卫
│       │   │   ├── room/       # 房间 CRUD、成员、邀请码
│       │   │   ├── board/      # 图形业务、op log、快照
│       │   │   └── presence/   # 在线状态、光标
│       │   ├── realtime/       # RealtimeGateway、RoomActor、Redis Adapter
│       │   ├── common/         # 过滤器、拦截器、限流、日志
│       │   └── prisma/         # PrismaService + migrations + seed
│       └── test/
├── packages/
│   ├── shared/                 # 协议类型、Zod schema、事件常量、错误码
│   └── config/                 # eslint / tsconfig / prettier 基线
├── infra/
│   ├── docker/                 # Dockerfile.web / Dockerfile.api
│   └── postgres/init.sql
├── docs/
│   └── PLAN.md                 # 本计划书
├── docker-compose.yml          # web + api + postgres + redis
├── pnpm-workspace.yaml
├── package.json
└── .env.example
```

---

## 9.0 实现顺序原则（先跑通，再分布式化）

本项目第一目标不是一次性把所有基础设施做满，而是先跑通这条闭环：

**浏览器操作 → WebSocket → 服务端校验 → PostgreSQL 原子提交 → 广播 → 其他客户端更新 → 断线后补齐**

因此按以下顺序实现：

1. **单机单房间**：登录 → 房间 → Canvas → WebSocket。
2. **单机一致性**：加入 `clientOpId`、PostgreSQL 事务、`seq`、op log、ack。
3. **断线恢复**：加入 `sinceSeq`、snapshot + op log、pending 重试。
4. **协作体验**：加入 cursor、presence、选区、撤销/重做。
5. **多实例**：最后接 Redis Adapter，并用测试证明跨实例广播正常。
6. **压测与加固**：最后再处理限流、指标、Docker、k6。

> 原则：Redis 负责“快”和“广播”，PostgreSQL 负责“真相”；不要为了体现分布式而把一致性问题提前复杂化。

## 9. 里程碑与排期

> 估时按"单人全职、包含自测"计，单位为**人日**。并行可压缩总周期。

### 第一版

| 里程碑 | 内容 | 交付物 | 验收标准 | 估时 |
| --- | --- | --- | --- | --- |
| **M0 骨架与基础设施** | pnpm workspace、NestJS/Next.js 骨架、`packages/shared`、docker-compose（pg + redis）、CI（lint + typecheck） | 可 `pnpm dev` 起双端，`docker compose up -d postgres redis` 起依赖 | `/health` 与 `/ready` 返回 200 | 2 |
| **M1 认证与房间** | 注册/登录、JWT + refresh、房间 CRUD、邀请码加入、成员表 | REST 接口 + 前端登录页与房间列表 | 两个账号可互相加入同一房间 | 4 |
| **M2 实时网关与在线状态** | Socket.IO 网关、握手鉴权、房间订阅、presence、Redis Adapter、心跳断线 | 在线用户列表实时变化 | 关闭一个标签页，另一端 3s 内看到成员离开 | 4 |
| **M3 画布与图形** | Canvas 渲染层、工具栏（矩形/椭圆/线/箭头/自由画/文本）、创建/移动/缩放/删除、服务端持久化 | 单人可完整绘制并刷新后保留 | 刷新页面图形不丢 | 5 |
| **M4 实时同步与一致性** | `seq` 分配、op log、广播、乐观更新 + ack/回滚、断线增量补齐、LWW 冲突 | 双端实时同步 | 断网 30s 恢复后两端状态一致；乱序/重复消息不产生脏数据 | 6 |
| **M5 光标与协同体验** | 光标节流广播、选区高亮、本地撤销/重做、图形层级与多选 | 多人光标与协作手感 | 4 人同房间操作，光标流畅不卡顿 | 3 |
| **M6 加固与部署** | 输入校验与限流、错误处理、日志指标、测试补齐、镜像与 compose 一键起 | `docker compose up` 全栈可跑 | 一键起后完成一次 4 人协作；单测覆盖核心一致性逻辑 | 4 |
| | | | **第一版合计** | **28** |

### 第二版

| 里程碑 | 内容 | 验收标准 | 估时 |
| --- | --- | --- | --- |
| **M7 CRDT 接入** | Yjs 文档模型、`doc:*` 协议、`document_updates` 持久化、快照合并 | 两客户端文本增量可合并且服务端可重放恢复 | 4 |
| **M8 富文本编辑器** | TipTap + `y-prosemirror`、协作光标与选区、历史（undo/redo）、文档列表 | 两人同时编辑同一段文字不丢字、不错位 | 6 |
| **M9 冲突验证与压测** | 并发/离线合并用例、随机操作对账、k6 压测报告 | 一致性对账脚本全绿；给出并发上限与瓶颈结论 | 4 |
| | | **第二版合计** | **14** |

**总计：第一版约 28 人日，第二版约 14 人日（≈ 6 周 + 3 周）。**

---

## 10. 测试与验收策略

| 层次 | 工具 | 覆盖重点 |
| --- | --- | --- |
| 单元测试 | Vitest | seq 分配、op 应用（apply/revert）、LWW 裁决、Zod schema |
| 集成测试 | Supertest + Testcontainers | 认证、房间鉴权、op log 写入与重放、快照生成 |
| 实时 e2e | Playwright（多 BrowserContext） | 3 个"用户"同时绘图、光标、断线重连、刷新恢复 |
| 一致性对账 | 自研脚本 | 随机操作序列 → 比较各端状态哈希与服务端权威哈希 |
| 压测 | k6（WS 脚本） | 200 / 500 / 1000 连接下的延迟 P95、内存、广播风暴表现 |

**第一版验收清单（Definition of Done）**

- [ ] `docker compose up` 后无需手工步骤即可访问前端
- [ ] 4 个客户端同房间协作，图形一致、光标可见、在线列表正确
- [ ] 断网 30s 后自动恢复且不丢操作、不产生重复图形
- [ ] 重复提交同一 `clientOpId` 不产生副作用
- [ ] 冷启动可从快照 + op log 完整重建画布
- [ ] 非成员无法加入房间、无法向房间写入（授权测试用例通过）
- [ ] 单测 + e2e 全绿，附带一份压测报告

---

## 11. 部署与运行

### 11.1 Compose 服务清单

| 服务 | 镜像 / 构建 | 端口 | 依赖 |
| --- | --- | --- | --- |
| `postgres` | `postgres:17-alpine` | 5432（仅内网） | — |
| `redis` | `redis:7-alpine`（开 AOF） | 6379（仅内网） | — |
| `api` | `infra/docker/Dockerfile.api` | 3001 | postgres(healthy), redis(healthy) |
| `web` | `infra/docker/Dockerfile.web` | 3000 | api |
| `migrate` | 同 api 镜像，一次性 | — | postgres(healthy) |

### 11.2 环境变量（草案）

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `NODE_ENV` | 运行环境 | `production` |
| `DATABASE_URL` | Postgres 连接串 | `postgresql://app:app@postgres:5432/collab` |
| `REDIS_URL` | Redis 连接串 | `redis://redis:6379` |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | 令牌密钥与有效期 | `***` / `15m` |
| `REFRESH_TOKEN_TTL` | 刷新令牌有效期 | `30d` |
| `WS_MAX_BUFFER` | 单消息上限（字节） | `1048576` |
| `CORS_ORIGIN` | 允许来源 | `http://localhost:3000` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `OPLOG_RETENTION_DAYS` | op log 保留天数 | `7` |

### 11.3 运行方式（**待定**）

**开发环境：本地 dev + Docker 依赖。** `pnpm dev` 运行 web/api，Docker 只运行 PostgreSQL + Redis，方便学习、调试和 HMR。

**生产/验收环境：Compose。** 提供 `docker compose up` 一键启动完整栈，保证最终交付环境一致。

---

## 12. 风险登记表

| # | 风险 | 影响 | 概率 | 对策 |
| --- | --- | --- | --- | --- |
| R1 | 一致性逻辑出 bug（丢操作、重复图形） | 高 | 中 | op log + `clientOpId` 幂等 + 一致性对账脚本 + 随机化测试 |
| R2 | 乐观更新回滚造成界面闪烁 | 中 | 中 | pending 标记 + 版本号比对 + 只在被拒时回滚 |
| R3 | 多实例广播出现回音 / 重复消息 | 中 | 中 | 优先用 adapter 房间广播；自定义频道带 `instanceId` 过滤 |
| R4 | 高频光标拖垮服务端 | 中 | 中 | 客户端节流 + 服务端频率上限 + 合并批广播 |
| R5 | Canvas 自研渲染层工作量超预期 | 中 | 中 | 第一版只做必要图元与命中测试；必要时切换到 Konva |
| R6 | CRDT 数据膨胀 / 加载变慢 | 中 | 中 | 定期快照 + `document_updates` 归档 + Yjs GC |
| R7 | 范围蔓延（权限、样式、移动端） | 高 | 高 | 严格按 §2.2 排除，新需求进 Backlog 不进当前里程碑 |
| R8 | 本地环境差异（pnpm / Docker / 端口冲突） | 低 | 中 | 统一走容器与 corepack；`.env.example` + README 步骤化 |
| R9 | 生产环境真实网络抖动导致频繁重连 | 中 | 中 | 指数退避 + 补齐幂等 + 连接质量指标监控 |

---

## 13. 待确认事项（Open Questions）

| # | 问题 | 影响 | 建议默认值 |
| --- | --- | --- | --- |
| Q1 | 开发与生产运行方式 | 影响 M0/M6 | **开发 B + 生产 Compose** |
| Q2 | 是否推进第二版（OT/CRDT）？ | 影响总周期（+14 人日） | 第一版验收后再决定 |
| Q3 | 认证方式：邮箱密码 / OAuth / 匿名游客？ | 影响 M1 范围 | 邮箱密码 + 可选匿名游客 |
| Q4 | 是否需要历史回放与审计？ | op log 已具备基础，需另做 UI | 第一版不做，保留数据能力 |
| Q5 | 部署目标（本地 / 单机 VPS / 云）？ | 影响 TLS、域名、反代配置 | 单机 VPS + Caddy |
| Q6 | ORM 用 Prisma 还是 TypeORM？ | 影响 M0 起手式 | **Prisma** |
| Q7 | 前端画布自研还是用 Konva？ | 影响 M3 工时与可控性 | 自研（可控性优先） |

---

## 14. 附录

### 14.1 术语表

| 术语 | 含义 |
| --- | --- |
| seq | 单个 board 内单调递增的操作序号，服务端权威顺序 |
| op log | 不可变的操作日志，系统真相来源 |
| snapshot | 某一 seq 处的完整状态，用于加速恢复 |
| 乐观更新 | 本地先应用操作，待服务端确认后转正 |
| Presence | 在线用户状态（谁在线、在哪、光标位置） |
| LWW | Last-Write-Wins，以最后写入者为准的冲突策略 |
| OT / CRDT | 两种协同编辑冲突解决范式，详见 §7.6 |

### 14.2 参考方向

- Yjs 官方文档与 `y-prosemirror` / `y-websocket` 集成
- Socket.IO Redis Adapter 与房间广播语义
- Figma / Excalidraw 的多人协作公开技术分享（白板交互参考）
- Prisma 迁移与生产部署最佳实践

---

*文档结束。本计划书已收敛为 v1.1 执行稿，可直接进入 M0。*

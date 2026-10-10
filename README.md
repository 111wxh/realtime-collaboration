# 实时协作白板（Realtime Collaboration）

> 一句话架构：**Next.js（web）+ NestJS（api）双端 + PostgreSQL（真相）+ Redis（广播/在线态）**，
> pnpm monorepo，共享包 `@collab/shared` 承载协议类型；开发用本地 dev + Docker 依赖，
> 交付用一份 `docker-compose.yml` 一键起全栈（含迁移与健康检查）。

计划书：[`docs/PLAN_v1.1.md`](docs/PLAN_v1.1.md)（§11 部署与运行、§8 目录结构、§10 验收策略）。

---

## 1. 快速开始

### 1.1 本地开发（推荐日常使用：HMR / 断点 / 日志）

```bash
pnpm install          # 需要 Node >= 20（本仓库 packageManager 固定 pnpm@12.6.0）
pnpm infra:up         # = docker compose up -d postgres redis（只起两个依赖）
pnpm dev              # 先 build @collab/shared，再并行起 api(3001) + web(3000)
```

| 服务 | 宿主地址 | 容器内地址 | 说明 |
| --- | --- | --- | --- |
| web | <http://localhost:3000> | `web:3000` | Next.js |
| api | <http://localhost:3001> | `api:3001` | NestJS（REST + Socket.IO） |
| postgres | `localhost:5433` | `postgres:5432` | 宿主 5432 常被占用，刻意避让 |
| redis | `localhost:6379` | `redis:6379` | 开 AOF |

> 宿主连接串：`postgresql://app:app@localhost:5433/collab`、`redis://localhost:6379`
> 容器内连接串：`postgresql://app:app@postgres:5432/collab`、`redis://redis:6379`
> 两者都不能写错——`localhost` 在容器里指的是容器自己。

### 1.2 全栈容器（验收 / 交付：一条命令）

```bash
docker compose --profile full up -d --build     # = pnpm docker:up
# 启动顺序：postgres/redis(healthy) → migrate(一次性, prisma migrate deploy) → api(healthy) → web
open http://localhost:3000
docker compose --profile full down              # 收工（= pnpm docker:down）
```

`api` / `web` / `migrate` 挂在下 `full` profile 上，因此：

- `docker compose up -d`（不带 profile）和 `docker compose up -d postgres redis`
  **仍然只起 postgres + redis** —— 本地 dev 的老用法不回归；
- 全栈必须带 `--profile full`（或直接用 `pnpm docker:up`）。

| 脚本 | 等价命令 | 用途 |
| --- | --- | --- |
| `pnpm infra:up` | `docker compose up -d postgres redis` | 本地 dev 依赖 |
| `pnpm infra:down` | `docker compose down` | 停掉本项目全部容器 |
| `pnpm docker:up` | `docker compose --profile full up -d --build` | 全栈一键起 |
| `pnpm docker:down` | `docker compose --profile full down` | 全栈收工 |
| `pnpm docker:build` | `docker compose --profile full build` | 只构建镜像 |
| `pnpm docker:logs` | `docker compose --profile full logs -f` | 跟踪全栈日志 |

---

## 2. 环境变量

`.env.example` 是唯一真源；`docker compose` 会自动读取根目录 `.env` 做插值。

| 变量 | 本地 dev（`.env`） | 容器内（compose 注入） | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `production` | — |
| `PORT` | `3001` | `3001` | api 监听端口 |
| `DATABASE_URL` | `postgresql://app:app@localhost:5433/collab` | `postgresql://app:app@postgres:5432/collab` | 服务名直连，不走宿主端口 |
| `REDIS_URL` | `redis://localhost:6379` | `redis://redis:6379` | 同上 |
| `CORS_ORIGIN` | `http://localhost:3000` | `${CORS_ORIGIN:-http://localhost:3000}` | 允许来源，逗号分隔多值 |
| `JWT_SECRET` | `dev-only-change-me` | `${JWT_SECRET:-dev-only-change-me}` | 生产必须换 |
| `JWT_EXPIRES_IN` / `REFRESH_TOKEN_TTL` | `15m` / `30d` | 透传 | — |
| `WS_MAX_BUFFER` | `1048576` | 透传 | 单条 WS 消息上限（字节） |
| `OPLOG_RETENTION_DAYS` | `7` | 透传 | op log 保留天数 |
| `LOG_LEVEL` | `info` | 透传 | pino 级别 |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | **构建期** build arg，默认 `http://localhost:3001` | 浏览器侧地址（打进前端包） |
| `NEXT_PUBLIC_WS_URL` | `http://localhost:3001` | 同上 | Socket.IO 直连地址 |
| `API_INTERNAL_URL` | 可留空 | `http://api:3001` | web 的 `/api/*` 反向代理目标（服务端侧，容器内按服务名） |
| `NPM_REGISTRY` | — | build arg，默认空 | 可选：镜像构建走内网/镜像源，如 `https://registry.npmmirror.com` |

> 待补进 `.env.example`（本文件未改它）：`API_INTERNAL_URL`（容器用，注释说明即可）、
> 可选 `NPM_REGISTRY`。清单见交付报告。

---

## 3. 容器与交付

### 3.1 服务与依赖关系

```
docker compose --profile full up -d
        ┌─────────────┐  healthy   ┌──────────┐
        │  postgres   │◄───────────│ migrate  │  一次性：prisma migrate deploy
        │  (5433:5432)│            └────┬─────┘  完成即退出（restart: "no"）
        └──────┬──────┘                 │ completed_successfully
               │ healthy                ▼
        ┌──────┴──────┐  healthy   ┌──────────┐  started  ┌──────────┐
        │    redis    │◄───────────│   api    │◄──────────│   web    │
        │  (6379)     │            │  3001    │           │  3000    │
        └─────────────┘            └──────────┘           └──────────┘
```

- `api` 与 `migrate` **用同一个镜像** `collab-api:local`（同一份 Dockerfile，migrate 只是换 command）；
- `web` 通过 `API_INTERNAL_URL=http://api:3001` 反向代理 `/api/*` 到 api，浏览器只跟 web 同源；
- 迁移只在 `migrate` 里执行一次，避免多实例并发迁移（计划书 §3.2）。

### 3.2 镜像构建路径与关键决策

| 项目 | 决策 | 原因 |
| --- | --- | --- |
| 基础镜像 | `node:24-bookworm-slim`（glibc） | `argon2` 的预编译产物只有 `prebuilds/linux-x64`（glibc），alpine/musl 会退回源码编译，需要 build-essential + python3 |
| 依赖安装 | pnpm 12.6.0（与 `packageManager` 一致），`--frozen-lockfile` | 版本漂移为零；CI 语义 |
| 原生包构建脚本 | 必须 `COPY pnpm-workspace.yaml` | pnpm 12 的 `allowBuilds` 白名单住在 workspace 配置里，缺了它 argon2 / @prisma/engines 的 install 脚本被拦截 |
| 供应链策略 | `--config.minimumReleaseAge=0` | pnpm 12 默认"最小发布年龄 1440 分钟 + strict"，会拒绝刚发布的版本；镜像内的确定性由 lockfile 保证 |
| api 运行时 | `pnpm deploy --prod` 的自包含目录（dist + prisma/ + 生产 node_modules） | 无 workspace 软链、无 devDependencies（tsc/vitest/@swc/core 都不在）；细节与体积见 §7.3 |
| prisma CLI | 在 api 镜像里按同一版本号单独装一份到 `/opt/prisma-cli`，软链 `/usr/local/bin/prisma` | CLI 是 devDependency，`deploy --prod` 不会带；迁移容器要用 |
| prisma client | `prisma generate` 在 workspace 与 deploy 目录各跑一次 | schema 用默认 generator（无 output），生成物必须落在运行时那份 `node_modules/.prisma/client` 里 |
| web 运行时 | Next.js `output: 'standalone'`，入口 `apps/web/server.js` | monorepo 下 standalone 保留路径：`.next/standalone/apps/web/server.js`；静态资源需手动拷贝 `.next/static` 与 `public` |
| 非 root | `USER node`，`COPY --chown=node:node` | 计划书 §7.7 容器安全项 |
| 健康检查 | 镜像 `HEALTHCHECK` + compose `healthcheck`（`node -e fetch(...)`，不依赖 curl） | 基础镜像里没有 curl |
| 数据卷 | `postgres-data` / `redis-data` 命名卷（沿用原有名字） | 已有本地数据不丢 |

---

## 4. 压测（k6）

脚本：`infra/k6/ws-load.js`。用 k6 内置的 `k6/ws` 直接走 engine.io/socket.io 的
WebSocket 直连（`?EIO=4&transport=websocket` + `40{"token":...}` 完成 socket.io 握手），
不依赖 socket.io-client：

**场景流**：`GET /health` 探活 → 注册/登录拿 JWT → 建房 → N 个 VU 各建一条 WS →
`room:join` → 周期性发 `shape:create/update/delete`（带 `clientOpId`、`reqId`）与
`cursor:move`（默认 40ms，对齐 §7.4 的节流值）+ 应用层 `ping`。

**阈值**（括号内为可用环境变量覆盖）：

| 指标 | 阈值 | 含义 |
| --- | --- | --- |
| `shape_ack_latency` | `p(95) < 300ms`（`ACK_P95_MS`） | 图形操作 ack 延迟 P95 |
| `room_join_latency` | `p(95) < 500ms` | 进房耗时 P95 |
| `ws_connecting` | `p(95) < 800ms` | WS 建连（含 engine.io 握手）P95 |
| `checks` | `rate > 0.98` | 断言通过率 |
| `ws_session_ok` | `rate > 0.95` | 成功建连并联上的会话占比 |

### 安装 k6

```bash
# Windows（任选）
winget install k6 --source winget
scoop install k6
choco install k6
# macOS / Linux
brew install k6        # 或按官方文档加 apt/dnf 源
```

没有本机安装时，用官方镜像跑（脚本从 stdin 读入，适配 Docker Desktop）：

```bash
docker run --rm -i -e API_BASE=http://host.docker.internal:3001 \
  grafana/k6 run - < infra/k6/ws-load.js
```

### 运行

```bash
# 默认 10 VU / 30s
k6 run infra/k6/ws-load.js

# 环境变量控制规模
k6 run -e VUS=50 -e DURATION=2m infra/k6/ws-load.js

# k6 原生写法：CLI 的 --vus/--duration 会**整体覆盖**脚本里的 scenario 配置
# （k6 会打一条 "cli level configuration overrode scenarios configuration entirely" 的
#  warning，属预期行为；脚本同时导出了 default，两种写法都能跑）
k6 run --vus 50 --duration 2m infra/k6/ws-load.js

# 复用已有房间/令牌，跳过注册登录
k6 run -e TOKEN=<jwt> -e ROOM_ID=<uuid> infra/k6/ws-load.js

# 导出 JSON 结果（k6 内置，无额外依赖）
k6 run --summary-export=infra/k6/summary.json infra/k6/ws-load.js
```

其他常用开关（详见脚本头部注释）：`SHAPE_INTERVAL_MS`、`CURSOR_INTERVAL_MS`、
`SESSION_MS`（>0 时到点断开，用来压重连）、`WS_EVENT=typed|generic`、
`WS_PAYLOAD=envelope|raw`（协议实现方式的兜底开关）。

> 实测（本机 compose 栈，`VUS=2 / DURATION=12s`）：`checks` 100%、`ws_session_ok` 100%、
> `shape_ack_latency` P95=58ms、`cursor_sent/cursor_updated` = 168/168。
> `shape_rejects` 非 0 属预期：脚本对同一图形固定用 `baseVersion=1` 发 update，
> 服务端乐观并发控制会返回 `VERSION_CONFLICT`（要减少可用 `-e BASE_VERSION=<n>`）。

> 脚本硬编码了事件名（不依赖构建产物）：改动 `packages/shared/src/events.ts` 时，
> 记得同步脚本顶部的 `EV` 表。

---

## 5. 目录结构（与交付相关的部分）

```
realtime-collaboration/
├── apps/
│   ├── api/                 # NestJS：REST + Socket.IO；prisma/schema.prisma + migrations/
│   └── web/                 # Next.js：app/ 页面；next.config.ts（output: standalone）
├── packages/shared/         # 协议类型 / 事件常量 / Zod schema（前后端共用）
├── infra/
│   ├── docker/
│   │   ├── Dockerfile.api   # 多阶段；api 与 migrate 共用
│   │   └── Dockerfile.web   # 多阶段；Next.js standalone
│   └── k6/ws-load.js        # WebSocket 压测脚本
├── docs/PLAN_v1.1.md        # 计划书
├── docker-compose.yml       # postgres / redis（默认）+ api / web / migrate（profile: full）
├── .dockerignore            # 构建上下文过滤（node_modules / .env* / 产物）
└── README.md                # 本文件
```

---

## 6. 验收清单

### 6.1 交付/基础设施（本 README 覆盖的范围）

- [x] `docker compose config`（默认与 `--profile full`）语法通过
- [x] `docker compose up -d postgres redis` 只起两个依赖；重复执行幂等，5433:5432 / 6379 映射不变
- [x] `collab-api:local` / `collab-web:local` 两个镜像真实构建成功
- [x] `migrate` 一次性容器真实执行 `prisma migrate deploy`（连的是 compose 内的 postgres，二次执行幂等："No pending migrations to apply"）
- [x] `api` 容器真实起服：`/health`、`/ready` 均 200（`ready` 里 postgres/redis 都 ok），镜像 `HEALTHCHECK` 判为 healthy
- [x] `web` 容器真实起服：首页 200，且 `/api/*` 反向代理真的打到了 api 容器（返回 api 的 401/业务 JSON）
- [x] 端到端：浏览器侧路径（web 3000 → `/api/*` → api → Prisma → PostgreSQL）跑通注册 → 登录 → 建房（201，返回 roomId/boardId/inviteCode）
- [x] k6 脚本在真实栈上跑通：WS 握手 + 进房 100% 通过，`shape_ack_latency p(95)=58ms`（阈值 300ms 内）
- [x] 镜像非 root 运行（`uid=1000(node)`）；api 运行时不含 devDependencies；web 运行时为 standalone（约 41MB）
- [ ] 清空数据卷后从零复跑（本机验证时 DB 卷已存在，未做 `down -v` 的破坏性验证）

### 6.2 功能验收（计划书 §10 Definition of Done，由应用实现方验证）

- [ ] `docker compose up` 后无需手工步骤即可访问前端
- [ ] 4 个客户端同房间协作，图形一致、光标可见、在线列表正确
- [ ] 断网 30s 后自动恢复且不丢操作、不产生重复图形
- [ ] 重复提交同一 `clientOpId` 不产生副作用
- [ ] 冷启动可从快照 + op log 完整重建画布
- [ ] 非成员无法加入房间、无法向房间写入
- [ ] 单测 + e2e 全绿，附带一份压测报告

---

## 7. 验证记录与本机排障

### 7.1 已执行的验证（真实输出摘要）

```
$ docker compose config --quiet && echo OK                     # 默认
OK
$ docker compose --profile full config --quiet && echo OK       # 全栈
OK
$ docker compose config --services            → postgres redis
$ docker compose --profile full config --services
  → redis postgres migrate api web

$ docker compose up -d postgres redis         # 再执行一次仍然：
 Container collab-postgres Running
 Container collab-redis Running

$ docker compose --profile full build api / web
 → Image collab-api:local Built / Image collab-web:local Built

$ docker compose --profile full run --rm migrate
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "collab", schema "public" at "postgres:5432"
1 migration found in prisma/migrations
No pending migrations to apply.                                  # 二次执行幂等

$ curl api 容器: /health  → 200 {"status":"ok","uptime":...}
$ curl api 容器: /ready   → 200 {"status":"ok","checks":{"postgres":"ok","redis":"ok"}}
$ docker inspect ...health → running health=healthy

$ curl web 容器: GET /            → 200（13ms）
$ curl web 容器: GET /api/auth/me → 401 {"code":"UNAUTHENTICATED",...}   # 代理命中 api 容器
$ 经 web 代理 注册→登录→建房      → 201，返回 roomId/boardId/inviteCode

$ k6 run（VUS=2, DURATION=12s，走 grafana/k6 容器打 api 容器）
✓ ws upgrade 101 / ✓ socket.io connected / ✓ room join ok   （checks 100%）
room_join_latency.....: avg=8ms   p(95)=8.9ms
shape_ack_latency.....: avg=31.9ms p(95)=58.3ms   ← 阈值 p(95)<300ms 通过
ws_session_ok.........: 100.00% (2/2)
cursor_sent/updated...: 168 / 168
shape_acks/broadcasts.: 22 / 22
```

### 7.2 未验证/受限项

- **清空卷冷启动**：验证时 `postgres-data` 卷里已有数据（表已由迁移建好），未做 `docker compose down -v` 后的完整复跑。
- **`docker compose --profile full up -d` 全栈一次起**：验证时宿主 3001 端口被本地 `pnpm dev` 占用，因此 api 容器实例是通过
  `docker compose --profile full run -d --use-aliases -p 3101:3001 api` 起的（同一镜像、同一环境变量、同一网络别名）；
  web 容器同理走 `--no-deps -p 3000:3000`。跑全栈前请先停掉本机 dev 进程（见 7.4）。
- **压测规模结论**：只做了 2 VU 的功能性验证（连通性 + 阈值口径），200/500/1000 连接的容量结论待 M9 压测报告。

### 7.3 镜像体积与 pnpm peer 行为（重要）

`pnpm deploy --prod` 之后的 api 运行时目录约 313MB，其中：

- `@prisma/client`（含生成的 client 与 query engine）；
- **`prisma` / `@prisma/engines` / `effect` / `typescript`（约 +130MB）**：`@prisma/client` 把
  `prisma`、`typescript` 声明为**可选 peer**，而本仓库 `.npmrc` 里 `auto-install-peers=true`，
  pnpm 会把它们一并装进生产依赖。它们不是 devDependencies，但确实不是运行期必需
  （migrate 用的是镜像里单独装的 `/opt/prisma-cli`）。若要更瘦，需要改 `.npmrc` 的
  `auto-install-peers`（会影响全仓库，故本次未动）。
- web 运行时为 Next.js standalone：`/app` 约 41MB + node 基础镜像。

### 7.4 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `cannot connect to the Docker API` | Docker Desktop 没起；先启动再执行任何 compose 命令 |
| `ports are not available: ... 0.0.0.0:3001` | 本机 `pnpm dev`（api 3001 / web 3000）与容器同时跑会抢端口：跑全栈前先停 dev，或临时改 compose 的 `ports` 左侧 |
| 5433 / 6379 被占用 | 这两个宿主端口是为避让本机已有服务刻意选的（容器内仍是 5432/6379） |
| 镜像构建下载依赖超时 | 用 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`；compose 下设置同名环境变量即可：`NPM_REGISTRY=https://registry.npmmirror.com pnpm docker:build` |
| `EACCES` / 权限报错 | 容器以 `node`（uid 1000）运行；挂载卷时注意宿主目录属主 |
| 改了 `apps/api/prisma/schema.prisma` 后容器里没生效 | 重建并重跑迁移：`docker compose --profile full up -d --build`（migrate 会重新执行） |
| 想在容器里看 api 日志 | `docker compose --profile full logs -f api` |

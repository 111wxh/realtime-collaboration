# 实时协作项目 · 教学过程

> **⛔ 已归档（2026-10-10）**：项目已重新定位为**产品**，不再按教学节奏推进。
> 治理文档改为 `docs/PLAN_v1.1.md`（工程计划书）；本文件仅作历史记录保留，
> 其中"我给你写/你动手"的分工约定已作废，课程表可作为功能范围参考。

> 配套文档：`docs/PLAN_v1.1.md`（工程计划书）
> 本文件回答的是另一个问题：**这套系统怎么一步步被做出来、每一步要学到什么。**
> 版本：v1.0 · 状态：M0 进行中

---

## 0. 教学方式

### 0.1 每节课固定五段式

| 段 | 内容 | 产出 |
| --- | --- | --- |
| 1. 讲问题 | 这一步解决什么问题，不做会怎样 | 你用自己的话复述一遍 |
| 2. 最小实现 | 只做能跑通的部分，不上难度 | 代码 |
| 3. 你动手 | 核心逻辑你写，样板代码我给 | 你的代码 |
| 4. 验证 | 有"亲眼看到绿了"的标准 | 截图 / 命令输出 |
| 5. 复盘 | 记录进 §7 学习日志 | 三句话总结 |

### 0.2 三条铁律（承接计划书 §9.0）

1. **每一步都必须可运行**——不留"以后再接上"的半成品。
2. **每一步都必须可验证**——验收标准是命令输出或界面现象，不是"应该没问题"。
3. **不提前上难度**——Redis / 多实例 / CRDT 都在后面的阶段，提前引入会把一致性问题复杂化。

### 0.3 分工约定

- **我给**：目录骨架、配置样板、依赖清单、类型定义、命令。
- **你写**：渲染层、seq 分配事务、幂等与补齐逻辑、冲突裁决、前端同步层。这些是简历上要讲的东西。
- **卡住时**：先自己跑一次，把报错原文贴出来再问。

### 0.4 每节课结束必须回答的三个问题

1. 它解决什么问题？
2. 它的失效模式是什么（什么情况下会坏）？
3. 下一个阶段依赖它的哪个契约？

---

## 1. 教学路线总览

| 阶段 | 课时 | 核心概念 | 交付物 | 验收（必须亲眼看到） |
| --- | --- | --- | --- | --- |
| **M0** 骨架与基础设施 | 6 | monorepo、跨端共享类型、健康检查 | workspace + web/api + shared + pg/redis | `/health`、`/ready` 返回 200 |
| **M1** 认证与房间 | 6 | 密码哈希、JWT/refresh、资源授权 | REST 接口 + 登录页 + 房间列表 | 两个账号互相加入同一房间 |
| **M2** 实时网关与在线状态 | 6 | WS 握手鉴权、房间订阅、presence | RealtimeGateway + 在线列表 | 关掉一个标签页，另一端 3s 内看到离开 |
| **M3** 画布与图形 | 6 | Canvas 渲染、命中测试、状态机 | 工具栏 + 图形 CRUD + 持久化 | 刷新页面图形不丢 |
| **M4** 实时同步与一致性 | 8 | 事务内 seq、op log、幂等、乐观更新、补齐 | 双端实时同步 | 断网 30s 恢复后两端一致；重复提交无副作用 |
| **M5** 光标与协同体验 | 5 | 节流、插值、撤销栈、多选 | 光标层 + 选区 + undo/redo | 4 人同房间操作光标流畅 |
| **M6** 加固与部署 | 6 | 校验、限流、日志指标、四层测试、镜像 | Dockerfile + compose 全栈 | `docker compose up` 一键起，跑完一次 4 人协作 |
| **M7–M9** 第二版（CRDT） | — | 见计划书 §7.6 | 见计划书 | 见计划书 |

**依赖关系**：M0 → M1 → M2 → M3 → M4 → M5 → M6。M4 是本项目的"心脏"，M3 只是它的素材来源。

---

## 2. 阶段 M0：骨架与基础设施（2 人日）

> 目标：让"跨端 + 依赖服务"这条地基可运行、可验证。M0 结束时你还没有任何业务功能，但已经拥有后面所有阶段都要踩的地板。

### M0-1 工具链体检与仓库初始化
- **讲**：为什么用 pnpm workspace（依赖提升可控、跨包引用用 `workspace:*` 而不是发布）；为什么前后端共享类型能省掉一半协议 bug。
- **做**：`git init`、`.gitignore`、`.editorconfig`、根 `package.json`（private + scripts + packageManager）、`pnpm-workspace.yaml`。
- **你写**：根 `package.json` 的 scripts 命名（`dev` / `build` / `lint` / `typecheck` / `test`）。
- **验收**：`pnpm -v`、`pnpm install` 无报错；`git status` 里没有 `node_modules`。
- **坑**：Windows 下 `corepack` 的权限问题；`.gitignore` 忘了 `.env`，密钥进仓库。

### M0-2 `packages/shared`：先定契约再写实现
- **讲**：为什么第一件事是定义事件常量与 Zod schema（协议即类型）；"先定接口后写实现"能避免返工。
- **做**：`packages/shared` 的 `package.json`（exports 指向 `src`）、`tsconfig.json`、`src/index.ts`。
- **你写**：`src/events.ts`（事件名常量，覆盖计划书 §6.3 / §6.4 两张表）、`src/envelope.ts`（`Envelope<T, P>` 类型 + Zod schema）、`src/errors.ts`（错误码）。
- **验收**：`pnpm --filter shared typecheck` 通过；web/api 都能 `import { EVENTS } from '@collab/shared'`。
- **坑**：包名、exports 字段、`moduleResolution: bundler` 三者不一致，会报"找不到模块"。

### M0-3 `apps/api`：NestJS 骨架 + 健康检查
- **讲**：NestJS 的模块 / 服务 / 控制器 / 守卫四件套各自负责什么；为什么健康检查要分成 `/health`（进程活着）与 `/ready`（依赖可用）。
- **做**：`nest new` 生成后清理默认结构，按计划书 §8 建 `modules/ common/ realtime/ prisma/`。
- **你写**：`AppModule`、`HealthController`（`/health` 直接返回）、`HealthModule`。
- **验收**：`pnpm --filter api dev` 后 `curl http://localhost:3001/health` 返回 200。
- **坑**：`main.ts` 端口与 CORS；全局前缀 `/api` 会让 `/health` 变成 `/api/health`（要么统一加，要么明确豁免）。

### M0-4 `docker-compose.yml`：先起依赖，不容器化应用
- **讲**：开发环境"本地 dev + Docker 依赖"的理由（HMR、断点、日志）；为什么生产才整栈 compose。
- **做**：`docker-compose.yml` 只放 `postgres:17-alpine`（挂卷 + healthcheck）与 `redis:7-alpine`（开 AOF + healthcheck）；`.env.example` + `.env`（不入库）。
- **你写**：两个服务的 `healthcheck` 与 `ports` 绑定策略。
- **验收**：`docker compose up -d postgres redis` → `docker compose ps` 两个都是 `healthy`。
- **坑**：5432/6379 与宿主机已有服务冲突；Windows 下挂载卷路径大小写。

### M0-5 Prisma 接入与首个迁移
- **讲**：为什么 ORM 用 Prisma（类型安全、迁移体验）；`migrate dev` 与 `migrate deploy` 的区别（计划书 §3.2）。
- **做**：`prisma init`、`PrismaService`（`OnModuleInit` 里 `$connect`）、`.env` 的 `DATABASE_URL`。
- **你写**：把计划书 §5.2 的 DDL 翻译成 `schema.prisma`（**先只写 `users`/`rooms`/`room_members`/`boards` 四张**，图形相关的留到 M3/M4）。
- **验收**：`pnpm prisma migrate dev --name init` 后，`prisma studio` 能看到表；`/ready` 检查 DB 返回 200。
- **坑**：`gen_random_uuid()` 需要 `@default(uuid())`；`citext` 扩展在 Prisma 里要用 `@db.Citext` + 迁移里 `CREATE EXTENSION`。

### M0-6 `apps/web`：Next.js 骨架并连上 API
- **讲**：App Router 的 `app/` 路由即目录；为什么前端也要有一套"服务层"（后面 socket 管理层的地基）。
- **做**：`create-next-app`（TS + App Router + Tailwind）、`lib/api.ts` 薄封装、`.env.local` 的 `NEXT_PUBLIC_API_URL`。
- **你写**：一个临时首页，客户端 fetch `/health` 并把结果渲染出来。
- **验收**：浏览器打开 `localhost:3000`，页面显示 api 健康状态；api 停掉后刷新显示失败态。
- **坑**：把 `NEXT_PUBLIC_` 当密钥用；SSR 阶段 fetch 相对路径导致失败。

### ✅ M0 阶段验收（Definition of Done）
- [ ] `pnpm install && pnpm dev` 双端同起
- [ ] `docker compose up -d postgres redis` 依赖 healthy
- [ ] `/health` 与 `/ready` 返回 200，且 `/ready` 真的探测了 DB + Redis
- [ ] 前端页面能显示后端健康状态
- [ ] `pnpm lint && pnpm typecheck` 通过

---

## 3. 阶段 M1：认证与房间（4 人日）

> 目标：有"人"和"空间"。M2 开始的每个 WS 事件都要靠这一层的 `userId` 与 `room_members` 做授权。

| 课时 | 讲什么 | 你写什么 | 验收 |
| --- | --- | --- | --- |
| M1-1 用户模型与 refresh_tokens 迁移 | 为什么 ID 用 UUID；为什么 refresh token 存 hash 而不是明文 | `schema.prisma` 增量 + 迁移 | 表结构符合 §5.2 |
| M1-2 注册与密码哈希 | 为什么用 argon2/bcrypt、为什么不能自己写哈希 | `AuthService.register` + DTO 校验 | 重复邮箱返回 409 |
| M1-3 登录与双令牌 | access 短时 + refresh 可撤销的取舍 | `AuthService.login` / `refresh` / `logout` | 拿到 access/refresh；refresh 可撤销 |
| M1-4 守卫与 `/me` | `JwtAuthGuard`、`@CurrentUser()` 装饰器、全局守卫顺序 | 守卫 + 装饰器 | 无 token 访问 `/me` 返回 401 |
| M1-5 房间 CRUD 与成员 | `invite_code` 生成、`room_members` 的 `role`、加入的幂等性 | `RoomService` + `RoomController` | 创建房间返回邀请码；加入两次不重复建成员 |
| M1-6 前端登录页与房间列表 | 令牌存哪里（内存 + refresh cookie 的取舍）、路由保护 | 登录页、房间列表、`apiFetch` 自动带 token | 两账号可互相加入同一房间 |

### ✅ M1 阶段验收
- [ ] 两个账号登录后互相加入同一房间
- [ ] 非成员访问房间资源返回 403
- [ ] access 过期后 refresh 能续期，无需重新登录

---

## 4. 阶段 M2：实时网关与在线状态（4 人日）

> 目标：把 HTTP 的单向请求升级为双向通道，并在不碰业务一致性的前提下管好"谁在线"。

| 课时 | 讲什么 | 你写什么 | 验收 |
| --- | --- | --- | --- |
| M2-1 网关骨架与握手鉴权 | Socket.IO 生命周期、`handleConnection`、握手时校验 `auth.token` | `RealtimeGateway` + `WsAuthGuard` | 无 token 连接被拒绝 |
| M2-2 加入/离开房间 | `socket.join` 的语义、ack 回调、成员校验不能信客户端 | `room:join` / `room:leave` 处理器 | join 后收到 `room:joined` 回执 |
| M2-3 Presence | 为什么 presence 放 Redis（不落库、多实例共享） | `PresenceService`（Redis Hash + TTL） | 同一房间两人在线，列表显示 2 |
| M2-4 心跳与断线检测 | Socket.IO 自带心跳 / `pingTimeout` 与应用层 `ping` 的分工 | 断线时清理 presence 的逻辑 | 关标签页后成员列表 3s 内更新 |
| M2-5 前端 socket 层 | 单例连接管理、事件订阅、重连后自动 re-join | `lib/socket/index.ts` | 断网重连后自动回到房间 |
| M2-6 Redis Adapter（可选提前） | 多实例广播原理、回音抑制 | adapter 接入 | 起两个 api 实例，跨实例仍能收到消息 |

### ✅ M2 阶段验收
- [ ] 关闭一个标签页，另一端 3s 内看到成员离开
- [ ] 非成员 `room:join` 被拒绝且不产生副作用
- [ ] 前端重连后自动恢复房间订阅

---

## 5. 阶段 M3：画布与图形（5 人日）

> 目标：单人可用。渲染层与业务解耦，为 M4 的乐观更新预留 mark 机制。

| 课时 | 讲什么 | 你写什么 | 验收 |
| --- | --- | --- | --- |
| M3-1 渲染层 | Canvas 尺寸与 DPR、`requestAnimationFrame` 循环、脏矩形/全量重绘取舍 | `lib/board/renderer.ts` | 空白画布 + 网格，缩放窗口不变形 |
| M3-2 图元模型与绘制 | 六种图元（rect/ellipse/line/arrow/freedraw/text）的绘制函数与样式 | `lib/board/shapes.ts` | 硬编码一组图形能正确渲染 |
| M3-3 命中测试与选中 | 包围盒 vs 精确命中的取舍、选中框与控制点 | `lib/board/hitTest.ts` | 点中图形出现选中框 |
| M3-4 工具状态机 | `idle / drawing / dragging / resizing` 状态转移 | `lib/board/interaction.ts` | 切换工具后交互行为正确 |
| M3-5 图形 CRUD 与 store | Zustand + Immer 的写法、为什么图形 ID 由客户端生成 | `stores/board.ts` + 移动/缩放/删除 | 本地增删改流畅 |
| M3-6 服务端持久化与首次加载 | `shapes` 表读写、`board:state` 全量下发 | `BoardService` + 首次加载逻辑 | **刷新页面图形不丢** |

---

## 6. 阶段 M4：实时同步与一致性（6 人日 · 项目心脏）

> 目标：把"一个人画"变成"多个人画同一个东西"，且在网络乱序、重试、断线的情况下仍然收敛。这一阶段的每一节课都建议配一个失败实验（故意断网、故意重复提交），观察系统的反应。

| 课时 | 讲什么 | 你写什么 | 验收 |
| --- | --- | --- | --- |
| M4-1 协议落地 | 信封如何进网关做统一校验、`reqId` 如何关联 ack | 网关的消息校验管道（Zod） | 非法消息被拒且不崩溃 |
| M4-2 事务内 seq 分配 | **为什么不能用 Redis INCR**（事务失败产生永久空洞）、行锁与 `last_seq + 1` | `SELECT ... FOR UPDATE` 分配 seq | 并发写同一 board，seq 无空洞无重复 |
| M4-3 op log + 投影 | append-only 语义、`shapes` 是投影、软删除为什么必要 | 同事务写 `shape_ops` 与 `shapes` | 手动回滚事务，op 与 state 都不落库 |
| M4-4 广播与 ack | 只有提交成功才广播；`shape:ack` 携带权威结果 | 广播 + ack/rejected 下发 | 发送方能拿到 seq |
| M4-5 幂等 | `clientOpId` 唯一约束、重复提交返回原 seq 而不是报错 | 幂等分支 | 同一 `clientOpId` 发两次，第二次无副作用 |
| M4-6 乐观更新与 pending 队列 | 先画后确认、pending 标记、队列上限背压（§7.4） | 客户端 op 队列 | 断网期间操作进入队列，恢复后按序补发 |
| M4-7 检漏与断线补齐 | `seq > expected` 触发 `board:sync`、snapshot + op log 重放、陈旧快照丢弃 | 补齐逻辑 | **断网 30s 恢复后两端状态一致** |
| M4-8 冲突裁决 | `baseVersion` 乐观并发控制（§7.5）、拒绝后基于 `serverShape` 重放 | 版本校验 + 客户端重放 | 两端同时移动同一图形，最终收敛且不闪回 |

### ✅ M4 阶段验收（最硬的一关）
- [ ] 乱序 / 重复 / 延迟三种干扰下，两端最终一致
- [ ] 同一 `clientOpId` 重复提交无副作用
- [ ] 断网 30s 自动补齐，无需刷新页面
- [ ] 冷启动能从快照 + op log 重建画布

---

## 7. 阶段 M5–M6：体验与交付

### M5 光标与协同体验（3 人日）
| 课时 | 重点 | 验收 |
| --- | --- | --- |
| M5-1 光标节流广播 | 30–50ms 合并、服务端不保证顺序、覆盖式更新 | 拖拽时光标不抖动 |
| M5-2 光标渲染与插值 | 独立图层、避免重绘整个画布 | 光标流畅 |
| M5-3 选区高亮 | 他人选区用半透明色块 + 显示名 | 能看到协作者选中范围 |
| M5-4 撤销/重做 | 本地栈 vs 全局栈的取舍；只撤销自己的操作 | Ctrl+Z 只回退自己的操作 |
| M5-5 层级与多选 | `z_index` 调整、框选、批量 `shape:batch` | 多选移动只发一次批量 op |

### M6 加固与部署（4 人日）
| 课时 | 重点 | 验收 |
| --- | --- | --- |
| M6-1 输入校验与上界 | 共享 Zod schema 在网关统一 parse；防 NaN/Infinity | 恶意坐标被拒 |
| M6-2 限流 | 令牌桶（写 60/s、光标 30/s），Redis 计数支持多实例 | 压测下不雪崩 |
| M6-3 日志与指标 | pino 结构化日志带 traceId；连接数/延迟 P95/重连次数 | 日志能串起一条完整链路 |
| M6-4 四层测试 | Vitest 单测（seq、apply/revert）、Supertest 集成、Playwright 多 Context e2e、对账脚本 | 单测 + e2e 全绿 |
| M6-5 镜像与 compose | 非 root 运行、migrate 一次性容器、健康检查依赖顺序 | `docker compose up` 全栈可跑 |
| M6-6 压测与验收 | k6 WS 脚本、200/500/1000 连接 | 输出一份压测报告 |

---

## 8. 学习日志

> 每节课后填一行。这是本项目最有价值的附加产出——面试时讲的就是这些坑。

| 日期 | 课时 | 今天解决的问题 | 踩到的坑 | 失效模式（什么情况会坏） |
| --- | --- | --- | --- | --- |
| | | | | |

---

## 9. 自测题库（按阶段）

- **M0**：为什么协议类型要放在 shared 包里，而不是前后端各写一份？
- **M0**：`/health` 与 `/ready` 的区别是什么？K8s 分别用哪个？
- **M1**：refresh token 为什么要存 hash？被拖库时有什么差别？
- **M2**：为什么 presence 放 Redis 而不落 PostgreSQL？
- **M3**：为什么图形 ID 由客户端生成？（提示：重试与幂等）
- **M4**：为什么 seq 必须在数据库事务里分配，而不是 Redis `INCR`？
- **M4**：客户端发现 `seq` 不连续时应该做什么，为什么不是丢弃后续消息？
- **M4**：`baseVersion` 冲突后，为什么不是简单地"服务端覆盖客户端"？
- **M5**：光标消息为什么要节流，服务端为什么可以不管顺序？
- **M6**：多实例部署时，哪些状态必须放 Redis，哪些必须放 PostgreSQL？

---

## 10. 当前进度

> 2026-10-10 起项目重定位为产品，进度以实际交付为准（不再逐节记录教学进度）。

| 阶段 | 状态 | 备注 |
| --- | --- | --- |
| M0 | 基本完成 | monorepo + 双端骨架 + shared 协议契约（含单测）+ compose（pg/redis）；子智能体并行实现 API/Web/基础设施 |
| M1–M6 | 进行中 | 由子智能体并行实现，主智能体集成验收 |

*文档结束。产品线治理文档见 `docs/PLAN_v1.1.md`。*

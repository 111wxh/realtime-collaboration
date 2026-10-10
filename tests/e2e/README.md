# e2e 测试约定（web 前端实现时请遵守）

`tests/e2e/collaboration.spec.ts` 用多 BrowserContext 模拟多个真人协作。为保证测试稳定，
前端请提供以下 **data-testid**（有中文文案的按钮/输入框仍照常做，testid 只是给 e2e 用的抓手）：

| testid | 位置 | 说明 |
| --- | --- | --- |
| `board-canvas` | 白板页 canvas 元素 | 就是那一个 `<canvas>`（光标层是独立元素，别把 testid 放它上面） |
| `presence-count` | 在线头像栈 | 文本内容 = 当前在线人数（如 `2`） |
| `shape-count` | 工具栏或状态栏 | 文本内容 = 当前画布上的图形数量（可见图形即可） |
| `tool-rect` | 工具栏 | 矩形工具按钮 |
| `create-room-button` | 房间列表页 | 打开"创建房间"表单的按钮 |
| `room-name-input` | 创建房间表单 | 房间名输入框 |
| `create-room-submit` | 创建房间表单 | 提交按钮 |
| `invite-code` | 房间卡片/详情 | 邀请码节点，文本里包含 6–12 位大写字母数字（可带"邀请码："前缀） |
| `invite-code-input` | 房间列表页 | 加入房间的邀请码输入框 |
| `join-room-submit` | 房间列表页 | 加入按钮 |

另外约定：白板页刷新后**必须能自动恢复会话**（access 走内存 + refresh cookie），e2e 依赖这一点。

运行方式：

```bash
pnpm exec playwright install chromium   # 一次性
pnpm exec playwright test               # web(3000) 与 api(3001) 需已运行
```

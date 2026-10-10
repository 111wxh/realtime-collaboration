import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 多人协作 e2e（多 BrowserContext = 多个"真人"）。
 *
 * 前置：postgres/redis 已起、api(3001) 与 web(3000) 已运行。
 * 选择器策略：优先 data-testid（前端实现时按 tests/e2e/README.md 的约定补齐）；
 * 缺 testid 时回退到中文文案匹配。web 端实现完成后若个别选择器不匹配，
 * 以 web 端实际 DOM 为准调整本文件。
 */

const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}@example.com`;
const PASSWORD = 'passw0rd!';

/** 注册 + 登录（全走 UI，保证测的是真实链路） */
async function registerAndLogin(page: Page, email: string, name: string) {
  await page.goto('/login');
  const registerTab = page.getByRole('button', { name: /注册/ });
  if (await registerTab.count()) await registerTab.first().click();

  await page.getByLabel(/邮箱|email/i).first().fill(email);
  await page.getByLabel(/密码|password/i).first().fill(PASSWORD);

  const nameField = page.getByLabel(/昵称|显示名|名字|name/i).first();
  if (await nameField.count()) await nameField.fill(name);

  await page.getByRole('button', { name: /注册|登录/ }).last().click();
  await expect(page).toHaveURL(/\/rooms/, { timeout: 20_000 });
}

async function createRoom(page: Page, roomName: string): Promise<string> {
  await page.getByTestId('create-room-button').or(page.getByRole('button', { name: /创建房间/ }))
    .first()
    .click();

  const nameInput = page
    .getByTestId('room-name-input')
    .or(page.getByLabel(/房间名|名称/))
    .first();
  if (await nameInput.count()) await nameInput.fill(roomName);

  await page.getByTestId('create-room-submit').or(page.getByRole('button', { name: /^创建|确定/ }))
    .first()
    .click();

  const codeNode = page
    .getByTestId('invite-code')
    .or(page.getByText(/[A-Z0-9]{6,12}/))
    .first();
  await expect(codeNode).toBeVisible({ timeout: 20_000 });
  const text = (await codeNode.textContent()) ?? '';
  const match = text.match(/[A-Z0-9]{6,12}/);
  if (!match) throw new Error(`未能从 "${text}" 中解析邀请码`);
  return match[0];
}

async function joinRoomByCode(page: Page, code: string) {
  const input = page
    .getByTestId('invite-code-input')
    .or(page.getByPlaceholder(/邀请码/))
    .first();
  await input.fill(code);
  await page
    .getByTestId('join-room-submit')
    .or(page.getByRole('button', { name: /加入/ }))
    .first()
    .click();
}

async function openRoomPage(page: Page, roomRowRegex: RegExp) {
  await page.getByRole('link', { name: roomRowRegex }).or(page.getByText(roomRowRegex)).first().click();
  await expect(page.getByTestId('board-canvas').or(page.locator('canvas')).first()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('实时协作白板', () => {
  test('两个用户加入同一房间并互见在线状态', async ({ browser }) => {
    const ctxA: BrowserContext = await browser.newContext();
    const ctxB: BrowserContext = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const roomName = `房间-${Date.now().toString(36)}`;

    await registerAndLogin(pageA, uniqueEmail('a'), '用户A');
    const code = await createRoom(pageA, roomName);
    await openRoomPage(pageA, new RegExp(roomName));

    await registerAndLogin(pageB, uniqueEmail('b'), '用户B');
    await joinRoomByCode(pageB, code);
    await openRoomPage(pageB, new RegExp(roomName));

    // 两端都应在在线列表里看到 2 个成员（presence 收敛）
    await expect(pageA.getByTestId('presence-count')).toHaveText('2', { timeout: 15_000 });
    await expect(pageB.getByTestId('presence-count')).toHaveText('2', { timeout: 15_000 });

    await ctxA.close();
    await ctxB.close();
  });

  test('A 画矩形后 B 能看到（且刷新不丢）', async ({ browser }) => {
    const ctxA: BrowserContext = await browser.newContext();
    const ctxB: BrowserContext = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const roomName = `房间-${Date.now().toString(36)}`;

    await registerAndLogin(pageA, uniqueEmail('a'), '用户A');
    const code = await createRoom(pageA, roomName);
    await openRoomPage(pageA, new RegExp(roomName));

    await registerAndLogin(pageB, uniqueEmail('b'), '用户B');
    await joinRoomByCode(pageB, code);
    await openRoomPage(pageB, new RegExp(roomName));

    // A 选矩形工具并拖拽出一个矩形
    const rectTool = pageA
      .getByTestId('tool-rect')
      .or(pageA.getByRole('button', { name: /矩形/ }))
      .first();
    await rectTool.click();

    const canvasA = pageA.getByTestId('board-canvas').or(pageA.locator('canvas')).first();
    const box = await canvasA.boundingBox();
    if (!box) throw new Error('canvas 不可见');
    await pageA.mouse.move(box.x + 200, box.y + 200);
    await pageA.mouse.down();
    await pageA.mouse.move(box.x + 360, box.y + 320, { steps: 12 });
    await pageA.mouse.up();

    // B 端应在几秒内收到并渲染（用图形计数断言，避免像素级比较）
    await expect(pageB.getByTestId('shape-count')).toHaveText('1', { timeout: 15_000 });

    // 刷新 B 的页面：图形必须还在（持久化 + 首次加载）
    await pageB.reload();
    await expect(pageB.getByTestId('shape-count')).toHaveText('1', { timeout: 20_000 });

    await ctxA.close();
    await ctxB.close();
  });
});

// Run after npm ci in apps/web. Requires Playwright with Chromium installed and backend dependencies.
// CIC_E2E_PYTHON selects the Python interpreter; CIC_PLAYWRIGHT_MODULE can select a local Playwright installation.
const { chromium } = require(process.env.CIC_PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'cic-canvas-check-'));
const apiUrl = 'http://127.0.0.1:8870';
const webUrl = 'http://127.0.0.1:5178';
const processes = [];
const logs = [];
let browser;

function launch(command, args, cwd, extraEnv) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  child.on('error', (error) => logs.push(String(error)));
  processes.push(child);
}

async function until(check, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch { /* 服务初始化 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`超时：${description}`);
}

async function api(route, method = 'GET', body) {
  const response = await fetch(`${apiUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function viewport(page) {
  return page.locator('.react-flow__viewport').evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}

async function run() {
  launch(process.env.CIC_E2E_PYTHON || 'python', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8870'], path.join(root, 'apps/api'), { CIC_DATA_DIR: path.join(temporary, 'data'), CIC_WEB_ORIGIN: webUrl });
  launch(process.execPath, [path.join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5178', '--strictPort'], path.join(root, 'apps/web'), { VITE_API_BASE: apiUrl });
  await until(() => api('/api/health'), '后端启动');
  await until(async () => (await fetch(webUrl)).ok, '前端启动');
  const project = await api('/api/projects', 'POST', { name: '交互回归项目：人工智能数据中心（AIDC），会给储能企业带来哪些大机会？', idea: '研究供电方案', brief: '原始简报' });
  let canvas = await api(`/api/projects/${project.id}/canvas`);
  const group = canvas.nodes.find((node) => node.type === 'frame' && node.metadata.group_key === 'input');
  const brief = canvas.nodes.find((node) => node.type === 'brief');
  canvas.nodes = canvas.nodes.filter((node) => node.id === group.id || node.type === 'idea' || node.id === brief.id);
  canvas.nodes = canvas.nodes.map((node) => node.id === group.id ? { ...node, locked: true } : node);
  canvas.edges = [];
  await api(`/api/projects/${project.id}/canvas`, 'PUT', { ...canvas, base_updated_at: canvas.updated_at });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(webUrl);
  await page.getByRole('button', { name: /交互回归项目/ }).click();
  const groupNode = page.locator(`.react-flow__node[data-id="${group.id}"]`);
  await groupNode.waitFor();
  await until(async () => (await groupNode.boundingBox())?.width > 100, '白板适应视口');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.brand strong').textContent(), '内容智能工作台');
  const toolbox = page.locator('.canvas-toolbox');
  const boardBounds = await page.locator('.board-wrap').boundingBox();
  const headerBounds = await page.locator('.canvas-page .page-header').boundingBox();
  assert.ok(headerBounds.y + headerBounds.height < boardBounds.y, '工具栏不再挤占标题区');
  for (const [dock, x, y, layout] of [
    ['left', boardBounds.x + 5, boardBounds.y + boardBounds.height / 2, 'vertical'],
    ['bottom', boardBounds.x + boardBounds.width / 2, boardBounds.y + boardBounds.height - 5, 'horizontal'],
    ['right', boardBounds.x + boardBounds.width - 5, boardBounds.y + boardBounds.height / 2, 'vertical'],
    ['top', boardBounds.x + boardBounds.width / 2, boardBounds.y + 5, 'horizontal'],
  ]) {
    const grip = await page.getByRole('button', { name: '拖动工具栏' }).boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down(); await page.mouse.move(x, y, { steps: 8 }); await page.mouse.up();
    assert.equal(await toolbox.getAttribute('data-dock'), dock);
    assert.equal(await toolbox.getAttribute('data-layout'), layout);
    const box = await toolbox.boundingBox();
    assert.ok(box.x >= boardBounds.x && box.y >= boardBounds.y && box.x + box.width <= boardBounds.x + boardBounds.width + 1 && box.y + box.height <= boardBounds.y + boardBounds.height + 1, '停靠工具栏应完整留在画布内');
  }
  await page.getByRole('button', { name: '工具栏设置' }).click();
  await page.getByRole('button', { name: '纵向', exact: true }).click();
  assert.equal(await toolbox.getAttribute('data-layout'), 'vertical');
  await page.getByRole('button', { name: '工具栏设置' }).click();
  await page.screenshot({ path: path.join(temporary, 'toolbar-vertical.png') });
  await page.getByRole('button', { name: '工具栏设置' }).click();
  await page.getByRole('button', { name: '横向', exact: true }).click();
  await page.getByRole('button', { name: '工具栏设置' }).click();
  await page.getByRole('button', { name: '折叠任务监测' }).click();
  assert.equal(await page.getByRole('button', { name: '暂停选中' }).count(), 0);
  assert.ok((await page.locator('.canvas-task-monitor').innerText()).includes('正在生成'));
  await page.getByRole('button', { name: '展开任务监测' }).click();
  let bounds = await groupNode.boundingBox();
  await page.mouse.click(bounds.x + 25, bounds.y + 25);
  assert.equal(await groupNode.evaluate((element) => getComputedStyle(element).zIndex), '-10');
  assert.equal(await groupNode.locator('.react-flow__resize-control').count(), 0);

  await page.evaluate(() => { window.__canvasContextPrevented = false; document.addEventListener('contextmenu', (event) => { window.__canvasContextPrevented = event.defaultPrevented; }); });
  async function rightPan() {
    bounds = await groupNode.boundingBox();
    const before = await viewport(page);
    await page.mouse.move(bounds.x + 45, bounds.y + bounds.height - 45);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(bounds.x + 155, bounds.y + bounds.height + 15, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    const after = await viewport(page);
    assert.ok(Math.abs(after.x - before.x - 110) < 1, '分组内右拖应水平移动画布');
    assert.ok(Math.abs(after.y - before.y - 60) < 1, '分组内右拖应垂直移动画布');
    assert.equal(await page.evaluate(() => window.__canvasContextPrevented), true);
  }
  await rightPan();
  await page.getByLabel('锁定节点').uncheck();
  await rightPan();

  const expandedWidth = (await page.locator('.workspace').boundingBox()).width;
  await page.getByRole('button', { name: '折叠侧边栏' }).click();
  assert.ok((await page.locator('.workspace').boundingBox()).width > expandedWidth + 150);
  const board = await page.locator('.react-flow').boundingBox();
  const pointer = { x: board.x + board.width * .6, y: board.y + board.height * .55 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);
  const transform = await viewport(page);
  const expected = { x: Math.round(((pointer.x - board.x - transform.x) / transform.zoom) / 10) * 10, y: Math.round(((pointer.y - board.y - transform.y) / transform.zoom) / 10) * 10 };
  await page.keyboard.press('n');
  const created = await until(async () => (await api(`/api/projects/${project.id}/canvas`)).nodes.find((node) => node.type === 'note'), 'N 新建节点自动保存');
  assert.ok(Math.abs(created.x - expected.x) < 1 && Math.abs(created.y - expected.y) < 1, `节点应在鼠标位置：${JSON.stringify({ created, expected })}`);

  await page.getByRole('button', { name: '删除', exact: true }).first().click();
  await page.getByRole('button', { name: '快速研究', exact: true }).click();
  assert.equal(await page.getByLabel('受众、目标与创作要求（可选）').inputValue(), '原始简报');
  await page.getByLabel('受众、目标与创作要求（可选）').fill('面向技术决策者，比较可靠性与 TCO。');
  await page.getByRole('button', { name: '保存简报', exact: true }).click();
  await until(async () => (await api(`/api/projects/${project.id}/canvas`)).nodes.find((node) => node.id === brief.id)?.body.includes('比较可靠性与 TCO'), '简报同步白板');
  await page.screenshot({ path: path.join(temporary, 'research.png') });
  await page.getByRole('button', { name: '内容白板', exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${brief.id}"] .flow-card-expand`).click();
  assert.ok((await page.getByRole('dialog').innerText()).includes('比较可靠性与 TCO'));
  await page.getByRole('button', { name: '收起全文' }).click();
  await page.screenshot({ path: path.join(temporary, 'canvas.png') });
  const briefCard = page.locator(`.react-flow__node[data-id="${brief.id}"]`);
  await briefCard.click();
  for (const type of ['insight', 'challenge', 'creative_pattern', 'note']) {
    await page.getByLabel('新节点类型').selectOption(type);
    const web = page.getByLabel('检索网络资料（自动选择：优先 DeepSeek，其次搜索 MCP，并与 Wiki 资料综合）');
    await web.check(); assert.equal(await web.isChecked(), true);
  }
  await page.screenshot({ path: path.join(temporary, 'mcp-options.png') });
  await page.getByRole('button', { name: '工具栏设置' }).click();
  await page.getByRole('button', { name: '右边缘', exact: true }).click();
  await page.getByRole('button', { name: '工具栏设置' }).click();
  await page.getByRole('button', { name: '折叠任务监测' }).click();
  await page.reload();
  await page.getByRole('button', { name: /交互回归项目/ }).click();
  assert.equal(await page.locator('.canvas-toolbox').getAttribute('data-dock'), 'right');
  assert.equal(await page.getByRole('button', { name: '展开任务监测' }).count(), 1);
  await page.screenshot({ path: path.join(temporary, 'persistent-dock.png') });
  await page.setViewportSize({ width: 940, height: 900 });
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '工具栏设置' }).click();
  for (const edge of ['上边缘', '左边缘', '下边缘', '右边缘']) {
    await page.getByRole('button', { name: edge, exact: true }).click();
    for (const direction of ['横向', '纵向']) {
      await page.getByRole('button', { name: direction, exact: true }).click();
      const boardBox = await page.locator('.board-wrap').boundingBox();
      const popup = await page.locator('.canvas-toolbar-settings').boundingBox();
      const toolsBox = await page.locator('.canvas-toolbox').boundingBox();
      for (const box of [popup, toolsBox]) assert.ok(box.x >= boardBox.x && box.y >= boardBox.y && box.x + box.width <= boardBox.x + boardBox.width + 1 && box.y + box.height <= boardBox.y + boardBox.height + 1, '窄窗口下工具栏和设置面板应完整显示');
    }
  }
  await page.screenshot({ path: path.join(temporary, 'narrow-toolbar-settings.png') });
  if (process.env.CIC_DEEPSEEK_TEST_KEY_FILE) {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '全局网络与代理', exact: true }).click();
    const globalSettings = page.getByLabel('全局网络与代理设置');
    await globalSettings.getByLabel('全局网络连接方式').selectOption('custom_proxy');
    await globalSettings.getByLabel('全局代理地址').fill('http://127.0.0.1:17890');
    await globalSettings.getByLabel('全局代理密码', { exact: true }).fill('e2e-password');
    await globalSettings.getByRole('button', { name: '保存全局网络设置', exact: true }).click();
    await globalSettings.getByText(/全局网络设置已保存/).waitFor();
    assert.equal((await api('/api/settings/network')).has_proxy_password, true);
    assert.equal(await globalSettings.getByLabel('全局代理密码', { exact: true }).inputValue(), '');
    await globalSettings.getByLabel('全局网络连接方式').selectOption('auto');
    await globalSettings.getByRole('button', { name: '保存并测试网络', exact: true }).click();
    await globalSettings.getByText(/HTTP [0-9]+.*ms/).waitFor({ timeout: 30000 });
    await page.getByRole('tab', { name: '大模型与代理', exact: true }).click();
    assert.equal(await page.locator('.network-settings select').inputValue(), 'inherit');
    await page.getByRole('tab', { name: 'MCP 与网页搜索', exact: true }).click();
    const webSettings = page.getByLabel('DeepSeek 网页工具设置');
    await webSettings.getByLabel('启用 DeepSeek 网页搜索', { exact: true }).check();
    await webSettings.getByLabel('启用 DeepSeek 网页抓取', { exact: true }).check();
    await webSettings.getByLabel('DeepSeek 网页工具 API Key').fill(readFileSync(process.env.CIC_DEEPSEEK_TEST_KEY_FILE, 'utf8').trim());
    await webSettings.getByLabel('搜索结果条数（1–50）').fill('2');
    await webSettings.getByLabel('默认检索语法').fill('site:api-docs.deepseek.com');
    await webSettings.getByRole('button', { name: '测试网页搜索', exact: true }).click();
    await webSettings.getByText('真实网页工具测试通过', { exact: true }).waitFor({ timeout: 65000 });
    assert.ok((await webSettings.innerText()).includes('site:api-docs.deepseek.com'));
    await webSettings.getByRole('button', { name: '测试网页抓取', exact: true }).click();
    await webSettings.getByText('真实网页工具测试通过', { exact: true }).nth(1).waitFor({ timeout: 65000 });
    await webSettings.getByRole('button', { name: '保存并测试完整联网流程', exact: true }).click();
    await webSettings.getByText('真实网页工具测试通过', { exact: true }).nth(2).waitFor({ timeout: 65000 });
    const config = await api('/api/settings/deepseek-web');
    assert.ok(config.has_api_key && !config.api_key && !config.secret_ref, '配置读取不得回显密钥');
    assert.equal((await api('/api/settings/web-search')).provider, 'deepseek');
    const output = await webSettings.innerText();
    assert.ok(output.includes('篇网页正文') && output.includes('字符作为模型上下文'));
    assert.equal(await webSettings.getByLabel('DeepSeek 网页工具 API Key').inputValue(), '');
    await webSettings.screenshot({ path: path.join(temporary, 'deepseek-live-test.png') });
    console.log(JSON.stringify({ deepseek_live_test: 'passed', output: output.slice(output.indexOf('真实网页工具测试通过'), output.indexOf('测试执行日志')) }));
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ passed: true, checks: ['锁定分组层级与尺寸保护', '锁定/未锁定分组右键平移', '浏览器右键菜单抑制', '侧栏折叠', '平移缩放后 N 在鼠标处创建', '简报保存与白板全文同步', '四边拖动吸附与方向切换', '任务栏折叠并刷新保留', '四种加工类型 MCP 选项'], screenshots: temporary }));
}

run().catch((error) => { console.error(error); console.error(logs.join('').slice(-5000)); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  processes.forEach((child) => child.kill());
});

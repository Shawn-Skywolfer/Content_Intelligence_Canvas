// Run after npm ci in apps/web. Requires Playwright with Chromium installed and backend dependencies.
// CIC_E2E_PYTHON selects the Python interpreter; CIC_PLAYWRIGHT_MODULE can select a local Playwright installation.
const { chromium } = require(process.env.CIC_PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
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
  const project = await api('/api/projects', 'POST', { name: '交互回归项目', idea: '研究供电方案', brief: '原始简报' });
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
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ passed: true, checks: ['锁定分组层级与尺寸保护', '锁定/未锁定分组右键平移', '浏览器右键菜单抑制', '侧栏折叠', '平移缩放后 N 在鼠标处创建', '简报保存与白板全文同步'], screenshots: temporary }));
}

run().catch((error) => { console.error(error); console.error(logs.join('').slice(-5000)); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  processes.forEach((child) => child.kill());
});

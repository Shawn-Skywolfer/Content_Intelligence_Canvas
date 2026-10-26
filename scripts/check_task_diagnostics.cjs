// Local streaming fixture: exercise the actual gateway, SQLite logs and browser UI without a paid API.
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = async function checkTaskDiagnostics({ page, api, apiUrl, temporary, until }) {
  let fail = false;
  const fixture = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw);
      assert.equal(payload.max_tokens, 393216);
      if (fail) { response.writeHead(429, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: '测试额度不足，请检查用量' } })); return; }
      const system = payload.messages[0].content;
      let text = system.includes('检索规划助手') ? JSON.stringify({ queries: ['完整 Wiki 原始词条'], read_relations: false }) : system.includes('节点摘要助手') ? JSON.stringify({ summary: '流式验证已通过。' }) : '## 流式回归结果\n\n已完整处理原始 Wiki，并记录网络线路、HTTP 与生成进展。';
      if (!payload.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const send = (delta, finish = null) => response.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) + '\n\n');
      send({ reasoning_content: '供应商返回：正在核对 Wiki 相关材料。' });
      await new Promise((resolve) => setTimeout(resolve, system.includes('检索规划助手') ? 1500 : 2200));
      for (let index = 0; index < text.length; index += 12) {
        if (response.destroyed) return;
        send({ content: text.slice(index, index + 12) });
        await new Promise((resolve) => setTimeout(resolve, 230));
      }
      response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  try {
    const provider = await api('/api/providers', 'POST', { name: '流式进度回归', base_url: `http://127.0.0.1:${fixture.address().port}/v1`, model_name: 'fixture-stream', is_external: false, max_tokens: 393216, extra: { network_mode: 'direct' } });
    await api(`/api/providers/${provider.id}/activate`, 'POST');
    const project = await api('/api/projects', 'POST', { name: '任务日志回归', idea: '基于完整 Wiki 生成中文内容', brief: '' });
    const canvas = await api(`/api/projects/${project.id}/canvas`);
    const input = canvas.nodes.find((node) => node.type === 'idea');
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.reload();
    await page.getByRole('button', { name: /任务日志回归/ }).click();
    await until(async () => {
      await page.locator(`.react-flow__node[data-id="${input.id}"] h3`).click();
      return await page.getByLabel('新节点类型').count() > 0;
    }, '选中节点显示 AI 共创');
    await page.getByLabel('新节点类型').selectOption('output');
    await page.getByLabel('内容输出形态').selectOption('video_script');
    const duration = page.getByLabel('目标时长（秒）', { exact: true });
    await duration.fill(''); assert.equal(await duration.inputValue(), '');
    await duration.pressSequentially('125'); assert.equal(await duration.inputValue(), '125');
    const expand = page.getByRole('button', { name: '展开任务监测', exact: true });
    if (await expand.count()) await expand.click();
    const job = await api(`/api/projects/${project.id}/magic/start`, 'POST', { node_ids: [input.id], instruction: '依据 Wiki 综合整理', output_type: 'note' });
    const row = page.locator('.canvas-task').first();
    await until(async () => await row.count() > 0 && (await row.innerText()).includes('运行中'), '运行任务出现在监测栏');
    assert.equal(await row.getByRole('button', { name: '删除任务', exact: true }).isDisabled(), true);
    const denied = await fetch(`${apiUrl}/api/magic/jobs/${job.job_id}`, { method: 'DELETE' });
    assert.equal(denied.status, 409);
    await row.getByRole('button', { name: '查看详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '任务完整详情', exact: true });
    await dialog.getByText(/推理 .*字符/).first().waitFor();
    await dialog.getByText(/正文 .*字符/).first().waitFor();
    let result;
    await until(async () => { result = await api(`/api/projects/${project.id}/magic/jobs`); return result.find((item) => item.job_id === job.job_id)?.status === 'completed'; }, '真实流式任务完成');
    await until(async () => (await dialog.innerText()).includes('生成完成'), '详情实时更新完成状态');
    assert.ok((await dialog.innerText()).includes('供应商返回：正在核对 Wiki 相关材料。'));
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('link', { name: '导出 LOG（JSON）', exact: true }).click();
    const download = await downloadPromise;
    const logPath = path.join(temporary, 'task-diagnostics.json'); await download.saveAs(logPath);
    const exported = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.ok(exported.logs.some((event) => event.metrics?.http_status === 200));
    assert.ok(exported.logs.some((event) => event.metrics?.reasoning_chars > 0));
    assert.ok(exported.logs.some((event) => event.metrics?.usage?.total_tokens === 160));
    assert.ok(exported.logs.map((event) => event.metrics?.provider_reasoning || '').join('').includes('供应商返回：正在核对 Wiki 相关材料。'));
    await dialog.screenshot({ path: path.join(temporary, 'task-logs.png') });
    await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    await row.getByRole('button', { name: '删除任务', exact: true }).click();
    await until(async () => (await api(`/api/projects/${project.id}/magic/jobs`)).length === 0, '已停止任务可删除');
    const outputId = result.find((item) => item.job_id === job.job_id).result.node.id;
    assert.ok((await api(`/api/projects/${project.id}/canvas`)).nodes.some((node) => node.id === outputId));
    fail = true;
    const failed = await api(`/api/projects/${project.id}/magic/start`, 'POST', { node_ids: [input.id], instruction: '验证错误反馈', output_type: 'note' });
    await until(async () => (await api(`/api/projects/${project.id}/magic/jobs`)).find((item) => item.job_id === failed.job_id)?.status === 'failed', 'HTTP 429 任务明确失败');
    const errorLog = await (await fetch(`${apiUrl}/api/magic/jobs/${failed.job_id}/logs/export?format=json`)).json();
    assert.ok(errorLog.logs.some((event) => event.level === 'error' && event.detail.includes('HTTP 429')));
    console.log(JSON.stringify({ v26_checks: 'passed', log_events: exported.logs.length, checks: ['真实流式网关与页面实时进展', '供应商推理文本实时查看与完整记录', 'HTTP和用量', 'LOG下载与持久化', '运行任务禁止删除', '停止后删除保留生成结果', '视频时长清空输入', 'HTTP429错误诊断'] }));
  } finally { fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve)); }
};

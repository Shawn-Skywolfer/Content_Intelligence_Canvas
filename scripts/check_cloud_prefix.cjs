// 用实际浏览器验证带前缀网页、资源、业务请求以及白板初始化。
const { chromium } = require(process.env.CIC_PLAYWRIGHT_MODULE || '../apps/web/node_modules/playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-browser-'));
const prefix = '/ContentWorkbench';
let child, gateway, browser;
(async () => {
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const backendPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const backend = `http://127.0.0.1:${backendPort}`;
  child = spawn(process.env.CIC_E2E_PYTHON || 'python', ['-m', 'uvicorn', 'app.cloud_deployment:create_cloud_app', '--factory', '--host', '127.0.0.1', '--port', String(backendPort)], {
    cwd: path.join(root, 'apps/api'), env: {...process.env, DATA_DIR: path.join(temporary, 'data'), SERVICE_PREFIX: prefix, CIC_SERVER_MODE: 'cloud', CIC_SERVER_PASSWORD: ''}, stdio: 'ignore',
  });
  let ready = false;
  for (let i=0;i<120;i++) {
    try { if ((await fetch(backend + prefix + '/api/health')).ok) { ready=true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve,250));
  }
  assert(ready, '后端未就绪');
  const created = await fetch(backend + prefix + '/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'云端前缀验收',idea:'测试白板',brief:''})});
  assert(created.ok, await created.text());
  gateway = http.createServer(async (req,res) => {
    try {
      const pathname = new URL(req.url, 'http://local').pathname;
      if (pathname.startsWith(prefix + '/api/')) {
        const chunks=[]; for await(const chunk of req) chunks.push(chunk);
        const response = await fetch(backend + req.url, {method:req.method, headers:{'Content-Type':req.headers['content-type'] || 'application/json'}, ...(chunks.length ? {body:Buffer.concat(chunks)} : {})});
        res.writeHead(response.status, {'Content-Type':response.headers.get('content-type') || 'application/json'});
        return res.end(Buffer.from(await response.arrayBuffer()));
      }
      let relative = pathname.slice(prefix.length).replace(/^\//,'');
      if (!relative) relative = 'index.html';
      const filename = path.resolve(root, 'apps/web/dist', relative);
      if (!pathname.startsWith(prefix) || !filename.startsWith(path.join(root,'apps/web/dist')+path.sep)) {res.writeHead(404);return res.end();}
      res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(filename));
    } catch(error) {res.writeHead(500);res.end(String(error));}
  });
  await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[], requests=[];
  page.on('pageerror', error=>errors.push(String(error)));
  page.on('request', request=>requests.push(new URL(request.url()).pathname));
  for (const suffix of ['', '/']) {
    await page.goto(origin+prefix+suffix);
    await page.getByText('云端前缀验收', {exact:true}).first().waitFor();
  }
  await page.getByText('云端前缀验收',{exact:true}).first().click();
  await page.locator('.react-flow__node').first().waitFor();
  assert(requests.some(url=>url.startsWith(prefix+'/assets/')));
  assert(requests.some(url=>url.startsWith(prefix+'/api/projects')));
  assert(!requests.some(url=>url.startsWith('/api/')||url.startsWith('/assets/')));
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({prefix, browser:'Chromium', trailing_slash:'通过', api_prefix:'通过', relative_assets:'通过', canvas:'通过', nodes:await page.locator('.react-flow__node').count()}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser) await browser.close();
  if(gateway) await new Promise(resolve=>gateway.close(resolve));
  if(child) child.kill();
  fs.rmSync(temporary,{recursive:true,force:true});
});

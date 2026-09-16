import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const requestedPort = Number.parseInt(process.env.PORT || '3211', 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 3211;
let activeChild = null;
let stopRequested = false;
let job = { status: 'idle', lines: [], outputDir: path.join(root, 'archive-data') };

function addLine(text) {
  for (const line of String(text).split(/\r?\n/)) if (line.trim()) job.lines.push(line.trim());
  job.lines = job.lines.slice(-100);
}
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function isDouyinUrl(value) {
  try { const host = new URL(value).hostname.toLowerCase(); return host === 'douyin.com' || host.endsWith('.douyin.com'); }
  catch { return false; }
}
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function stopChildTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>抖音公开作品归档</title><style>
*{box-sizing:border-box}body{margin:0;background:#0c1018;color:#eef3fb;font-family:"Microsoft YaHei",system-ui,sans-serif}.wrap{max-width:850px;margin:auto;padding:52px 24px}.eyebrow{color:#ff4b70;font-size:13px;font-weight:800;letter-spacing:.12em}h1{font-size:31px;margin:10px 0}p{color:#aeb9c9;line-height:1.7}.card{margin-top:26px;padding:28px;background:#171d29;border:1px solid #2c374a;border-radius:18px;box-shadow:0 18px 55px #0005}.row{display:flex;gap:12px;margin-top:18px}input{min-width:0;flex:1;padding:14px;border:1px solid #3b475c;border-radius:10px;background:#0e1420;color:#fff;font-size:16px}button{border:0;border-radius:10px;padding:0 23px;background:#ff4b70;color:white;font-weight:800;font-size:16px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.options{display:flex;gap:18px;align-items:center;margin-top:14px;color:#aeb9c9;flex-wrap:wrap}.options input{width:86px;flex:0;padding:8px}.options .tip{width:100%;font-size:13px;color:#7e8ba0}.status{margin-top:25px;padding:16px;background:#0d121c;border:1px solid #2c374a;border-radius:12px}.state{color:#83e7ae;font-weight:700}.log{height:220px;overflow:auto;white-space:pre-wrap;margin-top:12px;padding:14px;background:#080b10;color:#bdc8d8;border-radius:8px;font:13px/1.65 Consolas,monospace}.hint{font-size:14px;margin-top:20px}code{background:#273146;padding:2px 6px;border-radius:4px}@media(max-width:600px){.wrap{padding:32px 16px}.row{flex-direction:column}button{height:48px}}
</style></head><body><main class="wrap"><div class="eyebrow">LOCAL ARCHIVE</div><h1>抖音公开作品归档</h1><p>粘贴博主主页或抖音分享短链，设置好起始位置和数量后点击开始。首次使用时，请在弹出的浏览器窗口中自行登录或处理验证码。</p><section class="card"><div class="row"><input id="url" placeholder="粘贴 https://v.douyin.com/... 或博主主页链接"><button id="start">开始归档</button><button id="stop" disabled>停止任务</button></div><div class="options"><label>从第 <input id="from" type="number" min="1" value="1"> 个作品开始</label><label>本批下载 <input id="max" type="number" min="1" max="500" value="20"> 个</label><span class="tip">已下载过的作品会自动跳过；博主作品抓完后程序会自动停止。一批次只打开一次浏览器。</span></div><div class="status"><div class="state" id="state">等待开始</div><div class="log" id="log">尚未执行任务。</div></div><p class="hint">文件保存位置：<code id="folder"></code>（每个博主一个文件夹，视频以「发布日期_标题_作品ID」直接命名）</p></section></main><script>
const $=id=>document.getElementById(id);
const labels={idle:'等待开始',running:'正在归档，请勿关闭浏览器',stopping:'正在停止，请稍候',stopped:'任务已停止，可继续上次任务',done:'任务完成',partial:'本轮未完成，可再次运行继续收集',failed:'任务失败'};
async function refresh(){
  const r=await fetch('/api/status');
  const s=await r.json();
  $('state').textContent=labels[s.status]||s.status;
  $('log').textContent=s.lines.join('\\n')||'尚未执行任务。';
  $('folder').textContent=s.outputDir;
  const busy=s.status==='running'||s.status==='stopping';
  $('start').disabled=busy;
  $('stop').disabled=s.status!=='running';
  $('start').textContent=busy?'正在运行…':'开始归档';
  $('log').scrollTop=$('log').scrollHeight;
}
$('start').onclick=async()=>{
  const r=await fetch('/api/archive',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:$('url').value.trim(),max:Number($('max').value),start:Number($('from').value)})});
  const d=await r.json();
  if(!r.ok)alert(d.error);
  refresh();
};
$('stop').onclick=async()=>{
  const r=await fetch('/api/stop',{method:'POST'});
  const d=await r.json();
  if(!r.ok)alert(d.error);
  refresh();
};
refresh();setInterval(refresh,1200);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page); }
  if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, job);
  if (req.method === 'POST' && req.url === '/api/stop') {
    if (!activeChild) return send(res, 409, { error: '当前没有正在运行的任务。' });
    stopRequested = true;
    job.status = 'stopping';
    addLine('正在停止任务；当前断点会保留，稍后可继续。');
    stopChildTree(activeChild);
    return send(res, 202, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/archive') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: '请求格式无效。' }); }
    if (!isDouyinUrl(body.url)) return send(res, 400, { error: '请输入 douyin.com 或 v.douyin.com 链接。' });
    if (activeChild) return send(res, 409, { error: '已有归档任务正在运行。' });
    const max = clampInt(body.max, 1, 500, 20);
    const start = clampInt(body.start, 1, 999999, 1);
    stopRequested = false;
    job = { status: 'running', lines: ['正在启动浏览器…'], outputDir: path.join(root, 'archive-data') };
    activeChild = spawn(process.execPath, [path.join(here, 'index.js'), 'profile', body.url, '--max', String(max), '--start', String(start)], { cwd: root, windowsHide: true });
    activeChild.stdout.on('data', addLine); activeChild.stderr.on('data', addLine);
    activeChild.on('error', error => {
      addLine(error.message);
      job.status = stopRequested ? 'stopped' : 'failed';
      activeChild = null;
      stopRequested = false;
    });
    activeChild.on('close', code => {
      if (stopRequested) {
        job.status = 'stopped';
        addLine('任务已停止，断点已保留。下次使用同一链接会继续。');
      } else {
        job.status = code === 0 ? 'done' : code === 2 ? 'partial' : 'failed';
        addLine(code === 0 ? '归档完成。' : code === 2 ? '本轮候选作品不足，未达到设置数量；可以再次运行继续收集。' : `任务结束，退出码 ${code}。`);
      }
      activeChild = null;
      stopRequested = false;
    });
    return send(res, 202, { ok: true });
  }
  send(res, 404, { error: '未找到页面。' });
});
server.listen(port, '127.0.0.1', () => console.log(`请在浏览器打开：http://127.0.0.1:${port}`));
function shutdown() {
  if (activeChild && activeChild.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(activeChild.pid), '/T', '/F'], { windowsHide: true });
    } else {
      activeChild.kill('SIGTERM');
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

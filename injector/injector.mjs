// ZCode Token Bar —— 通过 CDP 把一条速率条注入 ZCode 渲染层（输入框下方）
//
// 用法：
//   node injector/injector.mjs [--port 9333] [--ctl-port 9334]
//
// 前提：ZCode 以 `--remote-debugging-port=9333` 启动。
// 本进程持续运行：等界面就绪后注入，每 800ms 推最新指标；ZCode 退出后自动结束。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MetricsTracker } from './metrics.mjs';

const PORT = Number(getArg('--port', '9333'));
const CTL_PORT = Number(getArg('--ctl-port', '9334'));
const DEBUG = `http://127.0.0.1:${PORT}`;
const TICK_MS = 800;
const SHOT_SCRIPT = process.env.TOKBAR_SHOT_SCRIPT ||
  path.join(os.homedir(), '.zcode', 'local-plugins', 'zcode-screenshot', 'scripts', 'capture.ps1');
// 用 wscript 拉起截图脚本：wscript 是 GUI 程序，不会闪控制台，也不受 windowsHide 影响
const SHOT_VBS = path.join(os.tmpdir(), 'zcode-tokbar-shot.vbs');
const VBS_CODE = [
  'Set sh = CreateObject("WScript.Shell")',
  'sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """", 0, False',
  ''
].join(String.fromCharCode(10));
const SETTLE_MS = 2500; // 界面就绪后，再等等才注入，避开启动期的布局抖动

let visible = true;
let connected = false;

function getArg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const tracker = new MetricsTracker();

/* ------------------------- 页面内：就绪判断 ------------------------- */

const READY_JS = String.raw`(() => {
  if (document.readyState !== 'complete') return false;
  const el = document.querySelector('textarea, [contenteditable="true"], [contenteditable=""]');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 60 || r.height < 8) return false;
  if (r.top < 0 || r.top > window.innerHeight) return false;
  return true;
})()`;

/* ------------------------- 页面内：注入脚本 ------------------------- */

const INSTALL_JS = String.raw`(() => {
  window.__tokbarVisible = true;
  if (window.__tokbarInstalled) { window.__tokbarEnsure && window.__tokbarEnsure(); return 'already'; }
  window.__tokbarInstalled = true;
  window.__tokbarGen = (window.__tokbarGen || 0) + 1;
  const MY_GEN = window.__tokbarGen;

  const BAR_ID = 'zcode-tokbar';
  const MONO = 'ui-monospace,SFMono-Regular,Consolas,monospace';

  // 跟随 ZCode 主题：优先看根节点实际背景色，退化为系统配色偏好
  function isDark() {
    let el = document.getElementById('root') || document.body;
    for (let i = 0; i < 6 && el; i++) {
      const bg = getComputedStyle(el).backgroundColor || '';
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) {
        const l = 0.299 * (+m[1]) + 0.587 * (+m[2]) + 0.114 * (+m[3]);
        return l < 128;
      }
      el = el.parentElement;
    }
    try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return true; }
  }

  function palette() {
    return isDark()
      ? { bg: '#000', fg: 'rgba(235,238,242,.62)', line: 'rgba(255,255,255,.10)', strong: '#eceff2', dim: 'rgba(255,255,255,.38)', good: '#3ddc97', warn: '#f7b955', bad: '#ff6b6b' }
      : { bg: '#fff', fg: 'rgba(17,24,39,.62)', line: 'rgba(0,0,0,.10)', strong: '#111827', dim: 'rgba(0,0,0,.38)', good: '#059669', warn: '#d97706', bad: '#dc2626' };
  }

  // 取真实底色：向上找第一个不透明的背景色，让条子和 ZCode 融合
  function bgOf(el) {
    for (var i = 0; i < 14 && el; i++) {
      var bg = getComputedStyle(el).backgroundColor || '';
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      el = el.parentElement;
    }
    return null;
  }

  function findComposer() {
    const nodes = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]');
    let best = null, bestY = -Infinity;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 8) continue;
      if (r.top > bestY) { bestY = r.top; best = el; }
    }
    return best;
  }

  // 会话主滚动容器：高度够大、可纵向滚动、且内容确实超出
  function findScroller() {
    const all = document.querySelectorAll('div');
    let best = null, bestH = 0;
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (el.clientHeight < 300) continue;
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      if (el.clientHeight > bestH) { bestH = el.clientHeight; best = el; }
    }
    return best;
  }

  function buildBar() {
    const p = palette();
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px',
      'height:22px', 'padding:0 12px', 'box-sizing:border-box',
      'font:11px/22px "Microsoft YaHei UI","Microsoft YaHei","PingFang SC",ui-sans-serif,system-ui,sans-serif',
      'color:' + p.fg, 'background:' + p.bg,
      'border-top:none',
      'flex:0 0 auto', 'width:100%', 'overflow:hidden',
      'white-space:nowrap', 'pointer-events:none', 'user-select:none',
      'z-index:2147483000'
    ].join(';');
    bar.innerHTML =
      '<span id="tokbar-dot" style="width:6px;height:6px;border-radius:50%;background:' + p.dim + ';flex:0 0 auto"></span>' +
      '<span id="tokbar-tps" style="color:' + p.strong + ';font-weight:600;font-size:12px;font-family:' + MONO + '">0.0</span>' +
      '<span style="color:' + p.dim + ';letter-spacing:.3px">tok/s</span>' +
      '<span style="color:' + p.dim + ';letter-spacing:.5px;font-weight:500">缓存命中</span>' +
      '<span id="tokbar-cache" style="color:' + p.strong + ';font-family:' + MONO + '">—</span>' +
      '<span id="tokbar-tok" style="color:' + p.dim + ';margin-left:auto"></span>';
    return bar;
  }

  // 在输入框工具栏“完全访问”旁边插入截图按钮
  // 注意：React 重渲染可能克隆节点，addEventListener 会丢；这里每帧都重绑 onclick（幂等）
  function ensureShotButton() {
    var host = null, group = null;
    var divs = document.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      var t = (divs[i].textContent || '').trim();
      if (t === '完全访问' || t === '安全访问') {
        var g = divs[i];
        while (g && g.parentElement && !/shrink-0/.test(String(g.className || ''))) g = g.parentElement;
        if (g && g.parentElement) { group = g; host = g.parentElement; break; }
      }
    }
    if (!host) return;

    var btn = document.getElementById('zcode-tokbar-shot');
    if (btn && btn.dataset.tokbar !== '1') { btn.remove(); btn = null; }  // 清掉旧版本残留的监听器
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'zcode-tokbar-shot';
      btn.dataset.tokbar = '1';
      btn.type = 'button';
      btn.title = '截图（框选后自动填入输入框）';
      btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
      btn.style.cssText = ['display:flex','align-items:center','justify-content:center','width:28px','height:28px','margin-left:2px','padding:0','background:transparent','border:none','border-radius:6px','color:inherit','cursor:pointer','flex:0 0 auto','opacity:.75'].join(';');
    }

    // 每次确保事件绑定（用 onclick 属性，重复赋值不会叠加）
    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      fetch('http://127.0.0.1:9334/screenshot', { method: 'POST' }).catch(function () {});
    };
    btn.onmouseenter = function () { btn.style.opacity = '1'; btn.style.background = 'rgba(255,255,255,.08)'; };
    btn.onmouseleave = function () { btn.style.opacity = '.75'; btn.style.background = 'transparent'; };

    if (btn.parentElement !== host || btn.previousElementSibling !== group) {
      host.insertBefore(btn, group.nextSibling);
    }
    if (!btn.dataset.shotChecked) {
      btn.dataset.shotChecked = '1';
      fetch('http://127.0.0.1:9334/status').then(function (r) { return r.json(); }).then(function (st) {
        if (st && st.shot === false) btn.style.display = 'none';
      }).catch(function () {});
    }
  }

  function ensure() {
    if (!window.__tokbarVisible) {
      const old = document.getElementById(BAR_ID);
      if (old) old.remove();
      return;
    }

    ensureShotButton();

    const input = findComposer();
    const p = palette();

    let bar = document.getElementById(BAR_ID);
    if (!bar) bar = buildBar();

    // 主题可能切换：每次确保时刷新颜色
    bar.style.background = p.bg;
    bar.style.color = p.fg;
    const tps = document.getElementById('tokbar-tps');
    if (tps) tps.style.color = p.strong;

    // 关键：挂在“会话滚动容器”的父级上并绝对定位，才不会被滚动带走。
    // 缓存容器，且找不到时不要把已就位的条子挪走（避免内容短时来回抖动）。
    let scroller = window.__tokbarScroller;
    if (!scroller || !scroller.isConnected) scroller = findScroller();
    const host = scroller ? scroller.parentElement : null;

    if (host && host !== document.body) {
      window.__tokbarScroller = scroller;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      bar.style.position = 'absolute';
      bar.style.left = '0';
      bar.style.right = '0';
      bar.style.bottom = '0';
      bar.style.width = 'auto';
      bar.style.margin = '0';
      bar.style.zIndex = '30';
      bar.style.background = 'transparent';
      if (bar.parentElement !== host) host.appendChild(bar);
      if (scroller.style.marginBottom) scroller.style.marginBottom = '';  // 不能挤压布局，否则输入框会上移
      return;
    }

    // 还没找到滚动容器：保持现状，等下一次 ensure 再挂
    if (bar.parentElement) return;

    // 兜底：连父级都没有时，固定贴底
    bar.style.position = 'fixed';
    bar.style.left = '0';
    bar.style.right = '0';
    bar.style.bottom = '0';
    bar.style.zIndex = '30';
    document.body.appendChild(bar);
  }

  function update(m) {
    ensure();
    if (!window.__tokbarVisible) return false;
    const p = palette();
    const $ = function (id) { return document.getElementById(id); };
    const dot = $('tokbar-dot'), tps = $('tokbar-tps'), cache = $('tokbar-cache'), tok = $('tokbar-tok');
    if (!dot) return false;

    const fmt = function (n) {
      return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0));
    };

    dot.style.background = (m && m.running) ? p.good : p.dim;
    dot.style.boxShadow = (m && m.running) ? ('0 0 6px ' + p.good) : 'none';

    if (!m || !m.ok) {
      tps.textContent = '—';
      cache.textContent = '—';
      cache.style.color = p.dim;
      tok.textContent = '暂无数据';
      return true;
    }

    tps.textContent = (m.tps || 0).toFixed(1);
    const pct = m.cacheHitRate || 0;
    cache.textContent = pct.toFixed(1) + '%';
    cache.style.color = p.strong;
    tok.innerHTML = '<span style="font-family:' + MONO + '">' + (m.calls || 0) + '</span> 次 · ' +
      '<span style="font-family:' + MONO + '">' + fmt(m.outputTokens) + '</span> out';
    return true;
  }

  window.__tokbarUpdate = update;
  window.__tokbarEnsure = ensure;

  ensure();
  setInterval(function () { if (window.__tokbarGen !== MY_GEN) return; ensure(); }, 1500);
  const mo = new MutationObserver(function () {
    if (window.__tokbarGen !== MY_GEN) return;
    if (!document.getElementById(BAR_ID)) ensure();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  return 'installed';
})()`;

export const REMOVE_JS = String.raw`(() => {
  window.__tokbarVisible = false;
  const b = document.getElementById('zcode-tokbar');
  if (b) b.remove();
  if (window.__tokbarScroller) { window.__tokbarScroller.style.marginBottom = ''; window.__tokbarScroller = null; }
  return 'removed';
})()`;

// 重启注入器时清掉旧条子，确保新样式能生效
const RESET_JS = String.raw`(() => {
  window.__tokbarVisible = false;
  window.__tokbarInstalled = false;
  const sbtn = document.getElementById('zcode-tokbar-shot');
  if (sbtn) sbtn.remove();
  window.__tokbarGen = (window.__tokbarGen || 0) + 1;  // 让旧闭包的定时器/观察器失效
  const b = document.getElementById('zcode-tokbar');
  if (b) b.remove();
  if (window.__tokbarScroller) { window.__tokbarScroller.style.marginBottom = ''; window.__tokbarScroller = null; }
  return 'reset';
})()`;

/* ------------------------- 本地控制接口 ------------------------- */

function startControlServer() {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/status' && req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, connected, visible, port: PORT, shot: fs.existsSync(SHOT_SCRIPT), shotScript: SHOT_SCRIPT }));
      return;
    }
    if (req.url === '/visible' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { visible = !!JSON.parse(body || '{}').visible; } catch { visible = !visible; }
        res.end(JSON.stringify({ ok: true, visible }));
      });
      return;
    }
    if (req.url === '/screenshot' && req.method === 'POST') {
      try {
        fs.writeFileSync(SHOT_VBS, VBS_CODE, 'utf8');
        spawn('wscript.exe', [SHOT_VBS, SHOT_SCRIPT], { stdio: 'ignore' }).unref();
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
      return;
    }
    if (req.url === '/toggle' && req.method === 'POST') {
      visible = !visible;
      res.end(JSON.stringify({ ok: true, visible }));
      return;
    }
    res.statusCode = 404;
    res.end('{"ok":false}');
  });
  srv.on('error', (e) => console.error('控制端口启动失败:', e.message));
  srv.listen(CTL_PORT, '127.0.0.1', () => console.log(`控制接口: http://127.0.0.1:${CTL_PORT}`));
  return srv;
}

/* ------------------------- CDP ------------------------- */

let nextId = 1;

function rpc(ws, method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        resolve(msg);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function findPageTarget() {
  try {
    const res = await fetch(`${DEBUG}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = await res.json();
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return pages.find((t) => !/devtools/i.test(t.url || '')) || pages[0] || null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  startControlServer();
  console.log(`等待 ZCode 调试端口 ${DEBUG} ...`);

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    target = await findPageTarget();
    if (!target) await sleep(1000);
  }
  if (!target) {
    console.error('等不到调试端口。请确认 ZCode 是用 --remote-debugging-port 启动的。');
    process.exit(1);
  }
  console.log('已找到页面:', target.title || target.url);

  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener('open', resolve);
    sock.addEventListener('error', reject);
  });
  console.log('CDP 已连接');

  await rpc(sock, 'Runtime.enable', {});
  connected = true;

  // 清理旧注入（样式更新时也能生效）
  await rpc(sock, 'Runtime.evaluate', { expression: RESET_JS, returnByValue: true });

  let alive = true;
  sock.addEventListener('close', () => { alive = false; connected = false; });

  let applied = false;
  let readySince = 0;

  while (alive) {
    if (visible && !applied) {
      // 等界面真正挂载好（有输入框），再等一小会儿避开启动抖动
      const r = await rpc(sock, 'Runtime.evaluate', { expression: READY_JS, returnByValue: true });
      const ready = r?.result?.result?.value === true;
      if (!ready) { readySince = 0; await sleep(TICK_MS); continue; }
      if (!readySince) { readySince = Date.now(); await sleep(TICK_MS); continue; }
      if (Date.now() - readySince < SETTLE_MS) { await sleep(TICK_MS); continue; }

      const inst = await rpc(sock, 'Runtime.evaluate', { expression: INSTALL_JS, returnByValue: true });
      console.log('已注入:', inst?.result?.result?.value ?? inst?.result?.exceptionDetails?.text ?? 'ok');
      applied = true;
    } else if (!visible && applied) {
      await rpc(sock, 'Runtime.evaluate', { expression: REMOVE_JS, returnByValue: true });
      console.log('已隐藏');
      applied = false;
    }

    if (visible && applied) {
      let metrics;
      try { metrics = tracker.metrics(); } catch (e) { metrics = { ok: false, message: String(e && e.message) }; }
      const payload = JSON.stringify(metrics);
      const r = await rpc(sock, 'Runtime.evaluate', {
        expression: '(function(){var m=' + payload + ';var ok=window.__tokbarUpdate?window.__tokbarUpdate(m):false;return ok && !!document.getElementById("zcode-tokbar");})()',
        returnByValue: true,
      });
      if (r?.result?.result?.value === false) applied = false; // 页面重载或条子被移除 → 重新注入
    }

    await sleep(TICK_MS);
  }

  console.log('ZCode 已退出或连接断开，注入器结束。');
  process.exit(0);
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
  } catch {
    return false;
  }
})();
if (isDirectRun) main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

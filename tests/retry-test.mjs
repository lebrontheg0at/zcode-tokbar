// 验证异步 Lexical 桥下的 retry 发送（setText 异步提交，模拟真实 ZCode）
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const snippet = fs.readFileSync(path.join(here, '..', 'asar-patch', 'renderer-snippet.html'), 'utf8')
  .replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#fff;font-family:"Microsoft YaHei UI",system-ui}
  .app{height:100%;display:flex;flex-direction:column;justify-content:flex-end}
  .scroller{overflow-y:auto;height:70vh}
  .composer{padding:8px 12px}
  .card{border:1px solid #e5e5e5;border-radius:10px;padding:8px}
  .editor{min-height:56px;border:0;outline:0;font:14px system-ui}
  .row{display:flex;align-items:center;gap:8px;padding-top:6px;overflow:hidden}
  .left{display:flex;align-items:center;gap:6px}
  .shrink-0{flex-shrink:0}
  .ico{width:28px;height:28px;padding:0;border:0;background:#eee;border-radius:6px}
  .access{display:flex;align-items:center;height:28px;padding:0 8px;background:#eee;border-radius:6px;font-size:12px;color:#444}
  .model{height:28px;display:flex;align-items:center;padding:0 8px;border-radius:6px;background:#eee;font-size:12px;color:#444;flex-shrink:0;white-space:nowrap}
  .send{width:32px;height:32px;border:0;border-radius:50%;background:#222;flex-shrink:0}
  .send:disabled{background:#aaa}
</style></head><body>
<div class="app">
  <div class="scroller"><div style="height:1200px">聊天内容</div></div>
  <div class="composer">
    <div class="card">
      <div contenteditable="true" class="editor" id="decoy" data-testid="v4-edit-input" data-e2e-lexical-bridge="ready" style="display:none"></div>
      <div contenteditable="true" class="editor" id="editor" data-testid="v4-composer-input" data-e2e-lexical-bridge="ready"></div>
      <div class="row">
        <div class="left">
          <button class="ico" title="+">+</button>
          <div class="access shrink-0">完全访问</div>
        </div>
        <div class="model shrink-0">GLM-5.3-Flash ▾</div>
        <button class="send shrink-0" id="mock-send" data-testid="v4-composer-send" disabled></button>
      </div>
    </div>
  </div>
</div>
<script>${snippet}<\/script>
<script>
  window.__sends = 0;
  // 模拟真实 Lexical：setText → 2 跳之后状态才可见、按钮才可用
  const editor = document.getElementById('editor');
  const send = document.getElementById('mock-send');
  let committed = '';
  // 诱饵桥：排在主输入框前面（模拟 v4-edit-input 等隐藏编辑器），验证不会写错地方
  const decoy = document.getElementById('decoy');
  decoy.__zcodeLexicalInputE2E = {
    getText: () => 'DECOY',
    setText: (t) => { window.__decoyHit = (window.__decoyHit || 0) + 1; },
    focus: () => {},
  };
  editor.__zcodeLexicalInputE2E = {
    getText: () => committed,
    setText: (t) => {
      setTimeout(() => {                       // Lexical update 调度
        setTimeout(() => {                     // React commit 调度
          committed = t;
          editor.innerText = t;
          send.disabled = t.length === 0;
        }, 200);
      }, 200);
    },
    focus: () => editor.focus(),
  };
  send.addEventListener('click', function () {
    if (send.disabled) return;
    window.__sends++;
    setTimeout(() => {                          // ZCode 清空编辑器也有一点延迟
      committed = '';
      editor.innerText = '';
      send.disabled = true;
    }, 300);
  });
<\/script>
</body></html>`;

fs.writeFileSync(path.join(here, 'retry-test.html'), html);

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1148, height: 800 });
await page.goto('file:///' + path.join(here, 'retry-test.html').replace(/\\/g, '/'), { waitUntil: 'load' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = () => page.evaluate(() => {
  const b = document.getElementById('zcode-tokbar-retry');
  return {
    mode: b ? b.dataset.mode : null,
    title: b ? b.title : null,
    editorText: committed,
    sends: window.__sends || 0,
  };
});
const click = () => page.evaluate(() => document.getElementById('zcode-tokbar-retry').click());

await sleep(3200);
console.log('0) 桥选择（应命中主输入框，不走诱饵）:');
const bridgeCheck = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="v4-composer-input"]');
  return {
    mainHasBridge: !!(el && el.__zcodeLexicalInputE2E),
    decoyHits: window.__decoyHit || 0,
  };
});
console.log('  ', JSON.stringify(bridgeCheck));
console.log('1) 空编辑器、未运行:', JSON.stringify(await state()));
await click();
await sleep(2200);
console.log('   点击后（异步提交，应发送 1 次，诱饵未被写入）:', JSON.stringify(await state()), 'decoyHits=', await page.evaluate(() => window.__decoyHit || 0));

await sleep(2600);
await click();
await click();
await click();
await sleep(2200);
console.log('2) 快速连点三次（冷却应只发一次）:', JSON.stringify(await state()));

await page.evaluate(() => { document.getElementById('editor').innerText = '草稿'; committed = '草稿'; });
await sleep(900);
console.log('3) 有草稿:', JSON.stringify(await state()));
await click();
await sleep(600);
console.log('   点击后（不覆盖）:', JSON.stringify(await state()));

await page.evaluate(() => { document.getElementById('editor').innerText = ''; committed = ''; });
const b2 = await page.evaluate(() => {
  const b = document.createElement('button');
  b.id = 'mock-stop';
  b.setAttribute('data-testid', 'v4-stop');
  b.style.cssText = 'width:32px;height:32px';
  document.querySelector('.row').appendChild(b);
  return true;
});
await sleep(900);
console.log('4) 运行中:', JSON.stringify(await state()));
await click();
await sleep(600);
console.log('   点击后（不发送）:', JSON.stringify(await state()));
await page.evaluate(() => { document.getElementById('mock-stop').remove(); });
await sleep(2600);
await click();
await sleep(2200);
console.log('5) 运行结束后再点（应发送）:', JSON.stringify(await state()));

await browser.close();

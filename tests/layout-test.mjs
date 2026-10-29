// 用无头 Edge 跑一个模拟 ZCode 输入框工具栏的页面，验证 tokbar 的宽/窄两档布局与对齐
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
  .filler{height:2000px}
  .composer{padding:8px 12px}
  .card{border:1px solid #e5e5e5;border-radius:10px;padding:8px}
  textarea{display:block;width:100%;height:56px;border:0;outline:0;resize:none;font:14px system-ui}
  .row{display:flex;align-items:center;gap:8px;padding-top:6px;overflow:hidden}
  .left{display:flex;align-items:center;gap:6px}
  .shrink-0{flex-shrink:0}
  .ico{width:28px;height:28px;padding:0;border:0;background:#eee;border-radius:6px}
  .access{display:flex;align-items:center;height:28px;padding:0 8px;background:#eee;border-radius:6px;font-size:12px;color:#444}
  .model{height:28px;display:flex;align-items:center;padding:0 8px;border-radius:6px;background:#eee;font-size:12px;color:#444;flex-shrink:0;white-space:nowrap}
  .send{width:32px;height:32px;border:0;border-radius:50%;background:#222;flex-shrink:0}
</style></head><body>
<div class="app">
  <div class="scroller"><div class="filler">聊天内容</div></div>
  <div class="composer">
    <div class="card">
      <div class="field"><div class="field-inner"><textarea></textarea></div></div>
      <div class="row">
        <div class="left">
          <button class="ico" title="+">+</button>
          <div class="access shrink-0">完全访问</div>
        </div>
        <div class="model shrink-0">GLM-5.3-Flash ▾</div>
        <button class="send shrink-0" title="send"></button>
      </div>
    </div>
  </div>
</div>
<script>${snippet}<\/script>
</body></html>`;

fs.writeFileSync(path.join(here, 'layout-test.html'), html);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.goto('file:///' + path.join(here, 'layout-test.html').replace(/\\/g, '/'), { waitUntil: 'load' });

async function probe(width, label) {
  await page.setViewport({ width, height: 800 });
  await new Promise((r) => setTimeout(r, 3200)); // 等 tick()/ensure() 注入 + 2.5s 稳定期
  const r = await page.evaluate(() => {
    const bar = document.getElementById('zcode-tokbar');
    const row = bar ? bar.parentElement : null;
    const left = document.querySelector('.left');
    const model = document.querySelector('.model');
    const tok = document.getElementById('tokbar-tok');
    const rect = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    return {
      hasBar: !!bar,
      rowWidth: row ? row.clientWidth : null,
      bar: rect(bar),
      left: rect(left),
      model: rect(model),
      tokDisplay: tok ? tok.style.display : null,
      barText: bar ? bar.textContent : null,
    };
  });
  const overlapLeft = r.bar && r.left ? Math.max(0, r.left.right - r.bar.left) : null;
  const gapToModel = r.bar && r.model ? Math.round(r.model.left - r.bar.right) : null;
  console.log(`\n[${label}] viewport=${width} row=${r.rowWidth} hasBar=${r.hasBar}`);
  console.log('  bar:', r.bar && `x=${Math.round(r.bar.left)}..${Math.round(r.bar.right)} w=${Math.round(r.bar.width)}`);
  console.log('  left.right=', r.left && Math.round(r.left.right), '| overlap with left =', overlapLeft, 'px');
  console.log('  gap to model =', gapToModel, 'px | tok display =', JSON.stringify(r.tokDisplay));
  console.log('  text =', JSON.stringify((r.barText || '').replace(/\s+/g, ' ')));
  await page.screenshot({ path: path.join(here, `layout-${label}.png`), clip: { x: 0, y: 660, width: Math.min(width, 1400), height: 140 } });
  return { r, overlapLeft, gapToModel };
}

await probe(1148, 'wide');
await probe(850, 'mid');
await probe(620, 'narrow');
await probe(460, 'tiny');
await browser.close();

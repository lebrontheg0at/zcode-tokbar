// 把 agent 运行时（resources/glm/zcode.cjs）打上「空 thinking 块净化」补丁。
// —— zcode.cjs 是 ZCode 真正发模型请求的进程 bundle；桌面版直接用它（runtime: electron-node）。
// 追加式补丁：在文件末尾追加一段带标记的代码，重复运行会先删旧块再写新块（幂等）。
//
// 用法：
//   node agent-patch/install-agent-fix.mjs            安装/更新
//   node agent-patch/install-agent-fix.mjs --check    只检查
//   node agent-patch/install-agent-fix.mjs --restore  还原（用 .thinkingfix-bak）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const START = '/* ==== ZCODE_AGENT_PATCH_START (anthropic empty-thinking fix) ==== */';
const END = '/* ==== ZCODE_AGENT_PATCH_END ==== */';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BLOCK = fs.readFileSync(path.join(here, 'thinking-fix.js'), 'utf8');
const mode = process.argv.includes('--restore') ? 'restore'
  : process.argv.includes('--check') ? 'check' : 'install';

const cands = [
  process.env.ZCODE_AGENT_BUNDLE,
  process.env.ZCODE_EXE ? path.join(path.dirname(process.env.ZCODE_EXE), 'resources', 'glm', 'zcode.cjs') : null,
  'D:\\zcode\\resources\\glm\\zcode.cjs',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
].filter(Boolean);

const bundle = cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!bundle) {
  console.error('[X] 找不到 zcode.cjs（可用 ZCODE_AGENT_BUNDLE 指定路径）');
  process.exit(1);
}
const BAK = bundle + '.thinkingfix-bak';
console.log('bundle :', bundle);

const src = fs.readFileSync(bundle, 'utf8');
const hasStart = src.includes(START);
const hasEnd = src.includes(END);
console.log('size    :', src.length, '| 已打补丁:', hasStart && hasEnd);

if (mode === 'check') {
  console.log('备份存在:', fs.existsSync(BAK));
  process.exit(0);
}

if (mode === 'restore') {
  if (!fs.existsSync(BAK)) { console.error('[X] 没有备份:', BAK); process.exit(1); }
  fs.copyFileSync(BAK, bundle);
  console.log('[OK] 已还原');
  process.exit(0);
}

// 去掉旧块（标记成对出现时）
let base = src;
if (hasStart && hasEnd) {
  const i = base.indexOf(START);
  const j = base.indexOf(END) + END.length;
  base = base.slice(0, i) + base.slice(j);
} else if (hasStart || hasEnd) {
  console.error('[X] 补丁标记不成对，请先 --restore');
  process.exit(2);
}

if (!fs.existsSync(BAK)) fs.copyFileSync(bundle, BAK);

const next = base.replace(/\s+$/, '') + '\n\n' + BLOCK + '\n';
fs.writeFileSync(bundle, next, 'utf8');

// 语法校验：写坏了就回滚
try {
  execFileSync(process.execPath, ['--check', bundle], { stdio: 'pipe' });
} catch (e) {
  fs.copyFileSync(BAK, bundle);
  console.error('[X] 语法校验失败，已回滚:', String(e.stderr || e.message).slice(0, 400));
  process.exit(3);
}

console.log('[OK] 已写入补丁，大小', next.length, '（+', next.length - src.length, '字符）');
console.log('     日志： %TEMP%\\zcode-agent-thinking-fix.log');
console.log('     重启 ZCode 生效；还原： node agent-patch/install-agent-fix.mjs --restore');

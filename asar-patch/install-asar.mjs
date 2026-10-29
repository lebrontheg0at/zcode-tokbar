// 把 Token Bar 注入 ZCode 的 app.asar
//  —— 追加式补丁：不改动原有数据区，只更新头部里两个文件的 offset/size/integrity，
//     并把新内容追加到数据区末尾。原生模块（unpacked）完全不受影响。
//
// 用法（必须先完全退出 ZCode）：
//   node asar-patch/install-asar.mjs            安装
//   node asar-patch/install-asar.mjs --restore  还原
//   node asar-patch/install-asar.mjs --check    只检查状态
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';
import * as asar from '@electron/asar';

const MARK_MAIN = 'ZCode Toolkit — main process patch';
const MARK_RENDER = 'ZCode Toolkit — renderer patch';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SNIPPET_MAIN = fs.readFileSync(path.join(here, 'main-snippet.js'), 'utf8');
const SNIPPET_RENDER = fs.readFileSync(path.join(here, 'renderer-snippet.html'), 'utf8');

// 片段内容指纹：补丁升级后 hash 变化，安装器会自动从备份还原再重打（否则旧补丁会被误判成“已注入”）
const SNIPPET_HASH = crypto.createHash('sha256').update(SNIPPET_MAIN + '\u0000' + SNIPPET_RENDER).digest('hex').slice(0, 16);
const HASH_HTML = '<!-- tokbar-hash:' + SNIPPET_HASH + ' -->';
const HASH_MAIN = '/* tokbar-hash:' + SNIPPET_HASH + ' */';

const mode = process.argv.includes('--restore') ? 'restore'
  : process.argv.includes('--check') ? 'check'
  : 'install';

/* ---------------- 定位 ---------------- */

function findZCodeRoot() {
  if (process.env.TOKBAR_ASAR) return { asar: process.env.TOKBAR_ASAR };
  const cands = [];
  if (process.env.ZCODE_EXE) cands.push(process.env.ZCODE_EXE);
  cands.push(
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'ZCode.exe'),
    path.join(process.env.ProgramFiles || '', 'ZCode', 'ZCode.exe'),
    'C:\\zcode\\ZCode.exe',
    'D:\\zcode\\ZCode.exe'
  );
  for (const exe of cands) {
    if (!exe) continue;
    const res = path.join(path.dirname(exe), 'resources', 'app.asar');
    if (fs.existsSync(res)) return { asar: res };
  }
  return null;
}

function zcodeRunning() {
  try {
    return /ZCode\.exe/i.test(execSync('tasklist /fi "IMAGENAME eq ZCode.exe" /nh', { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

/* ---------------- 头部读写 ---------------- */

function readArchive(p) {
  const fd = fs.openSync(p, 'r');
  let headerSize, jsonSize;
  try {
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    headerSize = b.readUInt32LE(4);
    jsonSize = b.readUInt32LE(12);
    const raw = Buffer.alloc(jsonSize);
    fs.readSync(fd, raw, 0, jsonSize, 16);
    const json = JSON.parse(raw.toString('utf8'));
    return { headerSize, jsonSize, json, dataStart: 8 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function findEntry(json, relPath) {
  let n = json;
  for (const part of relPath.split('/')) {
    if (!n.files || !n.files[part]) return null;
    n = n.files[part];
  }
  return n;
}

function buildHeader(json) {
  const buf = Buffer.from(JSON.stringify(json), 'utf8');
  const paddedLen = Math.ceil(buf.length / 4) * 4;
  const pad = Buffer.alloc(paddedLen - buf.length, 0);
  const headerSize = paddedLen + 8;
  const pre = Buffer.alloc(16);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(headerSize, 4);
  pre.writeUInt32LE(headerSize - 4, 8);
  pre.writeUInt32LE(buf.length, 12);
  return { block: Buffer.concat([pre, buf, pad]), dataStart: 8 + headerSize };
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function integrityOf(buf) {
  const blockSize = 4194304;
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) blocks.push(sha256(buf.subarray(i, i + blockSize)));
  const hash = blocks.length === 1 ? blocks[0] : sha256(Buffer.concat(blocks.map((h) => Buffer.from(h, 'hex'))));
  return { algorithm: 'SHA256', hash, blockSize, blocks };
}

/* ---------------- 主流程 ---------------- */

const found = findZCodeRoot();
if (!found) {
  console.error('[X] 找不到 ZCode（可用 ZCODE_EXE 指定 ZCode.exe 的完整路径）');
  process.exit(1);
}
const ASAR = found.asar;
const BAK = ASAR + '.tokbar-bak';
console.log('app.asar :', ASAR);

if (mode === 'check') {
  const { json } = readArchive(ASAR);
  const e = findEntry(json, 'out/renderer/index.html');
  console.log('条目存在:', !!e);
  console.log('备份存在:', fs.existsSync(BAK));
  if (e) {
    const fd = fs.openSync(ASAR, 'r');
    const { dataStart } = readArchive(ASAR);
    const b = Buffer.alloc(e.size);
    fs.readSync(fd, b, 0, e.size, dataStart + Number(e.offset));
    fs.closeSync(fd);
    console.log('已注入:', b.toString('utf8').includes(MARK_RENDER));
  }
  process.exit(0);
}

if (!process.env.TOKBAR_ASAR && zcodeRunning()) {
  console.error('[X] ZCode 正在运行，app.asar 被占用。请先完全退出 ZCode。');
  process.exit(2);
}

if (mode === 'restore') {
  if (!fs.existsSync(BAK)) {
    console.error('[X] 没有备份:', BAK);
    process.exit(1);
  }
  if (fs.existsSync(ASAR)) fs.renameSync(ASAR, ASAR + '.tokbar-failed');
  fs.renameSync(BAK, ASAR);
  console.log('[OK] 已还原');
  process.exit(0);
}

/* ---- install ---- */

// --force：已有备份时先还原到备份，再按最新片段重打（用于修复补丁本身）
if (process.argv.includes('--force') && fs.existsSync(BAK)) {
  console.log('[force] 还原到备份后重打 ...');
  fs.copyFileSync(BAK, ASAR);
}


const { json, dataStart } = readArchive(ASAR);
const oldSize = fs.statSync(ASAR).size;
const oldDataSize = oldSize - dataStart;

const mainEntry = findEntry(json, 'out/main/index.js');
const htmlEntry = findEntry(json, 'out/renderer/index.html');
if (!mainEntry || !htmlEntry) {
  console.error('[X] 找不到目标文件条目');
  process.exit(1);
}

function readEntryBuf(entry) {
  const fd = fs.openSync(ASAR, 'r');
  try {
    const b = Buffer.alloc(entry.size);
    fs.readSync(fd, b, 0, entry.size, dataStart + Number(entry.offset));
    return b;
  } finally {
    fs.closeSync(fd);
  }
}

const oldMain = readEntryBuf(mainEntry).toString('utf8');
const oldHtml = readEntryBuf(htmlEntry).toString('utf8');

if (oldHtml.includes(MARK_RENDER)) {
  if (oldHtml.includes(HASH_HTML)) {
    console.log('[=] 已经注入过当前版本，无需重复。');
    process.exit(0);
  }
  // 补丁内容已更新：先还原到干净备份再重打，否则会在旧补丁上再叠一层
  if (fs.existsSync(BAK) && !process.env.TOKBAR_REFRESHED) {
    console.log('[refresh] 检测到片段已更新（hash ' + SNIPPET_HASH + '），从备份还原后重打 ...');
    fs.copyFileSync(BAK, ASAR);
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, TOKBAR_REFRESHED: '1' },
    });
    process.exit(r.status ?? 1);
  }
}

let newMain = oldMain;
if (!newMain.includes(MARK_MAIN)) {
  newMain += '\n\n/* ' + MARK_MAIN + ' */\n' + HASH_MAIN + '\n' + SNIPPET_MAIN + '\n';
}
if (!oldHtml.includes('</body>')) {
  console.error('[X] index.html 里没有 </body>，版本可能不兼容');
  process.exit(1);
}
const newHtml = oldHtml.replace('</body>', SNIPPET_RENDER + '\n' + HASH_HTML + '\n</body>');

const mainBuf = Buffer.from(newMain, 'utf8');
const htmlBuf = Buffer.from(newHtml, 'utf8');

// 追加位置
let cursor = oldDataSize;
mainEntry.offset = String(cursor);
mainEntry.size = mainBuf.length;
mainEntry.integrity = integrityOf(mainBuf);
cursor += mainBuf.length;

htmlEntry.offset = String(cursor);
htmlEntry.size = htmlBuf.length;
htmlEntry.integrity = integrityOf(htmlBuf);
cursor += htmlBuf.length;

const built = buildHeader(json);
const NEW = ASAR + '.tokbar-new';

console.log('[1/4] 生成新包 ...');
await new Promise(async (resolve, reject) => {
  const ws = fs.createWriteStream(NEW);
  ws.on('error', reject);
  ws.write(built.block);
  try {
    await pipeline(fs.createReadStream(ASAR, { start: dataStart }), ws, { end: false });
    ws.write(mainBuf);
    ws.write(htmlBuf);
    ws.end(resolve);
  } catch (e) {
    reject(e);
  }
});

console.log('[2/4] 校验 ...');
try {
  const gotHtml = asar.extractFile(NEW, 'out\\renderer\\index.html').toString('utf8');
  const gotMain = asar.extractFile(NEW, 'out\\main\\index.js').toString('utf8');
  if (!gotHtml.includes(MARK_RENDER) || !gotMain.includes(MARK_MAIN)) throw new Error('标记缺失');
  const list = asar.listPackage(NEW);
  console.log('    条目数:', list.length, '| 标记 OK');
} catch (e) {
  console.error('[X] 校验失败:', e.message);
  fs.rmSync(NEW, { force: true });
  process.exit(3);
}

console.log('[3/4] 备份 ...');
if (!fs.existsSync(BAK)) fs.copyFileSync(ASAR, BAK);

console.log('[4/4] 替换 ...');
fs.renameSync(ASAR, ASAR + '.tokbar-old');
fs.renameSync(NEW, ASAR);
fs.rmSync(ASAR + '.tokbar-old', { force: true });

console.log('\n[OK] 注入完成，启动 ZCode 即可看到速率条。');
console.log('     还原： node asar-patch/install-asar.mjs --restore');

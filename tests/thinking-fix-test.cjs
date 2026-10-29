// 校验 thinking-fix.js：空 thinking 块被剔除、其余请求原样透传
const path = require('node:path');
const fixPath = path.join(__dirname, '..', 'agent-patch', 'thinking-fix.js');

const calls = [];
globalThis.fetch = async function (input, init) {
  calls.push({ input: String(typeof input === 'string' ? input : input && input.url), init });
  return { ok: true, status: 200 };
};
const realFetch = globalThis.fetch;

require(fixPath);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}

(async () => {
  // 1) 空 thinking 被剔除，tool_use 保留
  const body1 = JSON.stringify({
    model: 'claude-haiku-5-5',
    thinking: { type: 'disabled' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: ' ', signature: '' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ],
  });
  await globalThis.fetch('https://api.commandcode.ai/provider/v1/messages', { method: 'POST', body: body1 });
  const sent1 = JSON.parse(calls.at(-1).init.body);
  ok('内容为空白 thinking 被移除', !JSON.stringify(sent1).includes('"thinking":" "'));
  ok('tool_use 保留', JSON.stringify(sent1).includes('"type":"tool_use"'));
  ok('消息条数不变', sent1.messages.length === 3, sent1.messages.length);

  // 2) 只有空 thinking 的整条消息被丢弃
  const body2 = JSON.stringify({
    model: 'x',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '\n  ', signature: 'abc' }] },
    ],
  });
  await globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: body2 });
  const sent2 = JSON.parse(calls.at(-1).init.body);
  ok('只剩空 thinking 的消息被丢弃', sent2.messages.length === 1, sent2.messages);

  // 3) 正常 thinking（有内容 + 有签名）保留
  const body3 = JSON.stringify({
    model: 'x',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'real thought', signature: 'sig' }, { type: 'text', text: 'hello' }] }],
  });
  await globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: body3 });
  const sent3 = JSON.parse(calls.at(-1).init.body);
  ok('正常 thinking 保留', JSON.stringify(sent3).includes('real thought'));

  // 3b) 有内容但签名为空 → 删除（跨模型推理块）
  const body3b = JSON.stringify({
    model: 'x',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '来自 GLM 的推理', signature: '' }, { type: 'tool_use', id: 't9', name: 'Bash', input: {} }] }],
  });
  await globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: body3b });
  const sent3b = JSON.parse(calls.at(-1).init.body);
  ok('无签名 thinking 被移除', !JSON.stringify(sent3b).includes('来自 GLM 的推理'));
  ok('同条消息的 tool_use 保留', JSON.stringify(sent3b).includes('"type":"tool_use"'));

  // 4) 非 /messages 的 URL 不动
  const body4 = JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: ' ' }] }] });
  await globalThis.fetch('https://api.anthropic.com/v1/complete', { method: 'POST', body: body4 });
  ok('非 /messages 请求原样透传', calls.at(-1).init.body === body4);

  // 5) 没有 thinking 的 body 不动
  const body5 = JSON.stringify({ messages: [{ role: 'user', content: 'plain' }] });
  await globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: body5 });
  ok('无 thinking 的请求原样透传', calls.at(-1).init.body === body5);

  // 6) 没有 body 的 GET 不报错
  await globalThis.fetch('https://api.anthropic.com/v1/messages');
  ok('无 body 调用正常', calls.at(-1).init === undefined);

  // 7) 原始 fetch 仍然是调用目标（返回我们伪造的 ok:true）
  const r = await globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: body1 });
  ok('仍然调用原始 fetch', r && r.ok === true);
  ok('原始 fetch 未被替换成自身', globalThis.fetch !== realFetch);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

/* ==== ZCODE_AGENT_PATCH_START (anthropic empty-thinking fix) ==== */
/*
 * ZCode 会把历史里的 reasoning 块原样回放给 Anthropic Messages API。
 * 从别的模型（deepseek/GLM 等）转过来的推理块内容是空白、或者虽然有内容但 signature 为空，
 * Anthropic 会直接 400：
 *   messages.N.content.0.thinking: each thinking block must contain non-whitespace thinking
 *   messages.N.content.0: Invalid `signature` in `thinking` block
 * 这里在全局 fetch 上做一次出站净化：把空白 / 无签名的 thinking、无数据的 redacted_thinking 剔除。
 * 只影响 body 里带 "thinking" 且 URL 以 /messages 结尾的 JSON 请求，其余请求原样透传。
 */
;(function () {
  try {
    if (globalThis.__zcodeThinkingFix) return;
    globalThis.__zcodeThinkingFix = true;

    var fs, logPath;
    try {
      fs = require('node:fs');
      logPath = require('node:path').join(require('node:os').tmpdir(), 'zcode-agent-thinking-fix.log');
    } catch (e) { }

    var orig = globalThis.fetch;
    if (typeof orig !== 'function') return;

    function log(msg) {
      try { if (fs) fs.appendFileSync(logPath, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { }
    }

    globalThis.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var body = init && init.body;
        if (typeof body === 'string' && body.indexOf('"thinking"') >= 0 && /\/messages(\?|$)/.test(String(url))) {
          var parsed = JSON.parse(body);
          if (parsed && Array.isArray(parsed.messages)) {
            var removed = 0, dropped = 0;
            var outMsgs = [];
            for (var i = 0; i < parsed.messages.length; i++) {
              var m = parsed.messages[i];
              if (m && Array.isArray(m.content)) {
                var kept = [];
                for (var j = 0; j < m.content.length; j++) {
                  var blk = m.content[j];
                  if (blk && blk.type === 'thinking') {
                    // 内容空白 → Anthropic 拒；签名缺失 → 报 Invalid signature。
                    // 跨模型（deepseek/GLM）带过来的推理块两者都不满足，整块丢掉。
                    if (!String(blk.thinking || '').trim() || !String(blk.signature || '').trim()) { removed++; continue; }
                  } else if (blk && blk.type === 'redacted_thinking') {
                    if (!String(blk.data || '').trim()) { removed++; continue; }
                  }
                  kept.push(blk);
                }
                if (kept.length !== m.content.length) {
                  if (kept.length === 0) { dropped++; continue; }  // 整条消息只剩空 thinking → 丢掉整条
                  m.content = kept;
                }
              }
              outMsgs.push(m);
            }
            if (removed || dropped) {
              parsed.messages = outMsgs;
              init = Object.assign({}, init, { body: JSON.stringify(parsed) });
              log('sanitized ' + url + ' removed=' + removed + ' droppedMessages=' + dropped);
            }
          }
        }
      } catch (e) { }
      return orig.call(this, input, init);
    };
  } catch (e) { }
})();
/* ==== ZCODE_AGENT_PATCH_END ==== */

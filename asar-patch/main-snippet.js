/* ===== ZCode Token Bar — main process patch (app.asar) =====
 * 只提供 /metrics 端点。截图触发通过 /metrics?shot=1 搭车（渲染层按钮设置标记后，
 * 下一次 /metrics 轮询带上参数，主进程看到后 spawn PowerShell 截图脚本）。
 */
;(async () => {
  try {
    const _fs = await import('node:fs');
    const _os = await import('node:os');
    const _path = await import('node:path');
    const _errLog = _path.join(_os.tmpdir(), 'zcode-tokbar-errors.log');
    const _log = (tag, e) => {
      try {
        _fs.appendFileSync(_errLog, new Date().toISOString() + ' [' + tag + '] ' + String(e && e.stack || e) + String.fromCharCode(10));
      } catch (e2) {}
    };
    process.on('uncaughtException', (e) => _log('uncaught', e));
    process.on('unhandledRejection', (e) => _log('rejection', e));

    const http = await import('node:http');
    const fs = _fs;
    const os = _os;
    const path = _path;
    const cp = await import('node:child_process');

    const PORT = 9335;
    const LOG_DIR = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
    const FILE_RE = /^model-io-.*\.jsonl$/;
    const TAIL = 3 * 1024 * 1024;
    const MAX_RECORDS = 800;

    const files = new Map();
    let records = [];

    function readRange(file, start, len) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.allocUnsafe(len);
        const n = fs.readSync(fd, buf, 0, len, start);
        return n === len ? buf : buf.subarray(0, n);
      } finally { fs.closeSync(fd); }
    }

    function poll() {
      let names = [];
      try { names = fs.readdirSync(LOG_DIR).filter((f) => FILE_RE.test(f)); } catch { return; }
      for (const n of names) {
        const file = path.join(LOG_DIR, n);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        let e = files.get(file);
        if (!e) {
          e = { offset: 0, rest: '' };
          files.set(file, e);
          if (st.size > TAIL) {
            const start = st.size - TAIL;
            const probe = readRange(file, start, Math.min(65536, st.size - start));
            const nl = probe.indexOf(0x0a);
            e.offset = nl >= 0 ? start + nl + 1 : start;
          }
        }
        if (st.size <= e.offset) continue;
        const buf = readRange(file, e.offset, st.size - e.offset);
        e.offset = st.size;
        const text = e.rest + buf.toString('utf8');
        const lines = text.split('\n');
        e.rest = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let d;
          try { d = JSON.parse(line); } catch { continue; }
          if (!d || d.type !== 'model_io') continue;
          const u = d.response && d.response.usage;
          if (!u) continue;
          records.push({
            completedAt: Date.parse(d.completedAt) || 0,
            durationMs: Number(d.durationMs) || 0,
            turnId: d.turnId || '',
            model: (d.model && d.model.modelId) || '?',
            provider: (d.model && d.model.providerId) || '?',
            inputTokens: Number(u.inputTokens) || 0,
            outputTokens: Number(u.outputTokens) || 0,
            cacheReadTokens: Number(u.cacheReadTokens) || 0,
            reasoningTokens: Number(u.reasoningTokens) || 0,
          });
        }
      }
      records.sort((a, b) => a.completedAt - b.completedAt);
      if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
    }

    function turns() {
      const map = new Map();
      const list = [];
      for (const r of records) {
        const key = r.turnId || '#' + r.completedAt;
        let t = map.get(key);
        if (!t) {
          t = { id: key, at: 0, calls: 0, out: 0, input: 0, cache: 0, reasoning: 0, ms: 0, model: r.model, provider: r.provider };
          map.set(key, t); list.push(t);
        }
        t.at = Math.max(t.at, r.completedAt);
        t.calls += 1; t.out += r.outputTokens; t.input += r.inputTokens;
        t.cache += r.cacheReadTokens; t.reasoning += r.reasoningTokens; t.ms += r.durationMs;
        t.model = r.model; t.provider = r.provider;
      }
      list.sort((a, b) => a.at - b.at);
      return list;
    }

    function metrics() {
      poll();
      const now = Date.now();
      if (!records.length) return { ok: false, message: '暂无模型调用记录', updatedAt: now };
      const list = turns();
      const last = list[list.length - 1];
      const tps = last.ms > 0 ? last.out / (last.ms / 1000) : 0;
      const cacheRate = last.input > 0 ? (last.cache / last.input) * 100 : 0;
      const history = list.slice(-30).map((t) => ({ t: t.at, tps: t.ms > 0 ? +(t.out / (t.ms / 1000)).toFixed(1) : 0 }));
      return {
        ok: true, turnId: last.id, calls: last.calls, durationMs: last.ms,
        tps: +tps.toFixed(1), cacheHitRate: +cacheRate.toFixed(1),
        inputTokens: last.input, outputTokens: last.out,
        cacheReadTokens: last.cache, reasoningTokens: last.reasoning,
        model: last.model, provider: last.provider,
        running: now - last.at < 4000,
        peak: +history.reduce((m, h) => Math.max(m, h.tps), 0).toFixed(1),
        turns: list.length,
        totalOutputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
        history, updatedAt: now,
      };
    }

    // 最小化/恢复 ZCode 窗口
    var WIN_PS = path.join(os.tmpdir(), 'zcode-tokbar-win.ps1');
    function ensureWinPs() {
      if (fs.existsSync(WIN_PS)) return;
      var L = String.fromCharCode(10);
      fs.writeFileSync(WIN_PS,
        'param([string]$mode)' + L +
        'Add-Type @' + "'" + L +
        'using System;using System.Runtime.InteropServices;' + L +
        'public class ZW{' + L +
        ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);' + L +
        ' [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);' + L +
        '}' + L +
        "'" + '@' + L +
        '$p = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }' + L +
        'if($p){' + L +
        '  if($mode -eq "min"){ $p | ForEach-Object { if(-not [ZW]::IsIconic($_.MainWindowHandle)){ [ZW]::ShowWindow($_.MainWindowHandle,6) } } }' + L +
        '  else{ $p | ForEach-Object { if([ZW]::IsIconic($_.MainWindowHandle)){ [ZW]::ShowWindow($_.MainWindowHandle,9) } } }' + L +
        '}' + L, 'utf8');
    }

    function triggerScreenshot(hide) {
      try {
        var sig = path.join(os.tmpdir(), 'zcode-tokbar-signal.ps1');
        var L = String.fromCharCode(10);
        fs.writeFileSync(sig,
          'try {' + L +
          '  [System.Threading.EventWaitHandle]::OpenExisting("Local\\ZCodeShotTrigger").Set()' + L +
          '  Write-Host "signaled"' + L +
          '} catch {' + L +
          '  Write-Host ("ERROR: " + $_.Exception.Message)' + L +
          '}' + L, 'utf8');

        var doSignal = function () {
          cp.exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + sig + '"',
            { timeout: 10000, windowsHide: true },
            function(err, stdout) {
              _log('shot', 'result: err=' + (err ? err.message : 'null') + ' out=' + String(stdout).trim());
            }
          );
        };

        if (hide) {
          // 先隐藏 → 等 500ms → 触发截图 → 等 2000ms → 恢复
          ensureWinPs();
          cp.exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + WIN_PS + '" -mode min',
            { timeout: 3000, windowsHide: true }, function() {});
          setTimeout(doSignal, 500);
          setTimeout(function () {
            cp.exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + WIN_PS + '" -mode restore',
              { timeout: 3000, windowsHide: true }, function() {});
          }, 2500);
        } else {
          doSignal();
        }
      } catch (e) { _log('screenshot', e); }
    }

    // ===== 智能压缩：生成摘要 → 新对话 → 粘贴到输入框（方案 B） =====
    var COMPACT_PS = path.join(os.tmpdir(), 'zcode-tokbar-compact.ps1');
    function ensureCompactPs() {
      if (fs.existsSync(COMPACT_PS)) return;
      var L = String.fromCharCode(10);
      fs.writeFileSync(COMPACT_PS, [
        'param([string]$text, [string]$title)',
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type @\'',
        'using System;using System.Runtime.InteropServices;',
        'public class ZW2{',
        ' [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
        ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);',
        ' [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
        ' [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
        '}',
        '\'@',
        '$p = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
        'if(-not $p){ Write-Host "ERROR: no ZCode window"; exit 1 }',
        'if([ZW2]::IsIconic($p.MainWindowHandle)){ [ZW2]::ShowWindow($p.MainWindowHandle,9) | Out-Null }',
        '[ZW2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
        'Start-Sleep -Milliseconds 600',
        'Set-Clipboard -Value $text',
        'Start-Sleep -Milliseconds 300',
        '[System.Windows.Forms.SendKeys]::SendWait("^(t)")',
        'Start-Sleep -Milliseconds 1200',
        '[System.Windows.Forms.SendKeys]::SendWait("^v")',
        'Start-Sleep -Milliseconds 500',
        'Write-Host "OK: summary pasted into new conversation"',
      ].join(L), 'utf8');
    }

    function generateSummary() {
      poll();
      var list = turns();
      if (!list.length) return null;
      var lines = [];
      lines.push('=== 会话上下文摘要（zcode-tokbar 生成） ===');
      lines.push('');
      lines.push('模型: ' + (records.length ? records[records.length-1].model : '?') + ' | 轮次: ' + list.length + ' | 调用: ' + records.length);
      lines.push('');
      // 按轮次摘要
      lines.push('--- 对话轮次时间线 ---');
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var tp = t.ms > 0 ? (t.out / (t.ms / 1000)).toFixed(0) : '0';
        lines.push('轮' + (i+1) + ': ' + t.calls + '次调用, ' + t.out + ' tok 输出, ' + Math.round(t.ms/1000) + 's, 缓存' + (t.input>0?Math.round(t.cache/t.input*100):0) + '%');
      }
      lines.push('');
      lines.push('--- 上下文统计 ---');
      lines.push('总输出 token: ' + records.reduce(function(s,r){return s+r.outputTokens;},0));
      lines.push('最新输入 token: ' + (list.length ? list[list.length-1].input : 0));
      lines.push('最新缓存命中: ' + (list.length ? list[list.length-1].cache : 0));
      lines.push('');
      lines.push('请基于以上摘要继续工作。');
      return lines.join(String.fromCharCode(10));
    }

    function smartCompact() {
      var summary = generateSummary();
      if (!summary) return JSON.stringify({ ok: false, message: '没有会话数据' });
      ensureCompactPs();
      try {
        cp.exec(
          'powershell -NoProfile -ExecutionPolicy Bypass -File "' + COMPACT_PS + '"' +
          ' -text "' + summary.replace(/"/g, '\\\\"') + '"' +
          ' -title "compact"',
          { timeout: 30000, windowsHide: false },
          function(err, stdout) { _log('compact', 'out=' + String(stdout).trim()); }
        );
        return JSON.stringify({ ok: true, summaryLength: summary.length });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e && e.message) });
      }
    }

    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      if (req.url && req.url.startsWith('/smartcompact')) {
        var result = smartCompact();
        res.end(result);
        return;
      }
      if (req.url && req.url.startsWith('/metrics')) {
        try {
          const q = req.url.indexOf('?');
          if (q > 0) {
            const params = new URLSearchParams(req.url.slice(q + 1));
            if (params.get('shot') === '1') {
              triggerScreenshot(params.get('hide') === '1');
            }
          }
        } catch (es) { _log('shot-param', es); }
        try {
          res.end(JSON.stringify(metrics()));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, message: String(e && e.message) }));
        }
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.on('error', () => {});
    server.listen(PORT, '127.0.0.1');
  } catch (e) {
    /* 静默 */
  }
})();

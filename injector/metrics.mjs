// 从 ZCode 的 model-io 日志读取真实用量，按「对话轮次(turnId)」聚合。
// 指标口径：
//   tps           = 上一轮所有模型调用的 outputTokens 之和 / durationMs 之和
//   cacheHitRate  = 上一轮 cacheReadTokens 之和 / inputTokens 之和
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const LOG_DIR = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
const FILE_RE = /^model-io-.*\.jsonl$/;
const TAIL_BYTES = 3 * 1024 * 1024;
const MAX_RECORDS = 800;

export class MetricsTracker {
  constructor() {
    this.files = new Map();
    this.records = [];
  }

  listFiles() {
    try {
      return fs.readdirSync(LOG_DIR).filter((f) => FILE_RE.test(f)).map((f) => path.join(LOG_DIR, f));
    } catch {
      return [];
    }
  }

  poll() {
    for (const file of this.listFiles()) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      let entry = this.files.get(file);
      if (!entry) {
        entry = { offset: 0, rest: '' };
        this.files.set(file, entry);
        if (st.size > TAIL_BYTES) {
          const start = st.size - TAIL_BYTES;
          const probe = readRange(file, start, Math.min(64 * 1024, st.size - start));
          const nl = probe.indexOf(0x0a);
          entry.offset = nl >= 0 ? start + nl + 1 : start;
        }
      }
      if (st.size <= entry.offset) continue;

      const buf = readRange(file, entry.offset, st.size - entry.offset);
      entry.offset = st.size;

      const text = entry.rest + buf.toString('utf8');
      const lines = text.split('\n');
      entry.rest = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d?.type !== 'model_io') continue;
        const u = d?.response?.usage;
        if (!u) continue;
        this.records.push({
          startedAt: Date.parse(d.startedAt) || 0,
          completedAt: Date.parse(d.completedAt) || 0,
          durationMs: Number(d.durationMs) || 0,
          turnId: d.turnId || '',
          model: d?.model?.modelId || '?',
          provider: d?.model?.providerId || '?',
          sessionId: d.sessionId || '',
          inputTokens: Number(u.inputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          cacheReadTokens: Number(u.cacheReadTokens) || 0,
          reasoningTokens: Number(u.reasoningTokens) || 0,
        });
      }
    }

    this.records.sort((a, b) => a.completedAt - b.completedAt);
    if (this.records.length > MAX_RECORDS) this.records = this.records.slice(-MAX_RECORDS);
    return this.records;
  }

  /** 按轮次聚合成数组（按时间序） */
  turns() {
    const map = new Map();
    const list = [];
    for (const r of this.records) {
      const key = r.turnId || `#${r.completedAt}`;
      let t = map.get(key);
      if (!t) {
        t = { id: key, at: 0, calls: 0, out: 0, input: 0, cache: 0, reasoning: 0, ms: 0, model: r.model, provider: r.provider };
        map.set(key, t);
        list.push(t);
      }
      t.at = Math.max(t.at, r.completedAt);
      t.calls += 1;
      t.out += r.outputTokens;
      t.input += r.inputTokens;
      t.cache += r.cacheReadTokens;
      t.reasoning += r.reasoningTokens;
      t.ms += r.durationMs;
      t.model = r.model;
      t.provider = r.provider;
    }
    list.sort((a, b) => a.at - b.at);
    return list;
  }

  metrics(now = Date.now()) {
    this.poll();
    if (!this.records.length) {
      return { ok: false, message: '还没有模型调用记录（先用 ZCode 跑一轮）', updatedAt: now };
    }

    const turns = this.turns();
    const last = turns[turns.length - 1];
    const tps = last.ms > 0 ? last.out / (last.ms / 1000) : 0;
    const cacheRate = last.input > 0 ? (last.cache / last.input) * 100 : 0;

    const history = turns.slice(-30).map((t) => ({
      t: t.at,
      tps: t.ms > 0 ? +(t.out / (t.ms / 1000)).toFixed(1) : 0,
    }));
    const peak = history.reduce((m, h) => Math.max(m, h.tps), 0);

    return {
      ok: true,
      // —— 上一轮对话的聚合 ——
      turnId: last.id,
      calls: last.calls,
      durationMs: last.ms,
      tps: +tps.toFixed(1),
      cacheHitRate: +cacheRate.toFixed(1),
      inputTokens: last.input,
      outputTokens: last.out,
      cacheReadTokens: last.cache,
      reasoningTokens: last.reasoning,
      // —— 上下文 ——
      model: last.model,
      provider: last.provider,
      running: now - last.at < 4000,
      idleMs: now - last.at,
      peak: +peak.toFixed(1),
      turns: turns.length,
      totalOutputTokens: this.records.reduce((s, r) => s + r.outputTokens, 0),
      history,
      updatedAt: now,
    };
  }
}

function readRange(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return n === len ? buf : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

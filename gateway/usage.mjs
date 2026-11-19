/**
 * 用量记录：按天分片追加 JSONL，与 OpenResolver 的 panel/usage.mjs 同构。
 *
 *   gateway/data/usage/2026-11-11.jsonl
 *
 * 每行一条请求：时间、密钥、供应商、模型、状态、token、耗时、是否换过家。
 * 只记聚合所需的字段，**不记请求内容**——这里落盘的是用量，不是对话。
 *
 * 追加写而不是读改写：网关是单进程多请求，`fs.appendFileSync` 在小行上足够，
 * 也不会因为进程被杀丢掉整天的数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { USAGE_DIR } from './config.mjs';

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fileFor(day) {
  return path.join(USAGE_DIR, `${day}.jsonl`);
}

export function createUsageRecorder({ dir = USAGE_DIR, enabled = true } = {}) {
  let ready = false;
  const ensure = () => {
    if (ready) return;
    fs.mkdirSync(dir, { recursive: true });
    ready = true;
  };

  return {
    enabled,
    get dir() {
      return dir;
    },
    record(entry) {
      if (!enabled) return;
      try {
        ensure();
        const ts = entry.ts ?? Date.now();
        const row = {
          ts,
          key: entry.keyId ?? null,
          keyName: entry.keyName ?? null,
          provider: entry.provider ?? null,
          model: entry.model ?? null,
          status: entry.status ?? 0,
          stream: entry.stream === true,
          inputTokens: entry.inputTokens ?? 0,
          outputTokens: entry.outputTokens ?? 0,
          cacheReadTokens: entry.cacheReadTokens ?? 0,
          durationMs: entry.durationMs ?? 0,
          attempts: entry.attempts ?? 1,
          error: entry.error ? String(entry.error).slice(0, 200) : undefined,
        };
        fs.appendFileSync(path.join(dir, `${dayKey(ts)}.jsonl`), `${JSON.stringify(row)}\n`);
      } catch {
        // 记用量失败绝不影响请求本身
      }
    },
    /** 最近 N 天的聚合（按天 × 供应商），供 `router gateway stats` 与 /v1/usage 使用。 */
    summarize({ days = 7, keyId = null } = {}) {
      const out = { days: [], totals: emptyTotals() };
      const today = Date.now();
      for (let i = days - 1; i >= 0; i--) {
        const day = dayKey(today - i * 86_400_000);
        const row = { day, ...emptyTotals(), providers: {} };
        for (const line of readLines(path.join(dir, `${day}.jsonl`))) {
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          if (keyId && r.key !== keyId) continue;
          const ok = r.status >= 200 && r.status < 400;
          row.requests += 1;
          if (!ok) row.errors += 1;
          row.inputTokens += r.inputTokens || 0;
          row.outputTokens += r.outputTokens || 0;
          row.durationMs += r.durationMs || 0;
          const p = (row.providers[r.provider] ??= { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 });
          p.requests += 1;
          if (!ok) p.errors += 1;
          p.inputTokens += r.inputTokens || 0;
          p.outputTokens += r.outputTokens || 0;
        }
        addTotals(out.totals, row);
        out.days.push(row);
      }
      out.totals.avgDurationMs = out.totals.requests
        ? Math.round(out.totals.durationMs / out.totals.requests)
        : 0;
      for (const d of out.days) {
        d.avgDurationMs = d.requests ? Math.round(d.durationMs / d.requests) : 0;
      }
      return out;
    },
  };
}

function emptyTotals() {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

function addTotals(into, from) {
  into.requests += from.requests;
  into.errors += from.errors;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.durationMs += from.durationMs;
}

function* readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) yield line;
  }
}

export { dayKey };

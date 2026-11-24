/**
 * token-limits（pi 版）— 给 pi 的所有模型套一层「上下文 / 输出」限额，并在接近上限时自动压缩。
 *
 * 与 opencode 的 `plugins/token-limits` 对齐：
 *   - 默认所有模型：上下文 300k、输出 32k；
 *   - `/limits` 查看当前生效值与压缩阈值；
 *   - `/limits 200k 32k` 改当前模型，`provider` / `all` 改一批；
 *   - 覆盖值存 `~/.pi/agent/token-limits.json`，重启仍在；
 *   - 输出上限在 `before_provider_request` 里兜底；
 *   - 上下文达到 `context - max(16k, 15% × context)` 时调用 pi 原生 `ctx.compact()`。
 *
 * pi 自己也有自动压缩，但它按模型自带的 contextWindow 算；模型表里的窗口常常是
 * 1M，等不到它触发。这里的阈值跟 opencode 插件一致，先一步压缩。
 *
 * 安装：`node router.mjs pi install`（或直接放到 ~/.pi/agent/extensions/token-limits/）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Field = "context" | "output";
type Limits = { context: number; output: number };
type Override = { context?: number; output?: number };
type Store = { version: 1; default: Limits; models: Record<string, Override> };
type Scope = "model" | "provider" | "all";

const DEFAULT_LIMITS: Limits = { context: 300_000, output: 32_000 };
const MIN: Limits = { context: 4_096, output: 256 };
const MAX: Limits = { context: 4_000_000, output: 1_048_576 };
const RESERVE_MIN = 16_000;
const RESERVE_RATIO = 0.15;
const COMPACT_COOLDOWN_MS = 30_000;

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
const STORE_FILE = path.join(AGENT_DIR, "token-limits.json");

const keyOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

function clamp(value: unknown, field: Field): number | undefined {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(MAX[field], Math.max(MIN[field], number));
}

function readStore(): Store {
  const fallback: Store = { version: 1, default: { ...DEFAULT_LIMITS }, models: {} };
  try {
    if (!existsSync(STORE_FILE)) return fallback;
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf8")) as Partial<Store>;
    const context = clamp(raw.default?.context, "context") ?? DEFAULT_LIMITS.context;
    const output = clamp(raw.default?.output, "output") ?? DEFAULT_LIMITS.output;
    const models: Record<string, Override> = {};
    for (const [key, value] of Object.entries(raw.models ?? {})) {
      if (!value || typeof value !== "object") continue;
      const entry: Override = {};
      const c = clamp((value as Override).context, "context");
      const o = clamp((value as Override).output, "output");
      if (c !== undefined) entry.context = c;
      if (o !== undefined) entry.output = o;
      if (entry.context !== undefined || entry.output !== undefined) models[key] = entry;
    }
    return { version: 1, default: { context, output }, models };
  } catch {
    return fallback;
  }
}

function writeStore(store: Store): void {
  try {
    mkdirSync(AGENT_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(tmp, STORE_FILE);
  } catch {
    // 写不了就只在本次运行里生效，不阻塞对话
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1))}k`;
  return String(n);
}

function parseSize(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(text.trim());
  if (!match) return null;
  const scale = match[2] ? (match[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  const value = Math.round(Number(match[1]) * scale);
  return value > 0 ? value : null;
}

/** 与 opencode token-limits 相同的压缩阈值：留 15%，但不低于 16k。 */
export function compactThreshold(context: number): number {
  return Math.max(0, context - Math.max(RESERVE_MIN, Math.round(context * RESERVE_RATIO)));
}

export default function tokenLimits(pi: ExtensionAPI) {
  const store = readStore();
  if (!existsSync(STORE_FILE)) writeStore(store);

  let lastCompaction = 0;

  const limitsFor = (model: { provider: string; id: string }): Limits => {
    const override = store.models[keyOf(model)];
    return {
      context: clamp(override?.context ?? store.default.context, "context") ?? DEFAULT_LIMITS.context,
      output: clamp(override?.output ?? store.default.output, "output") ?? DEFAULT_LIMITS.output,
    };
  };

  const statusText = (model: { provider: string; id: string }) => {
    const limits = limitsFor(model);
    return `ctx ${fmt(limits.context)} / out ${fmt(limits.output)} · 自动压缩 @${fmt(compactThreshold(limits.context))}`;
  };

  const refreshStatus = (ctx: ExtensionContext) => {
    if (ctx.model) ctx.ui.setStatus("token-limits", statusText(ctx.model));
  };

  const describe = (ctx: ExtensionContext) => {
    const model = ctx.model;
    if (!model) return "当前没有选中模型；先 /model 选一个再 /limits。";
    const limits = limitsFor(model);
    const override = store.models[keyOf(model)];
    const source = override ? "单项覆盖" : "默认（所有模型）";
    const lines = [
      `模型：${keyOf(model)}`,
      `生效：ctx ${fmt(limits.context)} / out ${fmt(limits.output)}（${source}）`,
      `模型自身：ctx ${fmt(model.contextWindow)} / out ${fmt(model.maxTokens)}`,
      `自动压缩：${fmt(compactThreshold(limits.context))}（context - max(16k, 15%)）`,
      `单项覆盖：${Object.keys(store.models).length} 个`,
    ];
    lines.push(
      "",
      "/limits 200k 32k      改当前模型",
      "/limits provider 300k 32k   改当前供应商",
      "/limits all 300k 32k  改默认（所有模型，清空单项覆盖）",
      "/limits reset         当前模型回默认",
      "/limits reset all     清空所有单项覆盖",
    );
    return lines.join("\n");
  };

  const maybeCompact = (ctx: ExtensionContext) => {
    const usage = ctx.getContextUsage();
    if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) return;
    if (!ctx.model) return;
    const limits = limitsFor(ctx.model);
    const threshold = compactThreshold(limits.context);
    if (usage.tokens < threshold) return;
    const now = Date.now();
    if (now - lastCompaction < COMPACT_COOLDOWN_MS) return;
    lastCompaction = now;
    if (ctx.hasUI) {
      ctx.ui.notify(`上下文 ${fmt(usage.tokens)} ≥ ${fmt(threshold)}，开始自动压缩`, "info");
    }
    ctx.compact({
      customInstructions: "保留最近的工作状态、已改文件与待办；压缩后继续当前任务。",
      onComplete: () => {
        if (ctx.hasUI) ctx.ui.notify("自动压缩完成", "info");
      },
      onError: (error) => {
        lastCompaction = 0;
        if (ctx.hasUI) ctx.ui.notify(`自动压缩失败：${error.message}`, "error");
      },
    });
  };

  const targetsOf = (ctx: ExtensionContext, scope: Scope): Array<{ provider: string; id: string }> => {
    const model = ctx.model;
    if (!model) return [];
    if (scope === "model") return [{ provider: model.provider, id: model.id }];
    const all = ctx.modelRegistry.getAll().filter((entry) =>
      scope === "all" ? true : entry.provider === model.provider,
    );
    return all.length ? all.map((entry) => ({ provider: entry.provider, id: entry.id })) : [{ provider: model.provider, id: model.id }];
  };

  const saveAndRefresh = (ctx: ExtensionContext) => {
    writeStore(store);
    refreshStatus(ctx);
    lastCompaction = 0;
    maybeCompact(ctx);
  };

  /** 把一次修改写进覆盖表：等于默认值的字段直接删掉，避免留下同值配置。 */
  const put = (key: string, patch: Override) => {
    const current: Override = { ...(store.models[key] ?? {}) };
    for (const field of ["context", "output"] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === store.default[field]) delete current[field];
      else current[field] = value;
    }
    if (current.context !== undefined || current.output !== undefined) store.models[key] = current;
    else delete store.models[key];
  };

  pi.on("session_start", async (event, ctx) => {
    refreshStatus(ctx);
    if (event.reason === "resume" || event.reason === "startup") maybeCompact(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    refreshStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshStatus(ctx);
    maybeCompact(ctx);
  });

  /** 输出上限兜底：provider 的 payload 字段名各不相同，见到哪个改哪个。 */
  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model) return;
    const payload = event.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") return;
    const output = limitsFor(ctx.model).output;
    let found = false;
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      const value = payload[field];
      if (typeof value === "number") {
        payload[field] = Math.min(value, output);
        found = true;
      }
    }
    // 模型定义没带输出上限时，补一个；已经有更小值的不抬高。
    if (!found) payload.max_tokens = output;
    return payload;
  });

  pi.registerCommand("limits", {
    description: "查看/调整上下文与输出限额（默认 300k / 32k，自动压缩）",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) {
        ctx.ui.notify(describe(ctx), "info");
        return;
      }

      let scope: Scope = "model";
      if (parts[0] === "provider" || parts[0] === "all") {
        scope = parts.shift() as Scope;
      }

      if (parts[0] === "reset") {
        if (parts[1] === "all" || parts[1] === "provider") scope = parts[1];
        if (scope === "all") {
          store.models = {};
          ctx.ui.notify(`已清空所有单项覆盖；全部模型回默认 ctx ${fmt(store.default.context)} / out ${fmt(store.default.output)}`, "info");
        } else if (scope === "provider") {
          const model = ctx.model;
          if (!model) {
            ctx.ui.notify("当前没有选中模型", "error");
            return;
          }
          for (const key of Object.keys(store.models)) {
            if (key.startsWith(`${model.provider}/`)) delete store.models[key];
          }
          ctx.ui.notify(`已清除 ${model.provider} 的单项覆盖`, "info");
        } else {
          const model = ctx.model;
          if (!model) {
            ctx.ui.notify("当前没有选中模型", "error");
            return;
          }
          delete store.models[keyOf(model)];
          ctx.ui.notify(`${keyOf(model)} 已回默认`, "info");
        }
        saveAndRefresh(ctx);
        return;
      }

      const context = parts[0] ? parseSize(parts[0]) : null;
      const output = parts[1] ? parseSize(parts[1]) : null;
      if ((parts[0] && context === null) || (parts[1] && output === null) || parts.length > 2) {
        ctx.ui.notify("用法：/limits [provider|all] [上下文] [输出]，例如 /limits 300k 32k", "error");
        return;
      }
      if (context === null && output === null) {
        ctx.ui.notify("至少给一个数值，例如 /limits 200k 或 /limits 300k 32k", "error");
        return;
      }
      const patch: Override = {
        ...(context !== null ? { context } : {}),
        ...(output !== null ? { output } : {}),
      };

      if (scope === "all") {
        store.default = {
          context: context ?? store.default.context,
          output: output ?? store.default.output,
        };
        store.models = {};
        ctx.ui.notify(`默认已改为 ctx ${fmt(store.default.context)} / out ${fmt(store.default.output)}；所有模型生效`, "info");
      } else {
        const targets = targetsOf(ctx, scope);
        if (!targets.length) {
          ctx.ui.notify("当前没有选中模型", "error");
          return;
        }
        for (const target of targets) put(keyOf(target), patch);
        ctx.ui.notify(
          `已更新 ${targets.length} 个模型：ctx ${fmt(context ?? limitsFor(targets[0]).context)} / out ${fmt(output ?? limitsFor(targets[0]).output)}`,
          "info",
        );
      }
      saveAndRefresh(ctx);
    },
  });
}
/**
 * credits.ts — 在 pi 里查看各家 AI 编程工具的积分余额与签到状态。
 *
 * 提供三样东西：
 *   /credits          斜杠命令，把整张表打到通知里
 *   /credits checkin  顺手把能签的都签了
 *   credits 工具      让模型也能查（"我还剩多少积分？"）
 *
 * 数据来源见 assets/quota.js：它只读本机已经在跑的服务与 pi 自己的凭证，
 * 不伪造设备身份、不改动任何登录态文件。
 *
 * 加载方式：放进 ~/.pi/agent/extensions/ 即可（pi 用 jiti，直接吃 TypeScript）。
 * 安装器会连同 quota.js 一起部署到 ~/.pi/agent/extensions/qodbuddy2pi/。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * quota.js 与本文件同目录。用 createRequire 而不是 import：那个文件是 CommonJS
 * （要能被 qoder2pi 这个纯 Node 脚本复用），ESM 的 import 拿不到它的命名导出。
 */
const requireCjs = createRequire(import.meta.url);
const quota = requireCjs(path.join(import.meta.dirname, "quota.js")) as {
  collectAll(opts?: { only?: string[] | null }): Promise<QuotaRow[]>;
  qoderClaim(provider: string): Promise<ClaimResult>;
  traeClaim(): Promise<ClaimResult>;
  codeartsClaim(): Promise<ClaimResult>;
  fmtNum(n: number | string): string;
  summarize(rows: QuotaRow[]): Summary;
  renderText(rows: QuotaRow[], opts?: { width?: number }): string;
  QODER_REGIONS: Record<string, { provider: string; title: string }>;
};

type QuotaBucket = {
  id: string;
  label: string;
  total: number | null;
  used: number | null;
  remaining: number;
  unit: string;
  detailUrl?: string | null;
};

type CheckinState = {
  supported: boolean;
  claimable?: boolean;
  claimed?: boolean;
  rewardCredits: number;
  currentStreakDays?: number;
  totalRewardCredits?: number;
  status?: string;
};

/**
 * 「多账号 + accounts[]」结构的账号行。Trae 与 CodeArts 都用它：
 *   Trae     剩/共/权益包/冷却/签到
 *   CodeArts 剩/共/套餐/即将过期/重置日
 */
type AccountRow = {
  id: string;
  name: string;
  remaining: number;
  total: number;
  used: number;
  unit: string;
  packs?: number;
  cooling?: boolean;
  disabled?: boolean;
  error?: string;
  checkin?: CheckinState;
  // CodeArts 专有
  package?: string;
  expiring?: number;
  resetDate?: string;
  status?: string;
};

type QuotaRow = {
  provider: string;
  title: string;
  available: boolean;
  kind?: string;
  reason?: string;
  detail?: string[];
  account?: string;
  plan?: string;
  buckets?: QuotaBucket[];
  accounts?: AccountRow[];
  checkin?: CheckinState | null;
  baseUrl?: string;
  fetchedAt?: string;
  serviceRunning?: boolean;
};

type ClaimResult = { ok: boolean; alreadyDone?: boolean; unsupported?: boolean; reason: string; rewardCredits?: number };
type Summary = { available: string[]; remaining: number; unit: string; claimable: Array<{ provider: string; account?: string; reward: number }> };

/** 只有 qoder 与 trae 有签到能力；workbuddy 没有这个概念。 */
/** 状态栏只需要 setStatus，这里收窄成一个最小接口，便于在回调之间传递。 */
type StatusCtx = { ui: { setStatus(key: string, text: string): void } };

const CLAIMABLE_PROVIDERS = new Set(["qoder-cn", "qoder", "trae", "codearts"]);

async function claimAll(rows: QuotaRow[]): Promise<{ lines: string[]; anyClaimed: boolean }> {
  const lines: string[] = [];
  let anyClaimed = false;
  for (const row of rows) {
    if (!row.available || !CLAIMABLE_PROVIDERS.has(row.provider)) continue;

    // CodeArts 的活动福利由它自己的网关负责领取（幂等，服务端会明确拒绝不能领的）
    if (row.provider === "codearts") {
      const res = await quota.codeartsClaim();
      lines.push(`[${row.title}] ${res.reason}`);
      if (res.ok && !res.alreadyDone) anyClaimed = true;
      continue;
    }

    // Trae 没有可用的单账号签到接口：如实说明，不去伪造设备身份
    if (row.provider === "trae") {
      const pending = (row.accounts || []).filter(
        (a) => !a.error && a.checkin && a.checkin.supported && !a.checkin.claimed,
      );
      if (pending.length === 0) {
        lines.push(`[${row.title}] 今日已签到（或签到已禁用），没有需要领的`);
      } else {
        const trae = await quota.traeClaim();
        const names = pending.map((a) => a.name).join("、");
        lines.push(`[${row.title}] ${names} 今日未签到；${trae.reason}`);
      }
      continue;
    }

    // Qoder 的活动没开时不必发请求
    if (row.checkin && !row.checkin.supported) {
      lines.push(`[${row.title}] 该区域当前没有每日签到活动`);
      continue;
    }
    const res = await quota.qoderClaim(row.provider);
    if (res.ok && !res.alreadyDone) anyClaimed = true;
    lines.push(`[${row.title}] ${res.reason}`);
  }
  return { lines, anyClaimed };
}

/** 把一行压成状态栏那么短。状态栏只有一行的空间，所以要极简。 */
/**
 * 状态栏那一行。
 *
 * 只显示**当前正在用的那一家**的余额，而不是把所有 provider 都堆上去——
 * 状态栏只有一行，堆四五家的数字既挤又没用：你此刻在用的只有一个。
 *
 * providerId 来自 ctx.model.provider（pi 的当前模型），取不到时退回「第一个可用的」。
 */
function statusLine(rows: QuotaRow[], providerId?: string): string {
  const usable = rows.filter((r) => r.available);
  if (usable.length === 0) return "积分不可用";

  // 优先当前 provider；它不可用时退回第一个能查到余额的
  const current = providerId ? usable.find((r) => r.provider === providerId) : undefined;
  const row = current || usable.find((r) => (r.accounts || r.buckets || []).length > 0) || usable[0];

  // 去掉括号里的补充说明（"Trae（免费积分）" → "Trae"），但保留词间空格
  const short = (t: string) => t.replace(/（.*?）/g, "").trim();
  let remaining = 0;
  if (row.kind === "trae" || row.kind === "codearts") {
    remaining = (row.accounts || []).filter((a) => !a.error).reduce((a, b) => a + Number(b.remaining || 0), 0);
  } else if (row.buckets) {
    // 只加 credits 桶：WorkBuddy 的天数不能和积分混在一起
    remaining = (row.buckets || []).filter((b) => b.unit === "credits").reduce((a, b) => a + Number(b.remaining || 0), 0);
  }

  const bits = [`${short(row.title)} ${quota.fmtNum(remaining)}`];
  // 顺带提一句「这家还能签到」，省得用户另外去翻
  if (row.checkin && row.checkin.supported && (row.checkin.claimable || row.checkin.supported && row.kind === "codearts")) {
    if (row.checkin.claimable) bits.push("可签到");
  }
  return bits.join(" · ");
}


const creditsTool = defineTool({
  name: "credits",
  label: "Credits",
  description:
    "Query the user's remaining credits/quotas and daily check-in status for Qoder, Trae, WorkBuddy, CodeArts, ZCode, Loomy, Raccoon, QwenWork, DuMate and WPS Lingxi. " +
    "Reads only local state (pi credentials and locally running proxies); never modifies login files. " +
    "Use it when the user asks how many credits they have left or whether today's check-in is done.",
  parameters: Type.Object({
    action: Type.Optional(
      Type.Unsafe<"status" | "checkin">({
        type: "string",
        enum: ["status", "checkin"],
        description: "'status' (default) lists balances and check-in state; 'checkin' also claims what can be claimed today.",
      }),
    ),
    provider: Type.Optional(
      Type.Unsafe<string>({
        type: "string",
        description: "Limit to one source: qoder-cn, qoder, trae, workbuddy, workbuddy-global, codearts, zcode, loomy, raccoon, qwenwork, dumate, lingxi.",
      }),
    ),
  }),

  async execute(_toolCallId, params) {
    const only = params.provider ? [params.provider] : null;
    const rows = await quota.collectAll({ only });
    const action = params.action === "checkin" ? "checkin" : "status";

    const parts: string[] = [quota.renderText(rows)];
    if (action === "checkin") {
      const { lines } = await claimAll(rows);
      parts.push("", "签到结果", ...lines);
    }
    const summary = quota.summarize(rows);
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: { rows, summary, action },
    };
  },
});

export default function creditsExtension(pi: ExtensionAPI) {
  pi.registerTool(creditsTool);

  pi.registerCommand("credits", {
    description: "查看各家积分余额与签到状态（/credits checkin 顺手签到）",
    getArgumentCompletions: (prefix) => {
      const words = ["checkin"];
      const hits = words.filter((w) => w.startsWith(prefix));
      return hits.length ? hits.map((w) => ({ value: w, label: w })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const wantCheckin = arg === "checkin" || arg === "签到";
      const only = [
        "qoder-cn", "qoder", "trae", "workbuddy", "workbuddy-global",
        "codearts", "zcode", "loomy", "raccoon", "qwenwork", "dumate", "lingxi",
      ].includes(arg) ? [arg] : null;

      const rows = await quota.collectAll({ only });
      const text = quota.renderText(rows);

      if (!wantCheckin) {
        ctx.ui.notify(text, "info");
        return;
      }

      const { lines } = await claimAll(rows);
      ctx.ui.notify(`${text}\n\n签到结果\n${lines.join("\n")}`, "info");
      // 领到了就顺手刷新一下状态栏上的数字
      if (ctx.mode === "tui") {
        const fresh = await quota.collectAll({ only });
        ctx.ui.setStatus("credits", statusLine(fresh, ctx.model?.provider));
      }
    },
  });

  /**
   * 状态栏常驻显示余额。
   *
   * 只在 session_start 时算一次：查余额要发网络请求，不该在每次渲染时跑。
   * 用户想看最新的就 /credits。查不到时状态栏留空，不占地方也不误报。
   */
  /**
   * 状态栏更新。
   *
   * 只在 session_start 算一次是不够的：那时 `ctx.model` 往往还没定下来，于是永远
   * 显示「第一个能查到余额的」那家，而不是你正在用的。所以在 `before_agent_start`
   * （每次运行前，此时 model 已确定）也更新一次。
   *
   * 查余额要发网络请求，因此用缓存：同一份结果 5 分钟内复用。
   */
  let cached: { rows: QuotaRow[]; at: number } | null = null;

  const refreshStatus = async (ctx: StatusCtx, providerId: string | undefined) => {
    const FRESH_MS = 5 * 60 * 1000;
    try {
      if (!cached || Date.now() - cached.at > FRESH_MS) {
        cached = { rows: await quota.collectAll(), at: Date.now() };
      }
      if (cached.rows.some((r) => r.available)) {
        ctx.ui.setStatus("credits", statusLine(cached.rows, providerId));
      }
    } catch {
      // 状态栏是锦上添花，失败就静默
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await refreshStatus(ctx as unknown as StatusCtx, ctx.model?.provider);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // 这里 model 一定已经定了，是「当前 provider」最可靠的取值点
    await refreshStatus(ctx as unknown as StatusCtx, ctx.model?.provider);
  });
}

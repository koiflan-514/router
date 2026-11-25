/**
 * 网关代理 + 网关 CLI 包装。
 *
 * - HTTP：代理 `127.0.0.1:8785` 的只读端点与模型刷新（05 §3.12–3.16）。
 * - CLI：`combos` / `free` / `local-answers` 及其写命令（05 §3.15/3.16/3.17）。
 * - 网关不可达 → `BACKEND_UNAVAILABLE`（retryable），让前端保留旧数据而不是白屏。
 * - 请求只带 `accept`；绝不转发浏览器的 Cookie/Origin/Authorization/x-panel-token（07 §8.2）。
 */

import {
  isComboRow,
  parseLocalAnswers,
  toCombo,
  toFreeProvider,
  toGatewayStatus,
  toGatewayUsage,
  toQuotaRow,
} from './normalize.mjs';
import { BridgeError, unavailable } from './cli.mjs';
import { sanitizeBounded } from './redact.mjs';

const SAFE_TOKEN = /^[A-Za-z0-9._:/-]{1,128}$/;
const COMBO_STRATEGIES = new Set(['fallback', 'round-robin']);

/** 网关不可达统一 502（任务要求），保留 retryable，避免页面白屏。 */
const gatewayUnavailable = (message) => new BridgeError('BACKEND_UNAVAILABLE', message, { http: 502, retryable: true });

export function createGateway({ cli, host = '127.0.0.1', port = 8785, timeoutMs = 8000 } = {}) {
  /** 只读 HTTP 调用；返回解析后的 JSON。 */
  async function call(pathname, { method = 'GET', body, timeout = timeoutMs } = {}) {
    const url = `http://${host}:${port}${pathname}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw gatewayUnavailable(`连不上本机网关（${host}:${port}）：${err?.message ?? err}`);
    }

    const text = await res.text().catch(() => '');
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (!res.ok) throw gatewayUnavailable(`网关返回 HTTP ${res.status}`);
        throw new BridgeError('CONTRACT_INVALID', '网关返回了无法解析的 JSON');
      }
    }

    if (res.status === 429) {
      throw new BridgeError('RATE_LIMITED', '网关限流（上游并发受限，不代表离线）', { retryable: true });
    }
    if (!res.ok) {
      const detail =
        json && typeof json === 'object'
          ? json.error?.message ?? json.message ?? ''
          : String(text).slice(0, 200);
      throw gatewayUnavailable(`网关返回 HTTP ${res.status}${detail ? `：${sanitizeBounded(detail, { maxLines: 1 }).text}` : ''}`);
    }
    return json;
  }

  return {
    host,
    port,
    call,

    /** 轻量探活；不可达返回 null（供 /api/health）。 */
    async health() {
      try {
        return await call('/health', { timeout: 2500 });
      } catch {
        return null;
      }
    },

    async status() {
      const raw = await call('/v1/gateway/status');
      return toGatewayStatus(raw);
    },

    async usage(days) {
      const n = Number.isFinite(days) ? days : 7;
      const raw = await call(`/v1/gateway/usage?days=${n}`);
      return toGatewayUsage(raw, n);
    },

    async balance() {
      // 额度采集要逐家打上游，个别 provider 的采集超时可达 24s（实测网关侧
      // /v1/gateway/balance 稳定 ~24s）。这里必须给足时间，否则额度接口会在
      // 采集完成前被 8s 的通用网关超时中止，真实模式下 /api/quota 永远 502。
      const raw = await call('/v1/gateway/balance', { timeout: 45_000 });
      const providers = Array.isArray(raw?.providers) ? raw.providers.map(toQuotaRow) : [];
      return {
        fetchedAt: typeof raw?.fetchedAt === 'string' ? raw.fetchedAt : new Date().toISOString(),
        providers,
      };
    },

    async models() {
      const raw = await call('/v1/models');
      return Array.isArray(raw?.data) ? raw.data : [];
    },

    async refreshModels() {
      return call('/v1/gateway/models/refresh', { method: 'POST', body: {} });
    },

    /** 从 `/v1/models` 派生降级链（结构化来源；05 §3.15 禁止正则解析 combo list 文本）。 */
    async combos() {
      const models = await this.models();
      return models.filter(isComboRow).map(toCombo);
    },

    /** 免费供应商：`node router.mjs providers list --json`（结构化）。 */
    async free() {
      const r = await cli.runRouter(['providers', 'list', '--json'], { timeoutMs: 20000 });
      const parsed = parseCliJson(r, '免费供应商');
      const rows = Array.isArray(parsed?.providers) ? parsed.providers : [];
      return rows.map(toFreeProvider);
    },

    /** 本地应答开关：`node router.mjs gateway local`（暂无 --json）。 */
    async localAnswers() {
      const r = await cli.runRouter(['gateway', 'local'], { timeoutMs: 15000 });
      if (r.spawnError) throw unavailable('无法运行网关 CLI');
      return parseLocalAnswers(r.stdout);
    },

    /**
     * `gateway combo add|rm`：写命令走 CLI，返回清理后的文本元数据。
     * 参数经白名单校验，argv 走参数数组，故不存在 shell 注入面。
     */
    async comboCommand({ op, name, models, strategy }) {
      if (!SAFE_TOKEN.test(String(name ?? ''))) {
        throw new BridgeError('BAD_REQUEST', '组合名只允许字母、数字、点、下划线、冒号、斜杠、连字符（≤128）');
      }
      if (op === 'add') {
        const list = Array.isArray(models) ? models : [];
        if (!list.length || !list.every((m) => SAFE_TOKEN.test(String(m)))) {
          throw new BridgeError('BAD_REQUEST', '每个模型链环节必须是 provider/model 形式的安全标识');
        }
        const strat = strategy ?? 'fallback';
        if (!COMBO_STRATEGIES.has(strat)) {
          throw new BridgeError('BAD_REQUEST', `strategy 只能是 ${[...COMBO_STRATEGIES].join(' / ')}`);
        }
        const r = await cli.runRouter(
          ['gateway', 'combo', 'add', '--name', String(name), '--models', list.map(String).join(','), '--strategy', strat],
          { timeoutMs: 20000 },
        );
        return textResult(r);
      }
      if (op === 'rm') {
        const r = await cli.runRouter(['gateway', 'combo', 'rm', String(name)], { timeoutMs: 20000 });
        return textResult(r);
      }
      throw new BridgeError('BAD_REQUEST', 'op 只能是 add 或 rm');
    },

    /** 额度快照刷新：`node router.mjs gateway refresh-quota`。 */
    async refreshQuota() {
      const r = await cli.runRouter(['gateway', 'refresh-quota'], { timeoutMs: 60000 });
      return textResult(r);
    },
  };
}

function textResult(r) {
  const bounded = sanitizeBounded(`${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`, { maxLines: 200 });
  return { ok: r.code === 0, exitCode: r.code, text: bounded.text, truncated: bounded.truncated };
}

/** 解析 CLI JSON；失败按契约/后端错误归类，不静默降级。 */
export function parseCliJson(r, label) {
  if (r.spawnError) {
    if (r.spawnError instanceof BridgeError) throw r.spawnError;
    throw unavailable(`${label}：无法启动子进程（${r.spawnError.message}）`);
  }
  if (r.timedOut) throw new BridgeError('TIMEOUT', `${label}：查询超时`, { retryable: true });
  const text = String(r.stdout ?? '').trim();
  if (!text) throw unavailable(`${label}：子进程没有输出（退出码 ${r.code}）`);
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError('CONTRACT_INVALID', `${label}：输出不是合法 JSON`);
  }
}

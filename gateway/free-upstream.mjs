/**
 * 云端免费供应商的上游调用。
 *
 * 与 `providers.mjs`（本机 10 家反代）的分工：
 *
 *   providers.mjs   本机端口，走 127.0.0.1，key 是占位值
 *   本文件          云端 HTTPS，key 是真凭据，可能被限流/封号/欠费
 *
 * 所以这里的每处都按「远端」处理：超时更短、错误分类更细、模型列表带缓存
 * （云端的 /models 可能几百 KB，不该每个请求拉一次）。
 */

import { BY_ID, resolveBaseUrl, needsSubstitution } from './free-providers.mjs';
import { providerKey, loadProviderStore } from './provider-keys.mjs';
import { createLimiter, resolveLimits, loadLimits, LimiterBusy } from '../integrations/limits/limiter.js';

/**
 * 免费供应商的本地限流器：一家一个，与调度器分开持有。
 *
 * 为什么在这里而不是调度器：`callFree` 也可能被 `/v1/models` 刷新等非调度路径调用；
 * 限流应该贴着「真正发请求」的地方，才不会漏。云端免费额度的风控比订阅更敏感——
 * 同一 key 并发 10 路，多数网关会直接临时封禁而不是只回 429。
 */
const freeLimiters = new Map();
function limiterOf(id) {
  if (!freeLimiters.has(id)) {
    freeLimiters.set(id, createLimiter(resolveLimits(id, loadLimits())));
  }
  return freeLimiters.get(id);
}

/** 模型列表缓存：云端 /models 很大，10 分钟足够。 */
const MODEL_TTL_MS = 10 * 60_000;
const modelCache = new Map();

/**
 * 组装请求头。
 *
 * 三件必须做对的事：
 *   1. 云端几乎都要 `Authorization: Bearer`，但个别（Cloudflare）要 `x-api-key`；
 *   2. 有的上游声明了固定 user-agent（kimchi），不带上会被拒；
 *   3. **不要**把本网关的 `zsk_` 密钥转发出去——那是我们自己的凭据。
 */
function headersFor(def, key) {
  const h = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    ...(def.headers || {}),
  };
  if (!key) return h;
  if (def.authHeader === 'x-api-key') h['x-api-key'] = key;
  else h.authorization = `Bearer ${key}`;
  return h;
}

/** 某家免费供应商的模型清单（带缓存，失败时回退上一次成功的）。 */
export async function freeModelsOf(id, { force = false, timeout = 8000, store, env } = {}) {
  const def = BY_ID.get(id);
  if (!def) return [];
  const hit = modelCache.get(id);
  if (!force && hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.models;

  const st = store ?? loadProviderStore();
  const baseUrl = resolveBaseUrl(def, st.providers, env);
  const key = providerKey(id, st, env);

  // 本机服务没有 key 也允许探测（装没装是另一回事）
  if (!def.local && !key) return hit ? hit.models : [];
  if (needsSubstitution({ baseUrl })) return hit ? hit.models : [];

  // 模型列表端点要跟着 baseUrl 走：覆盖成镜像/代理后还去拉官方地址，
  // 拿到的会是「官方有什么」而不是「这个端点有什么」——两者的模型 id 可能完全不同。
  const modelsUrl = modelsUrlFor(def, baseUrl, st.providers, env);
  if (!modelsUrl) return staticModels(def, hit);

  try {
    const res = await fetch(modelsUrl, {
      headers: headersFor(def, key),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const arr = Array.isArray(json) ? json : json?.data || json?.models || [];
    const models = arr
      .map((m) => {
        const mid = typeof m === 'string' ? m : m?.id || m?.name;
        if (!mid) return null;
        return {
          id: String(mid),
          name: String((m && (m.name || m.display_name)) || mid),
          context: Number((m && (m.context_length || m.context_window)) || 0) || null,
        };
      })
      .filter(Boolean);
    if (!models.length) throw new Error('模型清单为空');
    modelCache.set(id, { at: Date.now(), models });
    return models;
  } catch {
    return staticModels(def, hit);
  }
}

/**
 * 模型列表端点。
 *
 * 三档：
 *   1. 内置 `modelsUrl`（官方地址）
 *   2. **baseUrl 被覆盖过** → 用覆盖后的 baseUrl 拼 `/models`
 *   3. 都没有 → null（只认静态表）
 *
 * 第 2 档是必须的：覆盖 baseUrl 通常是为了走镜像或自建代理，那些端点的模型
 * id 与官方完全不同，继续拉官方列表会得到一份「看起来能选、实际调不通」的清单。
 */
function modelsUrlFor(def, baseUrl, overrides = {}, env = process.env) {
  const overridden = Boolean(overrides[def.id]?.baseUrl) || Boolean(def.baseUrlEnv && env[def.baseUrlEnv]);
  if (overridden) {
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/+$/, '')}/models`;
  }
  return def.modelsUrl || null;
}

/** 静态表兜底：没有 modelsUrl 或拉取失败时用它。 */
function staticModels(def, hit) {
  const declared = (def.models || []).map((m) => ({ id: m.id, name: m.name || m.id, context: m.context || null }));
  if (declared.length) return declared;
  // 只声明了免费模型名的情况：用 freeModels 兜底
  if ((def.freeModels || []).length) {
    return def.freeModels.map((id) => ({ id, name: id, context: null }));
  }
  return hit ? hit.models : [];
}

export function invalidateFreeModels(id) {
  if (id) modelCache.delete(id);
  else modelCache.clear();
}

/**
 * 发一次请求，**等到响应头**就返回。
 *
 * 和本机反代的差别：云端的超时更该短（60 秒足够任何一次首字节），
 * 因为等待的成本是用户时间，不是本机 CPU。
 */
export async function callFree({ id, dialect, body, signal, timeoutMs = 120_000, store, env }) {
  const def = BY_ID.get(id);
  if (!def) return { error: { kind: 'client', message: `未知免费供应商 ${id}`, status: 400 } };

  const st = store ?? loadProviderStore();
  const baseUrl = resolveBaseUrl(def, st.providers, env);
  const key = providerKey(id, st, env);

  if (!def.local && !key) {
    return { error: { kind: 'auth', message: `${def.name} 没有配置 key（${def.env}）`, status: 401 } };
  }
  if (needsSubstitution({ baseUrl })) {
    return { error: { kind: 'client', message: `${def.name} 的 baseUrl 还没替换：${def.needs || baseUrl}`, status: 400 } };
  }

  // 线协议不匹配时由调用方转换；这里只负责「发到正确的路径」
  const path = dialect === 'anthropic' ? '/messages' : '/chat/completions';
  const url = `${baseUrl}${path}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // 本地限流：在发请求之前取执行位。免费 key 被并发打爆的代价是「整段封禁」，
  // 比多等 2 秒糟得多，所以这里宁可排队/立刻 429。
  let release = null;
  try {
    release = await limiterOf(id).acquire({ signal, maxWaitMs: 5000 });
  } catch (err) {
    if (err?.name === 'AbortError') return { aborted: true };
    return {
      error: {
        kind: 'rate_limit',
        message: err instanceof LimiterBusy ? err.message : `本地限流：${err.message}`,
        status: 429,
        retryAfterMs: err?.retryAfterMs || 0,
        localLimit: true,
      },
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headersFor(def, key),
      body: JSON.stringify(body),
      signal: sig,
    });
    return { res, timeout };
  } catch (err) {
    if (signal?.aborted) return { aborted: true };
    const msg = timeout.aborted ? `${def.name} 在 ${timeoutMs}ms 内无响应` : `连不上 ${def.name}：${err.message}`;
    return { error: { kind: 'server', message: msg, status: timeout.aborted ? 504 : 502 } };
  } finally {
    release?.();
  }
}

/** 这条记录支不支持某个方言（决定要不要转换）。 */
export function freeSupports(id, dialect) {
  const def = BY_ID.get(id);
  if (!def) return false;
  if (def.format === 'anthropic-messages') return dialect === 'anthropic';
  // openai-chat / openai-responses 都走 chat/completions 路径
  return dialect === 'openai';
}

/**
 * 探活。
 *
 * **重要局限**：多数上游的 `/models` 不需要鉴权，所以「能拉到模型列表」只证明
 * **网络通、地址对**，不证明 key 有效。dsh 的文档把这叫「列表探测」并明确写了
 * 这个边界；这里照做，但把结论说清楚，不假装验证过 key。
 *
 * 想真验 key 只能花一次生成——那要消耗额度，所以做成可选（`deep: true`）。
 */
export async function probeFree(id, { store, env, timeout = 8000, deep = false } = {}) {
  const def = BY_ID.get(id);
  if (!def) return { ok: false, reason: `未知供应商 ${id}` };
  const models = await freeModelsOf(id, { force: true, store, env, timeout });
  if (!models.length) {
    const st = store ?? loadProviderStore();
    const key = providerKey(id, st, env);
    if (!def.local && !key) return { ok: false, reason: `缺 key（${def.env || '未声明'}）` };
    if (needsSubstitution({ baseUrl: resolveBaseUrl(def, st.providers, env) })) {
      return { ok: false, reason: def.needs || 'baseUrl 含占位符' };
    }
    return { ok: false, reason: '拿不到模型清单（网络不通 / 该家没提供 /models / 地址错）' };
  }
  // 只有明确要求时才花一次生成去验 key
  if (deep) {
    const r = await verifyKeyWithGeneration(def, models[0]?.id, { store, env, timeout });
    return { ok: r.ok, models, verified: r.ok, reason: r.reason };
  }
  return { ok: true, models, verified: false, note: '只验证了地址与网络；多数上游的 /models 不校验 key' };
}

/** 花一次最小生成验证 key。只有 --deep 时才调用。 */
async function verifyKeyWithGeneration(def, model, { store, env, timeout = 30_000 } = {}) {
  if (!model) return { ok: false, reason: '没有可用于验证的模型' };
  const st = store ?? loadProviderStore();
  const baseUrl = resolveBaseUrl(def, st.providers, env);
  const key = providerKey(def.id, st, env);
  if (!def.local && !key) return { ok: false, reason: '缺 key' };
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headersFor(def, key),
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, reason: `HTTP ${res.status}${text ? `：${text.slice(0, 100)}` : ''}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

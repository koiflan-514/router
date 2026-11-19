/**
 * 统一网关：一个端口，两种方言，九家反代。
 *
 * 端点：
 *   GET  /health                     探活（不需要密钥）
 *   GET  /v1/models                  `<provider>/<model>` + 裸模型名，按密钥白名单过滤
 *   POST /v1/messages                Anthropic Messages（含 SSE 流式）
 *   POST /v1/messages/count_tokens   本地估算
 *   POST /v1/chat/completions        OpenAI Chat Completions（含 SSE 流式）
 *   GET  /v1/gateway/status          调度快照（权重/冷却/并发/粘性）
 *   GET  /v1/gateway/usage?days=7    用量聚合
 *   GET  /v1/gateway/balance         各家额度（转发 router 的额度采集）
 *
 * 与 OpenResolver 的差别，都是因为 router 的下游是「别人的反代」而不是「自家池子」：
 *   - 供应商级调度，不是账号级（换账号要改文件+重启，见 scheduler.mjs 注释）；
 *   - 不做协议「统一到一家」，而是按上游能力挑方言：能原生就原生，少一层转换；
 *   - 失败换家时**先不写响应头**，所以客户端看到的永远是 200 + 一份完整流/JSON，
 *     而不是「200 之后流里塞一个错误」。
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import { HOST, PORT, loadConfig, ensureDataDirs, readJson, CONFIG_FILE } from './config.mjs';
import { authorize, clientIp, extractSecret, visibleProviders, AuthError } from './auth.mjs';
import { loadKeyDb, addUsedTokens, saveKeyDb, publicKey, hashSecret, keysFileMtime } from './keys.mjs';
import { createScheduler, sessionKeyOf } from './scheduler.mjs';
import { BY_ID, DESCRIPTORS, enabledIds, modelsOf, invalidateModels, upstreamKeyFor, allUpstreamIds, isFreeProvider, modelsOfAny, FREE_IDS } from './providers.mjs';
import { callFree, freeSupports, invalidateFreeModels } from './free-upstream.mjs';
import { resolveCandidates, RouteError } from './route.mjs';
import { sseEvents, parseData, sniffBody, readHead } from './sse.mjs';
import { classifyFailure, shouldRotate, FAILURE_SCOPE } from './failure.mjs';
import { repairToolPairing } from './pairing.mjs';
import {
  messagesToChat,
  errorBodyToAnthropic,
  openaiSseToAnthropicEvents,
  usageFromAnthropicEvent,
  usageFromOpenaiChunk,
  collectOpenaiSse,
  collectAnthropicSse,
  renderAnthropic,
  renderChat,
  normalizeOpenaiJson,
  normalizeAnthropicJson,
  ProtocolError,
} from './protocol.mjs';
import { estimateRequest } from './tokens.mjs';
import { createUsageRecorder } from './usage.mjs';
import { tryOptimizations, toMessagesResponse, toChatResponse } from './local-answer.mjs';
import { activeCombos, matchCombo } from './route.mjs';
import { advanceTurn, chainCapacity, comboCatalogRow } from './combo.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VERSION = '1.0.0';

/** 额度快照：`router gateway balance` 写、网关读。过期不参与权重（scheduler 会判）。 */
const QUOTA_FILE = path.join(import.meta.dirname, 'data', 'quota.json');

function json(res, status, payload, headers = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function apiError(res, status, message, { type = 'api_error', code } = {}, dialect = 'openai') {
  if (dialect === 'anthropic') {
    const body = { type: 'error', error: { type, message } };
    if (code) body.error.code = code;
    return json(res, status, body);
  }
  const body = { error: { message, type, code: code ?? null } };
  return json(res, status, body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`请求体超过 ${limit} 字节`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 上游状态码 → 调度器认识的错误类别。
 *
 * 保留这个薄封装是为了兼容 `selftest.mjs` 与外部调用方；真正的判断在
 * `failure.mjs`。它比原来的实现多识别四类：上下文溢出（重放无用）、
 * 过载（供应商级而非账号级）、以及 body 里写着中文/英文额度文案的 200/400。
 */
export function classify(status, text) {
  const verdict = classifyFailure({ status, body: text });
  return {
    kind: kindOfVerdict(verdict),
    message: verdict.message,
    verdict,
  };
}

/**
 * 把统一的 failure kind 映射成调度器的冷却桶。
 *
 * 调度器的桶是它自己的词汇（auth/quota/rate_limit/server/client），
 * 这里做一次翻译，避免 scheduler 依赖 failure 模块。
 */
function kindOfVerdict(verdict) {
  switch (verdict.kind) {
    case 'auth':
    case 'permission':
      return 'auth';
    case 'billing':
      return 'quota';
    case 'rate_limit':
    case 'overloaded':
      return 'rate_limit';
    case 'upstream':
    case 'timeout':
    case 'unavailable':
      return 'server';
    case 'context_window':
    case 'invalid_request':
    case 'aborted':
      return 'client';
    default:
      return verdict.retryable ? 'server' : 'client';
  }
}

// 换不换家由 `failure.mjs` 的 scope 决定，不再用一张固定表：
// request-scoped 的 4xx 换家必然复现，冷却它只会把健康连接摘出轮转。

export function createGateway({ config = loadConfig(), keyDb = loadKeyDb(), usage = null } = {}) {
  ensureDataDirs();
  const recorder = usage ?? createUsageRecorder();
  const ids = enabledIds();
  const quota = readJson(QUOTA_FILE, null);
  const scheduler = createScheduler({ ids, weights: config.weights, quota, settings: config.settings });

  const db = { ...keyDb };
  /**
   * 密钥库热加载。
   *
   * OpenResolver 的做法是「新建密钥后需重启网关」，这在 CLI 场景下很别扭：
   * 你刚 `key add` 出一条密钥，立刻 curl 却 401，很容易误判成密钥没生成。
   * 这里按 mtime 检测：文件一变就重读，只在**校验前**做一次 stat（微秒级）。
   *
   * 唯一要小心的是别把内存里累加的 usedTokens 覆盖掉：重读时按 id 合并回旧值，
   * 因为用量是运行时数据，文件里那份是上次落盘时的快照。
   */
  let keyMtime = keysFileMtime();
  function refreshKeys() {
    const mtime = keysFileMtime();
    if (mtime === keyMtime) return;
    keyMtime = mtime;
    const fresh = loadKeyDb();
    const used = new Map(db.keys.map((k) => [k.id, k.usedTokens || 0]));
    for (const k of fresh.keys) {
      if (used.has(k.id)) k.usedTokens = used.get(k.id);
    }
    db.keys = fresh.keys;
    db.version = fresh.version;
  }

  /** 用量累计是热路径，5 秒批量落盘一次；进程退出时再 flush。 */
  let dirty = false;
  const flushTimer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      // 落盘前先合并外部改动，避免把 CLI 刚删掉的密钥写回来
      refreshKeys();
      saveKeyDb(db);
      keyMtime = keysFileMtime();
    } catch {}
  }, 5000);
  flushTimer.unref?.();

  /**
   * 全部上游：本机 9 家（受 router.json 开关约束）+ 可用的免费供应商。
   *
   * 每次调用都重新算，并且**同步进调度器**：免费供应商的 key 是运行时配的
   * （`router providers key`），只在启动时建 runtime 会让「刚填了 key 却还是
   * 报所有供应商不可用」变成一个新的坑。
   */
  async function poolIds() {
    const local = enabledIds().filter((id) => BY_ID.has(id));
    const free = (await allUpstreamIds()).filter((id) => FREE_IDS.has(id));
    const all = [...local, ...free];
    scheduler.ensure(all);
    return all;
  }

  /** 所有鉴权入口都走这里：先热加载密钥库，再校验。 */
  function auth(opts) {
    refreshKeys();
    return authorize({ ...opts, db, config });
  }

  // ---------------------------------------------------------------- 上游调用

  function upstreamUrl(id, dialect) {
    const d = BY_ID.get(id);
    if (!d) return null;
    if (dialect === 'anthropic') return `http://127.0.0.1:${d.port}/v1/messages`;
    return `http://127.0.0.1:${d.port}/v1/chat/completions`;
  }

  function headersFor(id) {
    const key = upstreamKeyFor(id);
    const h = { 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  /** 上游是否原生支持这个方言。'both' 的优先原生，避免白转一层。 */
  function nativeDialect(id, dialect) {
    if (FREE_IDS.has(id)) return freeSupports(id, dialect);
    const d = BY_ID.get(id);
    if (!d) return false;
    return d.dialect === 'both' || d.dialect === dialect;
  }

  /**
   * 发一次请求并**等到响应头**。这一步成功之后才允许写客户端响应头，
   * 于是「换家」全部发生在这之前 —— 客户端永远看不到 5xx 之后再重试的痕迹。
   *
   * 两种上游：本机反代（固定端口、占位 key）与免费供应商（云端 HTTPS、真 key）。
   * 后者交给 free-upstream.mjs，因为它还要处理 baseUrl 覆盖与占位符。
   */
  async function callUpstream({ id, dialect, body, signal, stream }) {
    if (FREE_IDS.has(id)) {
      return callFree({ id, dialect, body, signal, timeoutMs: config.upstreamTimeoutMs });
    }
    const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetch(upstreamUrl(id, dialect, stream), {
        method: 'POST',
        headers: headersFor(id),
        body: JSON.stringify(body),
        signal: sig,
      });
      return { res, timeout };
    } catch (err) {
      if (signal?.aborted) return { aborted: true };
      const msg = timeout.aborted ? `上游 ${config.upstreamTimeoutMs}ms 内无响应` : `连接上游失败：${err.message}`;
      return { error: { kind: 'server', message: msg, status: timeout.aborted ? 504 : 502 } };
    }
  }

  // ---------------------------------------------------------------- 调度主循环

  /**
   * 在所有候选供应商之间做「先选家、再换家」。
   *
   * `attempt()` 拿到一个已确定的上游响应；返回 undefined 表示已接管（成功或不可重试），
   * 返回 `{ retry, cls }` 表示这一家失败、可以换下一家。
   */
  async function dispatch({ req, res, body, dialect, model, modelByProvider, candidates, combo, key, stream, ordered = false }) {
    const startedAt = Date.now();
    const stickyKey = sessionKeyOf({ req, body, keyId: key?.id });
    const tried = new Set();
    // 先把候选集同步进调度器：免费供应商的 runtime 是运行时才建的，
    // 不在这里 ensure 一次，pick() 会把它当作不存在，报「所有供应商暂不可用」。
    scheduler.ensure(candidates);
    // 候选数决定最多试几家：显式前缀只有 1 家 + fallbacks，裸模型名可能有很多家。
    // 上限仍受 maxAttempts 约束，避免一个请求把九家全试一遍。
    const maxAttempts = Math.max(1, Math.min(config.settings.maxAttempts, candidates.length || 1));
    let lastError = null;
    let attempts = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let acc = null;
      if (stickyKey && attempt === 0) {
        const bound = scheduler.stickyGet(stickyKey, { readyOnly: true });
        // pinned 模式下粘性只能钉在**首选**那家：否则用户写死 `trae-local/x`，
        // 却因为上一轮裸名请求把会话粘在 codearts 上而被悄悄转走。
        const allowed = ordered ? candidates.slice(0, 1) : candidates;
        if (bound && !tried.has(bound.id) && (allowed.length === 0 || allowed.includes(bound.id))) acc = bound;
        else scheduler.stickyClear(stickyKey);
      } else if (stickyKey && attempt > 0) {
        // 重试一律解绑：失败会话钉在同一家只会反复失败
        scheduler.stickyClear(stickyKey);
      }
      if (!acc) acc = scheduler.pick({ exclude: tried, allowFallback: attempt > 0, prefer: candidates, ordered });
      if (!acc) {
        // 一家都没选出来。最可能的原因是**全被本地限流挡住**（并发/速率）。
        // 这时不该立刻 429：限流器本身有排队能力，把「等多久」交给它的
        // `acquire({maxWaitMs})`，这里只负责挑一个候选并让下游去排。
        if (attempt === 0) {
          const info0 = scheduler.unavailableInfo();
          if (info0.localLimited) {
            const relaxed = scheduler.pick({
              exclude: tried,
              allowFallback: false,
              prefer: candidates,
              ordered,
              ignoreCapacity: true,
            });
            if (relaxed) {
              acc = relaxed;
            } else {
              lastError = {
                kind: 'rate_limit',
                message: '本机限额已满（并发或速率）',
                status: 429,
                localLimit: true,
                retryAfterMs: info0.soonestThrottleMs || 1000,
              };
              break;
            }
          } else {
            break;
          }
        } else {
          break;
        }
      }

      tried.add(acc.id);
      attempts += 1;
      const useDialect = nativeDialect(acc.id, dialect) ? dialect : dialect === 'anthropic' ? 'openai' : 'anthropic';
      // combo 的每一环可能指向不同的模型名：按链上位置取，否则用统一的 model。
      const attemptModel = pickModelFor(modelByProvider, acc.id, model);
      const upstreamBody = { ...body, model: attemptModel, stream };
      // 工具调用配对修复：两种方言共用同一处逻辑，且发生在**转换之前**。
      // 一段「有 tool_use 没有 tool_result」的历史会让上游 400，而因为历史不变，
      // 之后每一轮都会 400——这是本项目从 dsh-our-free-model 移植过来修的真 bug。
      const paired = repairToolPairing(upstreamBody.messages ?? []);
      const repaired = { ...upstreamBody, messages: paired };
      const payload =
        useDialect === dialect ? repaired : dialect === 'anthropic' ? messagesToChat(repaired) : repaired;

      // 本地限流：**在发请求之前**取执行位。这一步挡的是「并发/速率超了本机限额」，
      // 与上游 429 是两件事——后者已经产生了一次可疑请求，前者一次都不发出去。
      // 排队上限给 5 秒：超过就说明本地额度紧，宁可立刻 429 让客户端退避，
      // 也不要让 opencode/Claude Code 挂在这里等（它们的超时往往更短）。
      let release = null;
      const limiter = scheduler.limiterFor(acc.id);
      if (limiter) {
        try {
          release = await limiter.acquire({ signal: req.signal, maxWaitMs: 5000 });
        } catch (err) {
          if (err?.name === 'AbortError') return { aborted: true };
          // 本地限流：这一家暂时没额度，换下一家；都换不到就报 429
          lastError = {
            kind: 'rate_limit',
            message: err?.message || '本地限流',
            status: 429,
            localLimit: true,
            retryAfterMs: err?.retryAfterMs || 0,
          };
          continue;
        }
      }

      acc.inFlight += 1;
      let out;
      try {
        out = await callUpstream({ id: acc.id, dialect: useDialect, body: payload, signal: req.signal, stream });
      } catch (err) {
        acc.inFlight = Math.max(0, acc.inFlight - 1);
        release?.();
        throw err;
      }

      // 执行位要一直占到「响应体传完」为止，而不是响应头一到就还。
      // 流式对话可以持续几十秒，提前释放等于没有并发限制——上游看到的仍是 N 路并行。
      // `acc.inFlight` 同理，它是调度器判「这家还吃不吃得下」的依据。
      let released = false;
      const finishAttempt = () => {
        if (released) return;
        released = true;
        acc.inFlight = Math.max(0, acc.inFlight - 1);
        release?.();
        release = null;
      };

      if (out.aborted) {
        finishAttempt();
        return { aborted: true };
      }

      if (out.error) {
        finishAttempt();
        scheduler.onUpstreamError(acc, out.error);
        lastError = out.error;
        continue;
      }

      const up = out.res;
      const contentType = up.headers.get('content-type') || '';

      if (!up.ok) {
        const text = await up.text().catch(() => '');
        finishAttempt();
        // 完整判定：body 措辞优先于状态码，所以「HTTP 400 + exceed quota」会被认成额度
        const verdict = classifyFailure({
          status: up.status,
          body: text,
          level: acc.consecutiveFails,
        });
        const cls = { kind: kindOfVerdict(verdict), message: verdict.message, verdict };
        scheduler.onUpstreamError(acc, cls);
        if (stickyKey) scheduler.stickyClear(stickyKey);
        lastError = { ...cls, status: up.status, body: text, verdict };
        // request-scoped（上下文溢出、参数错）换家必然复现，直接结束
        if (!shouldRotate(verdict)) break;
        continue;
      }

      scheduler.onSuccess(acc);
      if (stickyKey) scheduler.stickySet(stickyKey, acc);
      // combo 的轮转游标推进：一个回合结束才推，失败换环不推进
      if (combo) advanceTurn(combo.id);

      const meta = {
        provider: acc.id,
        attempts,
        model: attemptModel,
        combo: combo?.name ?? null,
        upstreamDialect: useDialect,
        startedAt,
        key,
        stream,
      };
      try {
        await relay({ res, up, contentType, meta, dialect, stream });
      } finally {
        finishAttempt();
      }
      return { done: true, meta };
    }

    // 全失败：给一个能诊断的 429/502，而不是静默超时
    const info = scheduler.unavailableInfo();
    if (req.signal?.aborted) return { aborted: true };
    // 上下文溢出这类 request-scoped 故障要如实回它的状态码（400），不能包装成 429
    const requestScoped = lastError?.verdict?.scope === FAILURE_SCOPE.REQUEST;
    const status = requestScoped
      ? (lastError.status ?? 400)
      : lastError?.status && lastError.status < 500
        ? lastError.status
        : info.pool
          ? 429
          : 502;
    const message =
      lastError?.message ||
      (info.pool === 0 ? '没有可用供应商（先 node router.mjs up）' : '所有供应商暂不可用');
    // 本地限流和上游冷却的「恢复时间」是两个来源：前者是限流器算的，后者是冷却时间戳。
    const waitMs = Math.max(0, info.soonestRecovery ? info.soonestRecovery - Date.now() : 0);
    const localWaitMs = Math.max(0, info.soonestThrottleMs || 0, lastError?.retryAfterMs || 0);
    const hint = localWaitMs > 0 ? localWaitMs : waitMs;
    const suffix = hint > 0 ? `，约 ${Math.ceil(hint / 1000)} 秒后恢复` : '';
    // 本地限流要说清楚「是本机限额挡的」，否则用户会去查上游是不是挂了
    const prefix = lastError?.localLimit ? '本地限流：' : '';
    const detailText = lastError?.localLimit
      ? '本机限额（node router.mjs limits 可查/改）为避免上游判定异常流量而拦截了这次请求'
      : lastError?.body
        ? String(lastError.body).slice(0, 300)
        : null;
    return {
      failed: {
        status,
        message: `${prefix}${message}${suffix}`,
        type: status === 429 ? 'rate_limit_error' : 'api_error',
        detail: detailText,
        // 本地限流必须给 Retry-After：客户端据此退避，而不是立刻重试又撞一次
        retryAfterMs: status === 429 ? hint : 0,
      },
      meta: { startedAt, attempts, key, model, stream },
    };
  }

  // ---------------------------------------------------------------- 回写

  /**
   * 把上游响应写回客户端。
   *
   * 判断依据是**响应体形状**，不是 Content-Type。这条来自 dsh-our-free-model 的
   * `src/http.js`：它的车道会在高负载下以 `200 + application/json` 返回完整 SSE
   * 帧序列，按 header 判断就会把整条流读成字符串、JSON.parse 失败、整轮报废——
   * 而那个错误对象还带着 status 200，会让可用性探测把可用模型判成不可路由。
   *
   * 我在 Trae 上撞到的是同一个坑的另一种表现（无论 stream:false 都回 SSE），
   * 所以这里一律先嗅探首块（≤4KB），再决定怎么读：
   *
   *   客户端要流 + 上游是 SSE + 方言一致 → 逐帧 pipe，真流
   *   客户端要流 + 上游是 SSE + 需要转换 → 边读边转，仍是真流
   *   客户端要流 + 上游是 JSON → 合成为一份合法的 SSE（否则客户端会挂住）
   *   客户端不要流 → 读完聚合，渲染成目标方言的单个 JSON
   */
  async function relay({ res, up, contentType, meta, dialect, stream }) {
    const headers = {
      'x-router-provider': meta.provider,
      'x-router-attempts': String(meta.attempts),
      'x-router-upstream-dialect': meta.upstreamDialect,
    };

    // 先嗅探首块。这一步同时解决了「header 说谎」与「短回答后连接不关」两个问题：
    // readHead 一旦确认是 SSE 就立刻返回，不会等到超时。
    let head;
    try {
      head = await readHead(up.body, { timeoutMs: 15_000 });
    } catch {
      // 读不到首块：按最保守的方式当成空 JSON 处理
      head = null;
    }
    const shape = head ? sniffBody(head.text) : 'empty';
    const upstreamIsSse = shape === 'sse';
    headers['x-router-upstream-shape'] = shape;

    // ---- 客户端要流，上游也是 SSE
    if (stream && upstreamIsSse) {
      // head.text 是已经读掉的开头，必须接回 rest() 前面，否则前几帧会丢
      const frames = sseEvents(sseWithHead(head));

      if (meta.upstreamDialect === dialect) {
        res.writeHead(up.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          ...headers,
        });
        let usage = null;
        for await (const frame of frames) {
          const parsed = parseData(frame.data);
          const u = dialect === 'anthropic' ? usageFromAnthropicEvent(parsed) : usageFromOpenaiChunk(parsed);
          if (u) usage = { ...usage, ...u };
          res.write(`${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`);
        }
        res.end();
        recordUsage(meta, null, 'text/event-stream', usage);
        return;
      }

      // OpenAI 流 → Anthropic 流
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        ...headers,
      });
      let usage = null;
      try {
        for await (const ev of openaiSseToAnthropicEvents(frames, meta.model, {
          exposeReasoning: config.exposeReasoning === true,
        })) {
          const u = usageFromAnthropicEvent(ev);
          if (u) usage = { ...usage, ...u };
          res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        }
      } catch (err) {
        const ev = { type: 'error', error: { type: 'api_error', message: String(err?.message || '上游流中断') } };
        res.write(`event: error\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      res.end();
      recordUsage(meta, null, 'text/event-stream', usage);
      return;
    }

    // ---- 其余情况：读完整个响应体（上游是 JSON，或者根本没给内容）
    const restText = head ? await readAll(head) : '';
    const text = head ? head.text + restText : '';

    // 上游是 JSON 但客户端要流：合成为一份合法的 SSE，否则客户端会一直等
    if (stream && shape === 'json') {
      return relayJsonAsStream({ res, up, text, meta, dialect, headers });
    }

    let acc = null;
    if (upstreamIsSse) {
      // 客户端不要流但上游给了 SSE（Trae 的老问题）
      const frames = sseEvents(Readable.from([Buffer.from(text, 'utf8')]));
      acc =
        meta.upstreamDialect === 'anthropic'
          ? await collectAnthropicSse(frames, meta.model)
          : await collectOpenaiSse(frames, meta.model);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        res.writeHead(502, { 'content-type': 'application/json', ...headers });
        res.end(
          JSON.stringify(
            dialect === 'anthropic'
              ? { type: 'error', error: { type: 'api_error', message: '上游返回了无法解析的 JSON' } }
              : { error: { message: '上游返回了无法解析的 JSON', type: 'api_error' } },
          ),
        );
        return;
      }
      if (parsed?.error || parsed?.type === 'error') {
        res.writeHead(up.status, { 'content-type': 'application/json', ...headers });
        res.end(dialect === 'anthropic' ? JSON.stringify(errorBodyToAnthropic(up.status, text)) : JSON.stringify(parsed));
        return;
      }
      // 上游是 JSON 且方言一致：原样转发（保留上游额外字段）
      if (meta.upstreamDialect === dialect) {
        res.writeHead(up.status, { 'content-type': contentType || 'application/json', ...headers });
        res.end(text);
        recordUsage(meta, text, contentType);
        return;
      }
      acc =
        meta.upstreamDialect === 'anthropic'
          ? { ...emptyAcc(), ...normalizeAnthropicJson(parsed, meta.model) }
          : { ...emptyAcc(), ...normalizeOpenaiJson(parsed, meta.model) };
    }

    const payload =
      dialect === 'anthropic'
        ? renderAnthropic(acc, meta.model, { exposeReasoning: config.exposeReasoning === true })
        : renderChat(acc, meta.model);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(`${JSON.stringify(payload)}\n`);
    recordUsage(meta, null, 'application/json', {
      inputTokens: acc.usage.input_tokens || 0,
      outputTokens: acc.usage.output_tokens || 0,
      cacheReadTokens: acc.usage.cache_read_input_tokens || 0,
    });
  }

  /**
   * 上游回了 JSON，但客户端要流：把完整结果合成为一份合法的 SSE。
   *
   * 不这么做的话客户端会一直等 `message_stop` / `[DONE]`，表现为「请求挂住」。
   * 这不是理论问题：CodeArts 对部分模型、Trae 在某些路径上都会忽略 stream:true。
   */
  function relayJsonAsStream({ res, up, text, meta, dialect, headers }) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      res.writeHead(502, { 'content-type': 'application/json', ...headers });
      res.end(
        JSON.stringify(
          dialect === 'anthropic'
            ? { type: 'error', error: { type: 'api_error', message: '上游返回了无法解析的 JSON' } }
            : { error: { message: '上游返回了无法解析的 JSON', type: 'api_error' } },
        ),
      );
      return;
    }
    if (parsed?.error || parsed?.type === 'error') {
      res.writeHead(up.status, { 'content-type': 'application/json', ...headers });
      res.end(dialect === 'anthropic' ? JSON.stringify(errorBodyToAnthropic(up.status, text)) : JSON.stringify(parsed));
      return;
    }

    const acc =
      meta.upstreamDialect === 'anthropic'
        ? { ...emptyAcc(), ...normalizeAnthropicJson(parsed, meta.model) }
        : { ...emptyAcc(), ...normalizeOpenaiJson(parsed, meta.model) };

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      ...headers,
    });

    if (dialect === 'anthropic') {
      const message = renderAnthropic(acc, meta.model, { exposeReasoning: config.exposeReasoning === true });
      const write = (type, body) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
      write('message_start', { message: { ...message, content: [], stop_reason: null, stop_sequence: null } });
      for (const [index, block] of message.content.entries()) {
        if (block.type === 'tool_use') {
          write('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          write('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
        } else if (block.type === 'thinking') {
          write('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
          write('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
        } else {
          write('content_block_start', { index, content_block: { type: 'text', text: '' } });
          write('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
        }
        write('content_block_stop', { index });
      }
      write('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
      write('message_stop', {});
      res.end();
      recordUsage(meta, null, 'text/event-stream', {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens,
      });
      return;
    }

    // OpenAI：复用 renderChatAsChunks，再补 [DONE]
    const completion = renderChat(acc, meta.model);
    const choice = completion.choices[0];
    const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: meta.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: choice.message.content ?? '' }, finish_reason: null }] })}\n\n`);
    if (choice.message.tool_calls) {
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: choice.message.tool_calls.map((c, i) => ({ index: i, ...c })) }, finish_reason: null }],
        })}\n\n`,
      );
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: completion.usage })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    recordUsage(meta, null, 'text/event-stream', {
      inputTokens: completion.usage.prompt_tokens,
      outputTokens: completion.usage.completion_tokens,
      cacheReadTokens: 0,
    });
  }

  function recordUsage(meta, text, contentType, streamUsage = null) {
    let usage = streamUsage;
    if (!usage && text) {
      try {
        const j = JSON.parse(text);
        usage = {
          inputTokens: j?.usage?.prompt_tokens ?? j?.usage?.input_tokens ?? 0,
          outputTokens: j?.usage?.completion_tokens ?? j?.usage?.output_tokens ?? 0,
          cacheReadTokens: j?.usage?.prompt_tokens_details?.cached_tokens ?? j?.usage?.cache_read_input_tokens ?? 0,
        };
      } catch {
        usage = null;
      }
    }
    const tokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
    if (meta.key?.id && tokens) {
      if (addUsedTokens(db, meta.key.id, tokens)) dirty = true;
    }
    recorder.record({
      keyId: meta.key?.id ?? null,
      keyName: meta.key?.name ?? null,
      provider: meta.provider,
      model: meta.model,
      status: 200,
      stream: meta.stream === true,
      durationMs: Date.now() - meta.startedAt,
      attempts: meta.attempts,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
    });
    void contentType;
  }

  // ---------------------------------------------------------------- 路由处理

  async function handleModels(req, res) {
    const { key } = auth({ secret: extractSecret(req.headers), ip: clientIp(req) });
    const visible = visibleProviders(key, await poolIds());
    const rows = await Promise.all(visible.map(async (id) => ({ id, models: await modelsOfAny(id) })));
    const data = [];
    for (const row of rows) {
      for (const m of row.models) {
        data.push({
          id: `${row.id}/${m.id}`,
          object: 'model',
          created: 0,
          owned_by: row.id,
          name: m.name,
          // 裸模型名让客户端不必改配置就能跨供应商；同名模型只列一次
          aliases: [m.id],
          context_length: m.context,
          supports_vision: m.vision === true,
          supports_reasoning: m.reasoning === true,
        });
      }
    }
    const seen = new Set();
    const unique = data.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    // combo 作为虚拟模型行广播：客户端的选择器里能直接看到它，网关按名调用它。
    // 容量取交集（见 combo.mjs）：链头支持视觉不代表降级那一环也支持。
    for (const combo of activeCombos(config)) {
      const links = [];
      for (const link of combo.models) {
        try {
          const spec = splitModel(link);
          const models = spec.provider ? await modelsOf(spec.provider) : [];
          const hit = models.find((m) => m.id.toLowerCase() === spec.model.toLowerCase());
          if (hit) links.push({ contextWindow: hit.context, supportsTools: true });
        } catch {}
      }
      unique.push(comboCatalogRow(combo, chainCapacity(links)));
    }
    json(res, 200, { object: 'list', data: unique });
  }

  async function handleCountTokens(req, res) {
    const text = await readBody(req, config.maxBodyBytes);
    const body = safeParse(text);
    if (!body) return apiError(res, 400, '请求体不是合法 JSON', { type: 'invalid_request_error' }, 'anthropic');
    try {
      auth({ secret: extractSecret(req.headers), ip: clientIp(req), model: body.model });
    } catch (err) {
      return sendAuthError(res, err, 'anthropic');
    }
    json(res, 200, { input_tokens: estimateRequest(body) });
  }

  async function handleMessages(req, res) {
    const text = await readBody(req, config.maxBodyBytes);
    const body = safeParse(text);
    if (!body) return apiError(res, 400, '请求体不是合法 JSON', { type: 'invalid_request_error' }, 'anthropic');

    // ---- 本地应答：Claude Code 每轮都发的固定问题，答案就在请求体里。
    // 必须在调度之前拦下——转发出去等于用订阅额度换一个只有一个正确答案的问题。
    // 认证仍然要做（否则等于给免密钥开了个口子），但不需要解析模型。
    const local = tryLocalAnswer(req, res, body, 'anthropic');
    if (local) return local;

    let resolved;
    let key;
    try {
      resolved = await resolveCandidates(body.model, config);
      ({ key } = auth({
        secret: extractSecret(req.headers),
        ip: clientIp(req),
        provider: resolved.explicit || resolved.candidates[0],
        model: resolved.model,
      }));
    } catch (err) {
      return sendAuthError(res, err, 'anthropic');
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const out = await dispatch({
      req: { ...req, signal: controller.signal, headers: req.headers },
      res,
      body,
      dialect: 'anthropic',
      model: resolved.model,
      modelByProvider: resolved.modelByProvider,
      candidates: resolved.candidates,
      combo: resolved.combo,
      key,
      stream: body.stream === true,
      // pinned 与 combo 都由人定了顺序，不能被权重打乱；只有裸模型名走加权
      ordered: resolved.mode !== 'auto',
    });
    return finish(out, res, 'anthropic');
  }

  async function handleChatCompletions(req, res) {
    const text = await readBody(req, config.maxBodyBytes);
    const body = safeParse(text);
    if (!body) return apiError(res, 400, '请求体不是合法 JSON', { type: 'invalid_request_error' }, 'openai');

    const local = tryLocalAnswer(req, res, body, 'openai');
    if (local) return local;

    let resolved;
    let key;
    try {
      resolved = await resolveCandidates(body.model, config);
      ({ key } = auth({
        secret: extractSecret(req.headers),
        ip: clientIp(req),
        provider: resolved.explicit || resolved.candidates[0],
        model: resolved.model,
      }));
    } catch (err) {
      return sendAuthError(res, err, 'openai');
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const out = await dispatch({
      req: { ...req, signal: controller.signal, headers: req.headers },
      res,
      body,
      dialect: 'openai',
      model: resolved.model,
      modelByProvider: resolved.modelByProvider,
      candidates: resolved.candidates,
      combo: resolved.combo,
      key,
      stream: body.stream === true,
      ordered: resolved.mode !== 'auto',
    });
    return finish(out, res, 'openai');
  }

  /**
   * 本地应答拦截。
   *
   * 返回 `true` 表示已经写完响应（调用方直接 return），`null` 表示不适用、继续转发。
   * 认证放在最前面：免密钥只对回环生效，不能因为「这是本地问题」就跳过校验。
   */
  function tryLocalAnswer(req, res, body, dialect) {
    const enabled = config.localAnswers;
    // 全部显式关掉时才省掉检测开销。
    // 注意不能写 `Object.values(enabled).every(v => v === false)`：空对象的 every()
    // 返回 true，会让默认配置（`{}`）把整族优化全部跳过——这个 bug 让本地应答
    // 静默失效，表现为「配额探测还是打到了上游」。
    const values = Object.values(enabled || {});
    if (values.length && values.every((v) => v === false)) return null;

    const answer = tryOptimizations(body, { enabled });
    if (!answer) return null;

    try {
      auth({ secret: extractSecret(req.headers), ip: clientIp(req), model: body.model });
    } catch (err) {
      return sendAuthError(res, err, dialect);
    }

    const payload =
      dialect === 'anthropic' ? toMessagesResponse(answer, { model: body.model }) : toChatResponse(answer, { model: body.model });
    // 记一条用量，但标明是本地应答：这样 `gateway usage` 里的请求数对得上，
    // 又不会让 token 统计虚高（本地答案不消耗上游额度）。
    recorder.record({
      keyId: null,
      keyName: null,
      provider: 'local',
      model: body.model,
      status: 200,
      stream: false,
      durationMs: 0,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
    res.setHeader('x-router-local-answer', answer.kind);
    json(res, 200, payload);
    return true;
  }

  function finish(out, res, dialect) {
    if (out.aborted || out.done) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (out.failed) {
      // HTTP 头只能是 ASCII：上游的中文错误原文塞进 `x-router-error` 会让 writeHead
      // 直接抛 ERR_INVALID_CHAR，把一个本可诊断的 4xx 变成 500。
      // 这里转义成可打印 ASCII；完整原文在响应体里。
      const headers = out.failed.detail ? { 'x-router-error': asciiHeader(out.failed.detail) } : {};
      // 本地限流要带 Retry-After，客户端（OpenAI/Anthropic SDK）会照它退避
      if (out.failed.retryAfterMs > 0) {
        headers['retry-after'] = String(Math.max(1, Math.ceil(out.failed.retryAfterMs / 1000)));
      }
      if (dialect === 'anthropic') {
        res.writeHead(out.failed.status, { 'content-type': 'application/json', ...headers });
        res.end(
          `${JSON.stringify({ type: 'error', error: { type: out.failed.type, message: out.failed.message } })}\n`,
        );
        return;
      }
      res.writeHead(out.failed.status, { 'content-type': 'application/json', ...headers });
      res.end(
        `${JSON.stringify({ error: { message: out.failed.message, type: out.failed.type, code: null } })}\n`,
      );
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify({ error: { message: '网关内部错误', type: 'api_error' } })}\n`);
  }

  function sendAuthError(res, err, dialect) {
    if (err instanceof AuthError) {
      const type = err.type === 'permission_error' ? 'permission_error' : 'authentication_error';
      return apiError(res, err.status, err.message, { type, code: err.code }, dialect);
    }
    if (err instanceof RouteError) {
      const message = err.hint ? `${err.message}（${err.hint}）` : err.message;
      return apiError(res, err.status, message, { type: err.type }, dialect);
    }
    if (err instanceof ProtocolError) {
      return apiError(res, err.status, err.message, { type: err.type }, dialect);
    }
    console.error('[gateway] 未捕获错误:', err);
    return apiError(res, 500, '网关内部错误', { type: 'api_error' }, dialect);
  }

  // ---------------------------------------------------------------- 观测面

  function handleStatus(req, res) {
    let key = null;
    try {
      ({ key } = auth({ secret: extractSecret(req.headers), ip: clientIp(req) }));
    } catch (err) {
      return sendAuthError(res, err, 'openai');
    }
    const snap = scheduler.snapshot();
    json(res, 200, {
      ok: true,
      version: VERSION,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      settings: config.settings,
      strict: config.strict,
      key: key ? publicKey(key) : null,
      openMode: !key,
      providers: snap.map((s) => ({
        ...s,
        running: Boolean(BY_ID.get(s.id)),
        dialect: BY_ID.get(s.id)?.dialect ?? null,
        port: BY_ID.get(s.id)?.port ?? null,
      })),
      quotaSnapshotAt: quota?.at ?? null,
    });
  }

  function handleUsage(req, res, url) {
    try {
      auth({ secret: extractSecret(req.headers), ip: clientIp(req) });
    } catch (err) {
      return sendAuthError(res, err, 'openai');
    }
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') || 7)));
    json(res, 200, recorder.summarize({ days }));
  }

  async function handleBalance(req, res) {
    let key = null;
    try {
      ({ key } = auth({ secret: extractSecret(req.headers), ip: clientIp(req) }));
    } catch (err) {
      return sendAuthError(res, err, 'openai');
    }
    const quotaMod = await loadQuotaModule();
    if (!quotaMod) {
      return json(res, 501, { error: { message: '额度采集模块不可用（integrations/qodbuddy2pi/assets/quota.js）' } });
    }
    // 额度采集只覆盖本机 9 家（免费供应商的余额接口各家不同，且多数没有）
    const visible = visibleProviders(key, await poolIds()).filter((id) => BY_ID.has(id));
    try {
      const rows = await quotaMod.collectAll({ only: visible });
      json(res, 200, { fetchedAt: new Date().toISOString(), providers: rows });
    } catch (err) {
      json(res, 502, { error: { message: `额度采集失败：${err.message}` } });
    }
  }

  // ---------------------------------------------------------------- HTTP

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && (p === '/health' || p === '/healthz')) {
        return json(res, 200, { ok: true, version: VERSION, service: 'router-gateway', providers: await poolIds() });
      }
      if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) return await handleModels(req, res);
      if (req.method === 'POST' && p === '/v1/messages/count_tokens') return await handleCountTokens(req, res);
      if (req.method === 'POST' && p === '/v1/messages') return await handleMessages(req, res);
      if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
        return await handleChatCompletions(req, res);
      }
      if (req.method === 'GET' && (p === '/v1/gateway/status' || p === '/gateway/status')) return handleStatus(req, res);
      if (req.method === 'GET' && (p === '/v1/gateway/usage' || p === '/gateway/usage')) return handleUsage(req, res, url);
      if (req.method === 'GET' && (p === '/v1/gateway/balance' || p === '/gateway/balance')) {
        return await handleBalance(req, res);
      }
      if (req.method === 'POST' && (p === '/v1/gateway/models/refresh' || p === '/gateway/models/refresh')) {
        invalidateModels();
        invalidateFreeModels();
        const ids = await poolIds();
        const models = await Promise.all(
          ids.map(async (id) => ({ id, models: (await modelsOfAny(id, { force: true })).length })),
        );
        return json(res, 200, { ok: true, models });
      }
      return apiError(res, 404, `${req.method} ${p} 不存在`, { type: 'not_found_error' }, p.startsWith('/v1/messages') ? 'anthropic' : 'openai');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      return sendAuthError(res, err, p.startsWith('/v1/messages') ? 'anthropic' : 'openai');
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {}
  });

  return { server, scheduler, config, db, recorder, quotaFile: QUOTA_FILE };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把任意文本压成可放进 HTTP 头的 ASCII（非 ASCII 转成 \uXXXX 形式）。 */
function asciiHeader(text) {
  return String(text ?? '')
    .slice(0, 120)
    .replace(/[\r\n\t]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** 把 readHead 返回的剩余流读成字符串。 */
async function readAll(head) {
  let out = '';
  for await (const chunk of head.rest()) {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return out;
}

/**
 * 把 readHead 已读的开头 + 剩余流拼成一条完整的流。
 *
 * `head.text` 与 `head.rest()` 是互补的（rest 不重放已读字节），所以这里直接
 * 先产出开头、再产出 rest。SSE 路径必须走这个函数，否则已经读掉的首帧会丢。
 */
async function* sseWithHead(head) {
  if (head.text) yield head.text;
  yield* head.rest();
}

/** 归一化累加器的空壳：非流式路径从完整 JSON 构造它，字段与流式聚合保持一致。 */
function emptyAcc() {
  return { id: null, model: null, text: '', reasoning: '', toolCalls: [], finish: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } };
}

/**
 * combo 的每一环可能指向不同模型名：按「供应商 → 模型」映射取。
 * 映射里没有就用统一的 model，让上游自己给出「没有这个模型」的准确错误。
 */
function pickModelFor(modelByProvider, providerId, fallback) {
  if (!modelByProvider || typeof modelByProvider !== 'object') return fallback;
  return modelByProvider[providerId] ?? fallback;
}

/** 额度采集是 CommonJS 模块，懒加载：没有它网关也能正常转发。 */
let quotaModule = null;
async function loadQuotaModule() {
  if (quotaModule) return quotaModule;
  const candidates = [
    path.join(import.meta.dirname, '..', 'integrations', 'qodbuddy2pi', 'assets', 'quota.js'),
    path.join(os.homedir(), '.local', 'bin', 'quota.js'),
  ];
  for (const file of candidates) {
    try {
      readFileSync(file);
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      quotaModule = req(file);
      return quotaModule;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- 入口

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const gw = createGateway();
  gw.server.listen(PORT, HOST, () => {
    console.log(`[gateway] http://${HOST}:${PORT}  v${VERSION}`);
    console.log(`[gateway] providers: ${enabledIds().join(', ')}`);
    console.log(`[gateway] keys: ${gw.db.keys.length}  strict: ${gw.config.strict}  config: ${CONFIG_FILE}`);
  });
  const shutdown = () => {
    try {
      saveKeyDb(gw.db);
    } catch {}
    gw.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 让 hashSecret 在 --selftest 之外也有引用，避免打包工具把它判成未使用
  void hashSecret;
  void Readable;
}

export { VERSION, QUOTA_FILE };

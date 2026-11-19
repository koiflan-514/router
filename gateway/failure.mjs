/**
 * 统一的失败词汇与冷却策略。
 *
 * 移植自 dsh-our-free-model 的 `src/route/classify.js`（MIT），保留它的**两层职责**：
 *
 *   1. **这是什么故障**（kind / retryable / scope）—— 调用方据此决定重放、
 *      换家、还是直接告诉用户该做什么。
 *   2. **这家该冷却多久**（cooldownMs / backoff level）—— 避免一个坏凭据
 *      吃掉后面所有请求。
 *
 * 原实现把 FCC 的 `failure_policy`（词汇）和 9router 的 `ERROR_RULES`（时长）
 * 合并成一张表，规则是「文本规则先于状态码」：一个 body 里写着 "rate limit" 的
 * 400 就是限流，一个写着 "no credentials" 的 429 就是凭据失效。这条很重要——
 * 我原来的实现只看状态码，于是 ZCode 把「额度用尽」放在 HTTP 200/400 的 body 里
 * 时会被误判成 client error（不换家、不冷却）。
 *
 * 三条比原实现更贴合本项目的调整：
 *   - 保留中文关键词（`额度`、`余额不足`、`积分`），国内反代的错误文案是中文；
 *   - `scope` 保留原义，但 `account` 在本项目里对应「这家反代的当前账号」，
 *     所以冷却落在供应商级（scheduler 的冷却本来就是供应商级）；
 *   - 纯函数、无时钟无随机，便于单测。
 */

export const FAILURE_KIND = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  CONTEXT_WINDOW: 'context_window',
  AUTH: 'auth',
  PERMISSION: 'permission',
  BILLING: 'billing',
  RATE_LIMIT: 'rate_limit',
  OVERLOADED: 'overloaded',
  TIMEOUT: 'timeout',
  UPSTREAM: 'upstream',
  UNAVAILABLE: 'unavailable',
  ABORTED: 'aborted',
  UNKNOWN: 'unknown',
});

/** 故障发生在哪一层。决定「换家能不能解决」。 */
export const FAILURE_SCOPE = Object.freeze({
  /** 重放同一个请求必然复现：不冷却任何东西，直接报错给用户 */
  REQUEST: 'request',
  /** 这份凭据/账号坏了：冷却并换家 */
  ACCOUNT: 'account',
  /** 端点或这个模型坏了，不是请求的问题 */
  PROVIDER: 'provider',
  /** 上游短暂抖动：很快重试 */
  TRANSIENT: 'transient',
});

export const COOLDOWN_LONG_MS = 2 * 60_000;
export const COOLDOWN_SHORT_MS = 5_000;
export const TRANSIENT_COOLDOWN_MS = 30_000;
/** 上游自己报的 reset 时长也要封顶：有的上游报几小时，照做等于清空整条链。 */
export const MAX_PROVIDER_COOLDOWN_MS = 30 * 60_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 300_000;
export const BACKOFF_MAX_LEVEL = 15;

/**
 * 第 level 级的退避时长。
 *
 * 保留原实现的 `Math.max(0, level-1)` 保护：level 0 和 1 都给基础值，
 * 否则新账号第一次限流会得到一个亚秒级冷却、立刻又进轮转。
 */
export function backoffFor(level) {
  const numeric = typeof level === 'number' && Number.isFinite(level) ? Math.floor(level) : 0;
  const clamped = Math.min(Math.max(numeric, 1), BACKOFF_MAX_LEVEL);
  return Math.min(BACKOFF_BASE_MS * 2 ** (clamped - 1), BACKOFF_MAX_MS);
}

/**
 * 文本规则表，按顺序求值。
 *
 * 文本规则先于状态码：body 的措辞比状态码更具体。`kind`/`scope`/`retryable`
 * 是「这是什么故障」，`cooldownMs`/`backoff` 是「冷却多久」。
 */
const TEXT_RULES = Object.freeze([
  // 凭据没了：后面每个请求都会同样失败，所以冷却整家
  { text: 'no credentials', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  // Codex 风格的拒绝，刷新 token 就能好，所以只给 5 秒
  { text: 'request not allowed', cooldownMs: COOLDOWN_SHORT_MS, kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  // 上游拒绝的是它自己构造的 payload：账号侧路由坏了，不是用户的请求有问题
  { text: 'improperly formed request', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.INVALID_REQUEST, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  { text: 'rate limit', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: 'too many requests', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: 'quota exceeded', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: 'exceed quota', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  // 容量类措辞是供应商整体压力，不是某份凭据用尽
  { text: 'capacity', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true },
  { text: 'overloaded', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true },

  // ---- 中文文案（国内反代：Qoder / WorkBuddy / CodeArts / Loomy）
  { text: '额度不足', backoff: true, kind: FAILURE_KIND.BILLING, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: '余额不足', backoff: true, kind: FAILURE_KIND.BILLING, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: '积分不足', backoff: true, kind: FAILURE_KIND.BILLING, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: '额度用尽', backoff: true, kind: FAILURE_KIND.BILLING, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: '已达上限', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: '并发会话数', cooldownMs: COOLDOWN_SHORT_MS, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { text: '凭证失效', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  { text: '请重新登录', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },

  // 状态码规则（文本没命中时才走）
  { status: 401, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  { status: 402, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.BILLING, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  { status: 403, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  { status: 404, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
  { status: 429, backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
]);

/** 结构化 code/type 判别符比裸状态码更具体，优先于状态码规则。 */
const CODE_VERDICTS = Object.freeze({
  aborted: { kind: FAILURE_KIND.ABORTED, scope: FAILURE_SCOPE.REQUEST, retryable: false, cooldownMs: 0 },
  timeout: { kind: FAILURE_KIND.TIMEOUT, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  transport: { kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  server: { kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  stream_cut: { kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  empty_response: { kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  client_error: { kind: FAILURE_KIND.INVALID_REQUEST, scope: FAILURE_SCOPE.REQUEST, retryable: false, cooldownMs: 0 },
  invalid_credential: { kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS },
  invalid_api_key: { kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS },
  unauthorized: { kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS },
  permission_denied: { kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS },
  forbidden: { kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS },
  rate_limit: { kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true, backoff: true },
  // 这个装法重试不掉：闸门要重新登录才开，所以不冷却、也不该换家
  region_blocked: { kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.PROVIDER, retryable: false, cooldownMs: 0 },
  authorization_required: { kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.PROVIDER, retryable: false, cooldownMs: 0 },
  lane_locked: { kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.PROVIDER, retryable: false, cooldownMs: 0 },
});

/** 上下文溢出单独成类：重放同样的字节永远救不了，只能缩小请求或换大窗口。 */
const CONTEXT_WINDOW_CODES = Object.freeze(['context_length_exceeded', 'model_context_window_exceeded']);
const CONTEXT_WINDOW_MARKERS = Object.freeze([
  'context_length_exceeded',
  'maximum context length',
  'context window exceeded',
  'exceeds the context window',
  'prompt is too long',
  '上下文长度',
  '超出上下文',
]);

/** 没有可用状态码时，靠 body 里的结构化标记判别。 */
const MARKER_RULES = Object.freeze([
  { marker: 'rate_limit', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true },
  { marker: 'resourceexhausted', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true },
  { marker: 'resource exhausted', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true },
  { marker: 'resource_exhausted', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true },
  { marker: 'limit reached', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true },
  { marker: 'internal_server_error', cooldownMs: TRANSIENT_COOLDOWN_MS, kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true },
  { marker: 'internal server error', cooldownMs: TRANSIENT_COOLDOWN_MS, kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true },
  { marker: 'model_not_found', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.ACCOUNT, retryable: false },
]);

const OVERLOAD_STATUSES = Object.freeze([502, 503, 504, 529]);

function verdictOf(kind, scope, options = {}) {
  return {
    kind,
    scope,
    retryable: options.retryable === true,
    cooldownMs: options.cooldownMs ?? 0,
    cooldownLevel: options.cooldownLevel ?? 0,
    rule: options.rule ?? 'default',
  };
}

function backoffOf(kind, scope, level, rule) {
  const cooldownLevel = Math.min(Math.max(0, level) + 1, BACKOFF_MAX_LEVEL);
  return verdictOf(kind, scope, {
    retryable: true,
    cooldownMs: backoffFor(cooldownLevel),
    cooldownLevel,
    rule,
  });
}

function normalizeLevel(level) {
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

function normalizeStatus(status) {
  if (Number.isInteger(status)) return status;
  if (typeof status === 'string' && /^\d{1,3}$/.test(status.trim())) return Number(status.trim());
  return undefined;
}

function bodyTextOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function failureText(message, body, code) {
  const parts = [];
  const messageText = typeof message === 'string' ? message : bodyTextOf(message);
  if (messageText !== '') parts.push(messageText);
  if (typeof code === 'string' && code !== '') parts.push(code);
  const bodyText = bodyTextOf(body);
  if (bodyText !== '') parts.push(bodyText);
  return parts.join(' ').toLowerCase();
}

function bodyCandidates(body) {
  if (typeof body === 'string') {
    try {
      return bodyCandidates(JSON.parse(body));
    } catch {
      return [body];
    }
  }
  if (body === null || typeof body !== 'object') return [body];
  const nested = body.error;
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? [body, nested] : [body];
}

function failureCodes(code, body) {
  const found = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim().toLowerCase();
    if (trimmed !== '' && !found.includes(trimmed)) found.push(trimmed);
  };
  add(code);
  for (const candidate of bodyCandidates(body)) {
    if (candidate === null || typeof candidate !== 'object') continue;
    add(candidate.code);
    add(candidate.type);
  }
  return found;
}

function contextWindowVerdict(codes, text) {
  const named = codes.some((code) => CONTEXT_WINDOW_CODES.includes(code));
  const described = CONTEXT_WINDOW_MARKERS.some((marker) => text.includes(marker));
  if (!named && !described) return null;
  return verdictOf(FAILURE_KIND.CONTEXT_WINDOW, FAILURE_SCOPE.REQUEST, { rule: 'context-window' });
}

function textRuleVerdict(text, level) {
  if (text === '') return null;
  for (const rule of TEXT_RULES) {
    if (rule.text === undefined || !text.includes(rule.text)) continue;
    if (rule.backoff === true) return backoffOf(rule.kind, rule.scope, level, `text:${rule.text}`);
    return verdictOf(rule.kind, rule.scope, {
      retryable: rule.retryable,
      cooldownMs: rule.cooldownMs,
      rule: `text:${rule.text}`,
    });
  }
  return null;
}

function codeVerdict(codes, level) {
  for (const code of codes) {
    const rule = CODE_VERDICTS[code];
    if (rule === undefined) continue;
    if (rule.backoff === true) return backoffOf(rule.kind, rule.scope, level, `code:${code}`);
    return verdictOf(rule.kind, rule.scope, {
      retryable: rule.retryable,
      cooldownMs: rule.cooldownMs,
      rule: `code:${code}`,
    });
  }
  return null;
}

function statusRuleVerdict(status, level) {
  if (status === undefined) return null;
  for (const rule of TEXT_RULES) {
    if (rule.status === undefined || rule.status !== status) continue;
    if (rule.backoff === true) return backoffOf(rule.kind, rule.scope, level, `status:${status}`);
    return verdictOf(rule.kind, rule.scope, {
      retryable: rule.retryable,
      cooldownMs: rule.cooldownMs,
      rule: `status:${status}`,
    });
  }
  return null;
}

function markerVerdict(text, level) {
  if (text === '') return null;
  for (const rule of MARKER_RULES) {
    if (!text.includes(rule.marker)) continue;
    if (rule.backoff === true) return backoffOf(rule.kind, rule.scope, level, `marker:${rule.marker}`);
    return verdictOf(rule.kind, rule.scope, {
      retryable: rule.retryable,
      cooldownMs: rule.cooldownMs,
      rule: `marker:${rule.marker}`,
    });
  }
  return null;
}

/**
 * 状态码兜底层。
 *
 * 未被前面任何规则命中的 4xx 是 **request-scoped 且不冷却**——这是原实现刻意保留的
 * carve-out：一个由请求本身造成的 400 说明不了凭据有问题，冷却它会把一个健康的
 * 连接摘出轮转，还会把真正的原因藏起来（后续每个请求都会失败，且失败原因是同一句
 * 被缓存下来的 400）。408/425 是可重试的时序问题。5xx 是 30 秒的瞬时抖动。
 */
function statusLayerVerdict(status) {
  if (status === undefined) return null;
  if (status === 408) {
    return verdictOf(FAILURE_KIND.TIMEOUT, FAILURE_SCOPE.TRANSIENT, {
      retryable: true,
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      rule: 'status:408',
    });
  }
  if (status === 425) {
    return verdictOf(FAILURE_KIND.UPSTREAM, FAILURE_SCOPE.TRANSIENT, {
      retryable: true,
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      rule: 'status:425',
    });
  }
  if (status >= 400 && status < 500) {
    return verdictOf(FAILURE_KIND.INVALID_REQUEST, FAILURE_SCOPE.REQUEST, { rule: `status:${status}` });
  }
  if (status >= 500 && status <= 599) {
    const kind = OVERLOAD_STATUSES.includes(status) ? FAILURE_KIND.OVERLOADED : FAILURE_KIND.UPSTREAM;
    return verdictOf(kind, FAILURE_SCOPE.TRANSIENT, {
      retryable: true,
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      rule: `status:${status}`,
    });
  }
  return null;
}

function transientVerdict() {
  return verdictOf(FAILURE_KIND.UNKNOWN, FAILURE_SCOPE.TRANSIENT, {
    retryable: true,
    cooldownMs: TRANSIENT_COOLDOWN_MS,
    rule: 'transient',
  });
}

/**
 * 把一次上游失败归成一条判定。
 *
 * 求值顺序是算法本身，不可交换：
 *   1. 上下文溢出（可能是伪装的 400，必须最先认出来）
 *   2. 文本规则（body 措辞比状态码更具体）
 *   3. 结构化 code（比裸状态码更具体）
 *   4. 状态码规则
 *   5. 结构化标记（没有可用状态码时）
 *   6. 状态码兜底（4xx 不冷却、5xx 瞬时）
 *   7. 什么都没命中：30 秒瞬时默认
 *
 * @param {object} input
 * @param {number|string} [input.status] HTTP 状态码
 * @param {string|object} [input.body] 响应体（字符串或已解析对象）
 * @param {string} [input.message] 错误消息
 * @param {string} [input.code] 结构化错误码
 * @param {number} [input.level] 该供应商当前的退避等级（限流规则会用到）
 * @param {number} [input.retryAfterMs] 上游报的 reset 时长（会被封顶）
 * @returns {{kind:string,scope:string,retryable:boolean,cooldownMs:number,cooldownLevel:number,rule:string,message:string}}
 */
export function classifyFailure({ status, body, message, code, level = 0, retryAfterMs } = {}) {
  const normalizedStatus = normalizeStatus(status);
  const normalizedLevel = normalizeLevel(level);
  const text = failureText(message, body, code);
  const codes = failureCodes(code, body);

  const verdict =
    contextWindowVerdict(codes, text) ||
    textRuleVerdict(text, normalizedLevel) ||
    codeVerdict(codes, normalizedLevel) ||
    statusRuleVerdict(normalizedStatus, normalizedLevel) ||
    markerVerdict(text, normalizedLevel) ||
    statusLayerVerdict(normalizedStatus) ||
    transientVerdict();

  // 上游报的 reset 时长只在**冷却方向**生效：它可以拉长，但不会缩短规则表的判定，
  // 也不会超过 30 分钟——有的上游报几小时，照做等于把这家清出轮转。
  let cooldownMs = verdict.cooldownMs;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    cooldownMs = Math.max(cooldownMs, Math.min(retryAfterMs, MAX_PROVIDER_COOLDOWN_MS));
  }

  return {
    ...verdict,
    cooldownMs,
    message: humanMessage(verdict, message),
  };
}

/** 给人看的一句话：不同 kind 该给不同建议，而不是统一「上游错误」。 */
function humanMessage(verdict, upstreamMessage) {
  const detail = typeof upstreamMessage === 'string' ? upstreamMessage.trim() : '';
  const suffix = detail ? `（${detail.slice(0, 120)}）` : '';
  switch (verdict.kind) {
    case FAILURE_KIND.AUTH:
      return `上游凭证失效，需要重新登录${suffix}`;
    case FAILURE_KIND.PERMISSION:
      return `上游拒绝了这个凭据的权限${suffix}`;
    case FAILURE_KIND.BILLING:
      return `上游额度不足，请充值或换一家${suffix}`;
    case FAILURE_KIND.RATE_LIMIT:
      return `上游限流${suffix}`;
    case FAILURE_KIND.OVERLOADED:
      return `上游过载${suffix}`;
    case FAILURE_KIND.CONTEXT_WINDOW:
      return `请求超出上下文窗口，需要缩小请求或换更大的模型${suffix}`;
    case FAILURE_KIND.INVALID_REQUEST:
      return `上游拒绝了请求${suffix}`;
    case FAILURE_KIND.TIMEOUT:
      return `上游超时${suffix}`;
    case FAILURE_KIND.UNAVAILABLE:
      return `上游不可用${suffix}`;
    case FAILURE_KIND.UPSTREAM:
      return `上游错误${suffix}`;
    default:
      return `上游失败${suffix}`;
  }
}

/** 该不该换下一家：request-scoped 的故障换家也没用。 */
export function shouldRotate(verdict) {
  return verdict.scope !== FAILURE_SCOPE.REQUEST;
}

/** 给人看的分类标签，日志与 `gateway status` 用。 */
export function describeVerdict(verdict) {
  return `${verdict.kind}/${verdict.scope}${verdict.retryable ? ' 可重试' : ''} ${verdict.cooldownMs}ms (${verdict.rule})`;
}

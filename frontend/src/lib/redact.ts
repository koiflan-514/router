/**
 * 展示前的清理：终端控制序列 + 常见密钥。
 *
 * 桥接已在服务端清理一次；前端再清理一次，用于防御"被注入的文本"改变界面或泄露密钥。
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function stripControl(text: string): string {
  return text.replace(ANSI_RE, '').replace(CONTROL_RE, '');
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // JWT 先处理，避免被其它规则切碎
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>'],
  // Authorization 整值一次替换（含 Bearer 前缀），避免出现两层占位符
  [/\bauthorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi, 'authorization=<redacted>'],
  // 独立 Bearer token
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  // 密钥前缀：同时支持 `sk-...` 与 `zsk_...` 两种分隔符
  [/\b(sk|zsk|pt|pk)[-_][A-Za-z0-9._-]{6,}/gi, '<redacted-key>'],
  // JSON / 键值字段（排除已替换的 <redacted>）
  [/"?(access_token|refresh_token|api_key|apikey|password|secret)"?\s*[:=]\s*"?[^"<\s,}]+/gi, '$1=<redacted>'],
  // URL query 参数
  [/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, '$1<redacted>'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** 日志/任务输出：去控制序列 + 脱敏。 */
export function sanitizeOutput(text: string): string {
  return redactSecrets(stripControl(text));
}

/** 单行文本按最大长度截断（保留省略号），用于表格与详情标题。 */
export function clampText(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

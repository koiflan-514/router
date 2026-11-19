/**
 * 输出清理：终端控制序列剥离 + 常见密钥脱敏 + 有界裁剪。
 *
 * 对齐 frontend/docs/07-security.md §6：日志、任务 stdout/stderr、网关错误文本在
 * 返回浏览器之前都先过这里。脱敏是纵深防御，不替代"后端不输出秘密"。
 */

// OSC：ESC ] … (BEL | ST)
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// DCS / SOS / PM / APC：ESC P|X|^|_ … ST
const STRING_SEQ = /\u001b[PX^_][\s\S]*?\u001b\\/g;
// CSI：ESC [ 参数 … 终止字节
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// 双字节转义（字符集选择）与单字节转义
const ESC_CHARSET = /\u001b[()#][0-9A-Za-z]/g;
const ESC_SINGLE = /\u001b[@-Z\\-_]/g;
// 除 \t(09) \n(0a) 外的 C0；C1 全删
const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const C1 = /[\u0080-\u009f]/g;

export const ELLIPSIS = '\u2026';
export const MASK = '***';

/** 去掉控制序列，保留 \t 与 \n。 */
export function stripControl(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(OSC, '')
    .replace(STRING_SEQ, '')
    .replace(CSI, '')
    .replace(ESC_CHARSET, '')
    .replace(ESC_SINGLE, '')
    .replace(C0, '')
    .replace(C1, '');
}

// 模式级脱敏（顺序敏感：Authorization 先于通用前缀）。
const SECRET_RULES = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(?:sk|zsk|pt|pk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi, (m) => `${m.slice(0, 3)}${MASK}`],
  [
    /((?:"?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|authorization|password|passwd|secret|session|sessionid|cookie|signature|sig|hmac|token)"?\s*[:=]\s*"?))[^",\s}]{4,}/gi,
    `$1${MASK}`,
  ],
  [/([?&](?:token|key|api[_-]?key|access[_-]?token|signature|sig|code|secret)=)[^&\s#]+/gi, `$1${MASK}`],
];

/** 常见密钥形态掩码。 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;
  for (const [re, rep] of SECRET_RULES) out = out.replace(re, rep);
  return out;
}

/** 去控制序列 + 脱敏。 */
export function sanitize(text) {
  return redactSecrets(stripControl(text));
}

/**
 * UID 不可逆掩码（07 §8.1 要求值必须脱敏，字段名保留）。
 * 空值保持 null，其余给一个稳定但不可还原的占位。
 */
export function maskUid(uid) {
  const s = String(uid ?? '').trim();
  if (!s) return null;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `u-****-${h.toString(16).padStart(2, '0').slice(-2)}`;
}

/** 名称/详情里夹带的邮箱、手机号掩码。 */
export function maskIdentity(text) {
  if (typeof text !== 'string' || text === '') return text ?? '';
  let out = text.replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_m, local) => {
    const head = local.slice(0, 2);
    return `${head}${MASK}@***`;
  });
  out = out.replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, `$1****$2`);
  return out;
}

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const DEFAULT_MAX_LINE_LENGTH = 8000;

/**
 * 有界裁剪：行数、单行长度与总字节三重上限；截断处显式标注并置 truncated。
 *
 * @returns {{text: string, truncated: boolean, lines: number, bytes: number}}
 */
export function clipText(
  text,
  {
    maxLines = DEFAULT_MAX_LINES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxLineLength = DEFAULT_MAX_LINE_LENGTH,
    fromTail = false,
  } = {},
) {
  const src = typeof text === 'string' ? text : '';
  let truncated = false;
  let lines = src.split('\n');
  const totalLines = lines.length;

  const clippedLines = lines.map((line) => {
    if (line.length <= maxLineLength) return line;
    truncated = true;
    return `${line.slice(0, maxLineLength)}${ELLIPSIS}`;
  });

  if (clippedLines.length > maxLines) {
    truncated = true;
    lines = fromTail ? clippedLines.slice(clippedLines.length - maxLines) : clippedLines.slice(0, maxLines);
  } else {
    lines = clippedLines;
  }

  let out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    truncated = true;
    let buf = Buffer.from(out, 'utf8').subarray(0, Math.max(0, maxBytes - ELLIPSIS.length));
    // 避免切断多字节字符
    out = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\uFFFD+$/g, '');
  }

  if (truncated && !out.endsWith(ELLIPSIS)) out = `${out}${ELLIPSIS}`;

  return {
    text: out,
    truncated,
    lines: totalLines,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/** sanitize + clip 的组合，日志/任务输出统一走这个。 */
export function sanitizeBounded(text, options) {
  const clean = sanitize(text);
  return clipText(clean, options);
}

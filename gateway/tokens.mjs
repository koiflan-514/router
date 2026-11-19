/**
 * 本地 token 估算。
 *
 * Claude Code 会调 `/v1/messages/count_tokens`，它只需要一个数量级正确的数字来决定
 * 何时压缩上下文。这里刻意不用 tokenizer（会给零依赖项目塞进几 MB 词表），而是用
 * 「CJK 按字、其余按 4 字符 1 token」的经验公式——对中文偏差小于 10%，对代码约 ±15%。
 *
 * 宁可估高一点：估高只会让客户端早一点压缩，估低会让请求在上游 400。
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

/** 纯文本 → token 数。 */
export function estimateText(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(CJK) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 1.05 + rest / 3.6);
}

function contentTokens(content) {
  if (typeof content === 'string') return estimateText(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (typeof block === 'string') {
      n += estimateText(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        n += estimateText(block.text);
        break;
      case 'image':
        // 图片按 Anthropic 的粗算：一张图约等于 1.6k token
        n += 1600;
        break;
      case 'tool_use':
        n += estimateText(block.name) + estimateText(JSON.stringify(block.input ?? {}));
        break;
      case 'tool_result':
        n += contentTokens(block.content);
        break;
      case 'thinking':
        n += estimateText(block.thinking);
        break;
      default:
        n += estimateText(JSON.stringify(block));
    }
  }
  return n;
}

/**
 * 请求体 → 输入 token 估算。Anthropic 与 OpenAI 两种形状都吃。
 * 每条消息加 4 token 的角色/分隔开销，工具定义按 JSON 长度估。
 */
export function estimateRequest(body) {
  if (!body || typeof body !== 'object') return 0;
  let total = 0;
  total += contentTokens(body.system);
  for (const msg of body.messages ?? []) {
    total += 4;
    total += contentTokens(msg?.content);
    for (const tc of msg?.tool_calls ?? []) {
      total += estimateText(tc.function?.name) + estimateText(tc.function?.arguments);
    }
  }
  for (const tool of body.tools ?? []) {
    total += 8;
    total += estimateText(tool.name) + estimateText(tool.description);
    total += estimateText(JSON.stringify(tool.input_schema ?? tool.function?.parameters ?? {}));
  }
  return Math.max(1, total);
}

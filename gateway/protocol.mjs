/**
 * 协议转换：Anthropic Messages ⇄ OpenAI Chat Completions。
 *
 * 只有一半的路由需要它：
 *   - `/v1/chat/completions` 九家反代都原生支持 → 永远直通，不做转换；
 *   - `/v1/messages` 只有 CodeArts / ZCode 原生支持 → 其余六家在这里转换。
 *
 * 所以这个文件的职责是**双向**的：
 *   1. Anthropic 请求体 → OpenAI 请求体（发给 openai-only 的上游）
 *   2. OpenAI 响应（JSON 或 SSE）→ Anthropic 响应（回给 Claude Code）
 *
 * 三条取舍，都是为了「宁可报错也不静默丢东西」：
 *   - 图片：Anthropic 的 base64/URL 图片映射成 OpenAI 的 `image_url`，不丢；
 *   - thinking：上游的 `reasoning_content` 默认**不**转成 thinking 块——Anthropic 的
 *     thinking 块要求 signature，伪造会被客户端拒；要看得打开 `exposeReasoning`；
 *   - 未知内容块：直接 400 说清楚是哪一块，而不是丢掉后让模型答非所问。
 */

export class ProtocolError extends Error {
  constructor(message, status = 400, type = 'invalid_request_error') {
    super(message);
    this.name = 'ProtocolError';
    this.status = status;
    this.type = type;
  }
}

// ---------------------------------------------------------------- 请求方向

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
}

/** Anthropic 的 image 块 → OpenAI 的 image_url part。 */
function imagePart(block) {
  const src = block?.source || {};
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

const TOOL_CHOICE = {
  auto: 'auto',
  any: 'required',
  none: 'none',
};

function toolChoiceOf(choice) {
  if (!choice) return undefined;
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return TOOL_CHOICE[choice.type];
}

/**
 * Anthropic Messages 请求体 → OpenAI Chat Completions 请求体。
 * `model` 不在这里设，由网关按路由结果填。
 */
export function messagesToChat(body) {
  const messages = [];

  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const msg of body.messages ?? []) {
    const blocks = Array.isArray(msg.content) ? msg.content : null;

    if (msg.role === 'assistant') {
      const out = { role: 'assistant', content: null };
      if (!blocks) {
        out.content = msg.content ?? null;
        messages.push(out);
        continue;
      }
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
      if (text) out.content = text;
      const calls = blocks
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      if (calls.length) out.tool_calls = calls;
      // 既没文本也没工具调用的 assistant 消息（只有 thinking）会让 OpenAI 侧 400
      if (!out.content && !calls.length) continue;
      messages.push(out);
      continue;
    }

    if (!blocks) {
      messages.push({ role: 'user', content: msg.content ?? '' });
      continue;
    }

    const parts = [];
    for (const b of blocks) {
      if (b?.type === 'text') {
        if (b.text) parts.push({ type: 'text', text: b.text });
      } else if (b?.type === 'image') {
        const part = imagePart(b);
        if (part) parts.push(part);
        else throw new ProtocolError('图片块缺少可用的 source（base64 或 url）');
      } else if (b?.type === 'tool_result') {
        // OpenAI 的 tool 消息不能混在 user 的 parts 里，单独发一条
        messages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: textOf(b.content) || (b.is_error ? '工具执行失败' : ''),
        });
      } else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
        continue; // 上游不需要看到自己的思考
      } else if (b?.type === 'document') {
        throw new ProtocolError('暂不支持 document 块（PDF 等），请先转成文本或图片');
      } else if (b) {
        throw new ProtocolError(`暂不支持的内容块：${b.type || '未知'}`);
      }
    }

    if (!parts.length) continue;
    // 纯文本时用字符串形式：部分国内网关不认 parts 数组
    const onlyText = parts.every((p) => p.type === 'text');
    messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('') : parts });
  }

  const out = { messages };
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object' } },
      }));
  }
  const toolChoice = toolChoiceOf(body.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  out.stream = body.stream === true;
  return out;
}

// ---------------------------------------------------------------- 响应方向

const STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
  // 上游本来就是 Anthropic 方言时原样透传
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  tool_use: 'tool_use',
  stop_sequence: 'stop_sequence',
};

const OPENAI_FINISH = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  stop_sequence: 'stop',
  // 上游本来就是 OpenAI 方言时，finish_reason 已经是这套值，要能原样透传
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'stop',
};

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function usageOf(u, fallback = {}) {
  return {
    input_tokens: u?.prompt_tokens ?? u?.input_tokens ?? fallback.input_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? u?.output_tokens ?? fallback.output_tokens ?? 0,
    cache_read_input_tokens: u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0,
  };
}

/** OpenAI chat.completion JSON → Anthropic message JSON。 */
export function chatToMessage(json, model) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  const text = typeof msg.content === 'string' ? msg.content : textOf(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls ?? []) {
    const args = safeJson(tc.function?.arguments ?? '');
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.function?.name || '',
      input: args ?? {},
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: json?.id || `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_REASON[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: usageOf(json?.usage),
  };
}

/** OpenAI 的 error 响应 → Anthropic 的 error 响应。 */
export function errorBodyToAnthropic(status, text) {
  const json = safeJson(text);
  const message =
    json?.error?.message || json?.message || json?.msg || (typeof text === 'string' ? text.slice(0, 300) : '上游错误');
  const type = status === 429 ? 'rate_limit_error' : status === 401 || status === 403 ? 'authentication_error' : 'api_error';
  return { type: 'error', error: { type, message: String(message) } };
}

// ---------------------------------------------------------------- 聚合（非流式请求）

/**
 * 非流式请求的归一化中间表示。
 *
 * 为什么要这一层：上游并不总是尊重 `stream:false` —— Trae 的 img-proxy 无论要不要流
 * 都回 SSE，CodeArts 对某些模型也只能流式。如果按 content-type 判断，就会把一整段
 * SSE 当成 JSON 解析失败（或者更糟：当成空响应）。
 *
 * 所以非流式请求一律「读完再判断」：能 JSON 解析就按 JSON，否则按 SSE 聚合成这个结构，
 * 最后再渲染成客户端要的方言。
 */
function emptyAccumulator(model) {
  return {
    id: null,
    model,
    text: '',
    reasoning: '',
    toolCalls: [],
    finish: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** OpenAI 的流式帧 → 归一化表示。 */
export async function collectOpenaiSse(frames, model) {
  const acc = emptyAccumulator(model);
  const toolOf = new Map();
  for await (const frame of frames) {
    if (frame.data === '[DONE]') break;
    const c = safeJson(frame.data);
    if (!c || c.error) continue;
    if (c.id && !acc.id) acc.id = c.id;
    for (const choice of c.choices ?? []) {
      const d = choice.delta || {};
      if (typeof d.content === 'string') acc.text += d.content;
      if (typeof d.reasoning_content === 'string') acc.reasoning += d.reasoning_content;
      for (const tc of d.tool_calls ?? []) {
        const key = tc.index ?? 0;
        if (!toolOf.has(key)) {
          const slot = { id: tc.id, name: tc.function?.name || '', args: '' };
          toolOf.set(key, slot);
          acc.toolCalls.push(slot);
        }
        const slot = toolOf.get(key);
        if (tc.id && !slot.id) slot.id = tc.id;
        if (tc.function?.name && !slot.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) acc.finish = choice.finish_reason;
    }
    if (c.usage) {
      acc.usage = {
        input_tokens: c.usage.prompt_tokens ?? acc.usage.input_tokens,
        output_tokens: c.usage.completion_tokens ?? acc.usage.output_tokens,
        cache_read_input_tokens: c.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
  }
  return acc;
}

/** Anthropic 的事件流 → 归一化表示。 */
export async function collectAnthropicSse(frames, model) {
  const acc = emptyAccumulator(model);
  const blocks = [];
  for await (const frame of frames) {
    const ev = safeJson(frame.data);
    if (!ev?.type) continue;
    if (ev.type === 'message_start') {
      acc.id = ev.message?.id || acc.id;
      if (ev.message?.usage) acc.usage = { ...acc.usage, ...ev.message.usage };
    } else if (ev.type === 'content_block_start') {
      const cb = ev.content_block || {};
      blocks[ev.index] = { type: cb.type, text: '', id: cb.id, name: cb.name, json: '' };
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index];
      if (!b) continue;
      const d = ev.delta || {};
      if (d.type === 'text_delta') b.text += d.text || '';
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
      else if (d.type === 'input_json_delta') b.json += d.partial_json || '';
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) acc.finish = ev.delta.stop_reason;
      if (ev.usage) acc.usage = { ...acc.usage, ...ev.usage };
    }
  }
  for (const b of blocks.filter(Boolean)) {
    if (b.type === 'text') acc.text += b.text;
    else if (b.type === 'thinking') acc.reasoning += b.thinking || '';
    else if (b.type === 'tool_use') acc.toolCalls.push({ id: b.id, name: b.name, args: b.json });
  }
  return acc;
}

/** 归一化表示 → Anthropic message JSON。 */
export function renderAnthropic(acc, model, { exposeReasoning = false } = {}) {
  const content = [];
  // thinking 块默认**不**输出：Anthropic 的 thinking 块要求 signature，而 OpenAI 方言的
  // reasoning_content 没有对应签名，伪造一个会被客户端拒绝（表现为整条消息不可用）。
  // 想看得打开 config.exposeReasoning，并接受客户端可能报签名错误。
  if (exposeReasoning && acc.reasoning) content.push({ type: 'thinking', thinking: acc.reasoning, signature: '' });
  if (acc.text) content.push({ type: 'text', text: acc.text });
  for (const tc of acc.toolCalls) {
    const parsed = safeJson(tc.args);
    content.push({ type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tc.name, input: parsed ?? {} });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: acc.id || `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_REASON[acc.finish] ?? (acc.toolCalls.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: acc.usage.input_tokens || 0,
      output_tokens: acc.usage.output_tokens || 0,
      cache_read_input_tokens: acc.usage.cache_read_input_tokens || 0,
    },
  };
}

/** 归一化表示 → OpenAI chat.completion JSON。 */
export function renderChat(acc, model) {
  const message = { role: 'assistant', content: acc.text || null };
  if (acc.reasoning) message.reasoning_content = acc.reasoning;
  if (acc.toolCalls.length) {
    message.tool_calls = acc.toolCalls.map((tc) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: tc.name, arguments: tc.args || '{}' },
    }));
  }
  const prompt = acc.usage.input_tokens || 0;
  const completion = acc.usage.output_tokens || 0;
  return {
    id: acc.id || `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: OPENAI_FINISH[acc.finish] ?? (acc.toolCalls.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

/** 归一化表示 → OpenAI 的「伪流式」：把完整结果拆成一帧 [DONE] 前的单个 chunk。 */
export function renderChatAsChunks(acc, model) {
  const completion = renderChat(acc, model);
  const choice = completion.choices[0];
  return [
    {
      id: completion.id,
      object: 'chat.completion.chunk',
      created: completion.created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: choice.message.content ?? '' }, finish_reason: null }],
    },
    {
      id: completion.id,
      object: 'chat.completion.chunk',
      created: completion.created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
      usage: completion.usage,
    },
  ];
}

/** 完整的上游 JSON → 归一化表示（OpenAI chat.completion 形状）。 */
export function normalizeOpenaiJson(json, model) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const acc = emptyAccumulator(model);
  acc.id = json?.id || null;
  acc.text = typeof msg.content === 'string' ? msg.content : textOf(msg.content);
  acc.reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  for (const tc of msg.tool_calls ?? []) {
    acc.toolCalls.push({ id: tc.id, name: tc.function?.name || '', args: tc.function?.arguments || '{}' });
  }
  acc.finish = choice.finish_reason || null;
  if (json?.usage) {
    acc.usage = {
      input_tokens: json.usage.prompt_tokens ?? 0,
      output_tokens: json.usage.completion_tokens ?? 0,
      cache_read_input_tokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
    };
  }
  return acc;
}

/** 完整的上游 JSON → 归一化表示（Anthropic message 形状）。 */
export function normalizeAnthropicJson(json, model) {
  const acc = emptyAccumulator(model);
  acc.id = json?.id || null;
  for (const b of json?.content ?? []) {
    if (b?.type === 'text') acc.text += b.text || '';
    else if (b?.type === 'thinking') acc.reasoning += b.thinking || '';
    else if (b?.type === 'tool_use') acc.toolCalls.push({ id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) });
  }
  acc.finish = json?.stop_reason || null;
  if (json?.usage) {
    acc.usage = {
      input_tokens: json.usage.input_tokens ?? 0,
      output_tokens: json.usage.output_tokens ?? 0,
      cache_read_input_tokens: json.usage.cache_read_input_tokens ?? 0,
    };
  }
  return acc;
}

/**
 * OpenAI SSE → Anthropic SSE 事件生成器。
 *
 * 输入是 `sseEvents()` 产出的 `{ data }` 帧。输出是 Anthropic 事件对象，序列化交给调用方。
 * 关键点：tool_use 块的 index 必须与 content_block_start 一致；文本块与工具块之间要
 * 先 stop 再 start（Anthropic 不允许同一 index 上并行两种 delta）。
 */
export async function* openaiSseToAnthropicEvents(frames, model, { exposeReasoning = false } = {}) {
  let started = false;
  let id = `msg_${Date.now().toString(36)}`;
  let nextIndex = 0;
  let textIndex = -1;
  let thinkIndex = -1;
  const toolIndex = new Map();
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let sawAny = false;

  const start = () => nextIndex++;
  const closeText = function* () {
    if (textIndex !== -1) {
      yield { type: 'content_block_stop', index: textIndex };
      textIndex = -1;
    }
  };
  const closeThink = function* () {
    if (thinkIndex !== -1) {
      yield { type: 'content_block_stop', index: thinkIndex };
      thinkIndex = -1;
    }
  };

  for await (const frame of frames) {
    if (frame.data === '[DONE]') break;
    const c = safeJson(frame.data);
    if (!c) continue;
    // 上游把错误塞进流里（Qoder 的排队限流就是这样）——必须转成 Anthropic error 事件
    if (c.error) {
      yield { type: 'error', error: { type: 'api_error', message: String(c.error.message || c.error) } };
      return;
    }
    sawAny = true;

    if (!started) {
      started = true;
      id = c.id || id;
      yield {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: c.model || model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
    }

    for (const choice of c.choices ?? []) {
      const delta = choice.delta || {};

      if (exposeReasoning && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (thinkIndex === -1) {
          yield* closeText();
          thinkIndex = start();
          yield { type: 'content_block_start', index: thinkIndex, content_block: { type: 'thinking', thinking: '' } };
        }
        yield {
          type: 'content_block_delta',
          index: thinkIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        };
      }

      if (typeof delta.content === 'string' && delta.content) {
        if (thinkIndex !== -1) yield* closeThink();
        if (textIndex === -1) {
          textIndex = start();
          yield { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } };
        }
        yield { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } };
      }

      for (const tc of delta.tool_calls ?? []) {
        const key = tc.index ?? 0;
        if (!toolIndex.has(key)) {
          yield* closeText();
          yield* closeThink();
          toolIndex.set(key, start());
          yield {
            type: 'content_block_start',
            index: toolIndex.get(key),
            content_block: { type: 'tool_use', id: tc.id || `toolu_${key}`, name: tc.function?.name || '', input: {} },
          };
        }
        const idx = toolIndex.get(key);
        if (tc.function?.arguments) {
          yield {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          };
        }
      }

      if (choice.finish_reason) stopReason = STOP_REASON[choice.finish_reason] ?? stopReason;
    }

    if (c.usage) usage = usageOf(c.usage, usage);
  }

  if (!started) {
    // 上游一帧都没有：仍然给客户端一个完整但空的 message，避免客户端挂住
    yield {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }
  yield* closeThink();
  yield* closeText();
  for (const idx of [...toolIndex.values()].sort((a, b) => a - b)) {
    yield { type: 'content_block_stop', index: idx };
  }
  yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage };
  yield { type: 'message_stop' };
  void sawAny;
}

/** 把 OpenAI 的 usage 从任意帧里取出来（用于用量记录）。 */
export function usageFromOpenaiChunk(json) {
  if (!json?.usage) return null;
  const u = usageOf(json.usage);
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens };
}

/** 把 Anthropic 的 usage 从事件里取出来。 */
export function usageFromAnthropicEvent(ev) {
  if (ev?.type === 'message_start' && ev.message?.usage) {
    return { inputTokens: ev.message.usage.input_tokens || 0, outputTokens: ev.message.usage.output_tokens || 0, cacheReadTokens: ev.message.usage.cache_read_input_tokens || 0 };
  }
  if (ev?.type === 'message_delta' && ev.usage) {
    return { inputTokens: ev.usage.input_tokens || 0, outputTokens: ev.usage.output_tokens || 0, cacheReadTokens: ev.usage.cache_read_input_tokens || 0 };
  }
  return null;
}

export { OPENAI_FINISH, STOP_REASON };

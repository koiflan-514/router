/**
 * 工具调用配对修复。
 *
 * 移植自 dsh-our-free-model 的 `src/messages.js`（MIT），原注释里记的是一个
 * 真实且极难查的故障：
 *
 * > 一次被中断的工具调用会永久污染该会话。缺少对应结果的工具调用在重放时，
 * > 上游返回 400 invalid_request_error，此后该会话中的每一次请求都会失败。
 *
 * 场景很常见：用户在工具执行中途按了 Esc、工具启动失败、客户端崩溃。于是历史里
 * 留下一个「有 tool_use 没有 tool_result」的助手轮次。**下一次**请求带着这段历史
 * 发出去，上游直接 400——而且因为历史没变，之后每一轮都 400。
 *
 * 客户端通常会自己修，但经过网关时有两个新问题：
 *   1. 从 Anthropic 转 OpenAI 时，tool_use 会变成 `tool_calls`，tool_result 变成
 *      `role:"tool"`——转换过程中的丢失会制造出新的不配对；
 *   2. 不同客户端（opencode / pi / Claude Code）修法不一致，有的只修自己的方言。
 *
 * 所以在网关的**唯一收口**上修一次，两种方言共用同一份逻辑。
 *
 * 三条规则，都来自原实现：
 *   - 没有结果的调用要丢掉（连同它的参数）；
 *   - 没有调用的结果也要丢掉（空的 `tool_call_id` 在线上是整轮的 400）；
 *   - 没有名字的调用要丢掉——它不可执行，而且一旦被宿主答成
 *     `Error: unknown tool ""`，就变成「已配对」，靠配对检查永远清不掉。
 */

/** 消息内容块数组；非数组返回空。 */
function blocksOf(content) {
  return Array.isArray(content) ? content : [];
}

/** 一条消息里的工具结果（OpenAI 的 role:"tool" 与 Anthropic 的 tool_result 块）。 */
function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = callIdOf(message);
    return id === null ? [] : [{ callId: id }];
  }
  const out = [];
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool_result') continue;
    const id = String(block.tool_use_id ?? message?.tool_use_id ?? '');
    if (id === '') continue;
    out.push({ callId: id });
  }
  return out;
}

function callIdOf(message) {
  const id = String(message?.tool_call_id ?? message?.tool_use_id ?? '');
  return id === '' ? null : id;
}

/** 一条消息里的工具调用 id（Anthropic 的 tool_use 块 / OpenAI 的 tool_calls）。 */
function toolCallsOf(message) {
  const out = [];
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool_use') continue;
    out.push({ id: String(block.id ?? ''), name: String(block.name ?? '') });
  }
  for (const call of message?.tool_calls ?? []) {
    out.push({ id: String(call?.id ?? ''), name: String(call?.function?.name ?? '') });
  }
  return out;
}

/**
 * 丢掉没有被回答的调用，以及没有对应调用的回答。
 *
 * 返回新数组，不修改入参——调用方可能还要用原始历史（比如记日志）。
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function repairToolPairing(messages) {
  const list = messages ?? [];
  const answered = new Set();
  for (const message of list) {
    for (const result of toolResultsOf(message)) answered.add(result.callId);
  }

  const keptCalls = new Set();
  const out = [];

  for (const message of list) {
    const results = toolResultsOf(message);

    // ---- 这是「结果」消息
    if (results.length > 0) {
      if (message.role === 'tool') {
        // OpenAI 的 tool 消息只有一条结果：调用被保留才保留它
        if (keptCalls.has(results[0].callId)) out.push(message);
        continue;
      }
      // Anthropic 的 tool_result 可能和 text 混在同一个 user 轮次里
      const kept = new Set(results.filter((r) => keptCalls.has(r.callId)).map((r) => r.callId));
      const blocks = blocksOf(message.content);
      const rest = blocks.filter(
        (block) =>
          block?.type !== 'tool_result' || kept.has(String(block.tool_use_id ?? message?.tool_use_id ?? '')),
      );
      if (rest.length === blocks.length) out.push(message);
      else if (rest.length > 0) out.push({ ...message, content: rest });
      continue;
    }

    // 空的 tool 消息没有 call id 可对应，线上就是整轮 400
    if (message?.role === 'tool') continue;

    if (message?.role !== 'assistant') {
      out.push(message);
      continue;
    }

    // ---- 这是「助手」轮次：检查它的调用有没有被回答
    const calls = toolCallsOf(message);
    if (!calls.length) {
      // 纯文本（或只有 thinking）的助手轮次原样保留
      const blocks = blocksOf(message.content);
      if (blocks.length === 0 || blocks.some((b) => b?.type === 'text' && b.text) || typeof message.content === 'string') {
        out.push(message);
      }
      continue;
    }

    // 无名的调用不可执行，丢掉；它的结果随后也会因为 keptCalls 不含它而被丢掉
    const keep = calls.filter((call) => answered.has(call.id) && call.id !== '' && call.name !== '');
    for (const call of keep) keptCalls.add(call.id);

    if (keep.length === calls.length) {
      out.push(message);
      continue;
    }
    if (keep.length === 0) {
      // 这个助手轮次里没有任何能保留的调用。文本要留下（模型不该忘记自己说过什么），
      // 但死掉的调用必须去掉，否则后续每一轮都 400。
      const blocks = blocksOf(message.content);
      const text = blocks.filter((b) => b?.type !== 'tool_use');
      const hasText = text.some((b) => b?.type === 'text' && b.text);
      const keptToolCalls = (message.tool_calls ?? []).filter((c) => keep.some((k) => k.id === String(c?.id ?? '')));
      if (hasText || typeof message.content === 'string') {
        const next = { ...message, content: typeof message.content === 'string' ? message.content : text };
        if (Array.isArray(message.tool_calls)) {
          if (keptToolCalls.length) next.tool_calls = keptToolCalls;
          else delete next.tool_calls;
        }
        out.push(next);
      }
      continue;
    }

    const keepIds = new Set(keep.map((c) => c.id));
    const blocks = blocksOf(message.content).filter((b) => b?.type !== 'tool_use' || keepIds.has(String(b.id ?? '')));
    const next = { ...message, content: typeof message.content === 'string' ? message.content : blocks };
    if (Array.isArray(message.tool_calls)) {
      next.tool_calls = message.tool_calls.filter((c) => keepIds.has(String(c?.id ?? '')));
    }
    out.push(next);
  }

  return out;
}

/**
 * 检查是否有未配对项（不修复，只报告）。
 * 给 `gateway doctor` 与日志用：能回答「这次 400 是不是配对问题」。
 */
export function findUnpairedTools(messages) {
  const answered = new Set();
  const called = new Set();
  for (const message of messages ?? []) {
    for (const r of toolResultsOf(message)) answered.add(r.callId);
    for (const c of toolCallsOf(message)) if (c.id) called.add(c.id);
  }
  return {
    unanswered: [...called].filter((id) => !answered.has(id)),
    orphaned: [...answered].filter((id) => !called.has(id)),
  };
}

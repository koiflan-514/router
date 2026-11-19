/**
 * SSE 解析：把上游的 `text/event-stream` 拆成 `{ event, data }`。
 *
 * 只做一件事，但有两个必须做对的地方：
 *   1. 分块边界不按行对齐 —— 一个 data 帧可能横跨两次 chunk，必须自己攒 buffer；
 *   2. 只按 `\n\n` 切，且先把 `\r\n` 归一化 —— Windows 上游偶尔发 CRLF，
 *      只认 `\n\n` 会让整个流卡住直到连接结束。
 */

const decoder = new TextDecoder();

function parseBlock(raw) {
  let event = '';
  const data = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // 注释/心跳
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!data.length && !event) return null;
  return { event, data: data.join('\n') };
}

/** @param {ReadableStream<Uint8Array>|AsyncIterable} body */
export async function* sseEvents(body) {
  let buf = '';
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseBlock(raw);
      if (ev) yield ev;
    }
  }
  buf += decoder.decode();
  buf = buf.replace(/\r\n/g, '\n');
  if (buf.trim()) {
    const ev = parseBlock(buf);
    if (ev) yield ev;
  }
}

/** 逐帧解析 JSON；坏帧返回 null（上游偶尔会塞非 JSON 的心跳行）。 */
export function parseData(data) {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * 按**响应体形状**判断这是 SSE 还是 JSON，而不是看 Content-Type。
 *
 * 移植自 dsh-our-free-model 的 `src/http.js`（MIT）。它的注释记录了一个和本项目
 * 一模一样的故障：
 *
 * > 该车道会在高负载下以 200 + application/json 返回完整的 SSE 帧序列。旧实现依赖
 * > header，于是把整条流读成字符串、JSON.parse 失败、整轮报废——而该错误对象携带
 * > status: 200，还会使可用性探测将完全可用的模型判为「不可路由」。
 *
 * 我在 Trae 上撞到的是同一个坑的另一种表现：它无论 `stream:false` 都回 SSE，
 * 但 header 有时仍是 application/json。所以判断必须看体，不能看头。
 *
 * @param {string} text 响应体开头（不超过 4KB 就够）
 * @returns {'sse'|'json'|'empty'|'unknown'}
 */
export function sniffBody(text) {
  const head = String(text ?? '')
    .replace(/^\ufeff/, '')
    .trimStart();
  if (head === '') return 'empty';
  // SSE 可能以注释行（`: ping`）或第一个字段行开头
  if (head.startsWith(':') || /^(?:data|event|id|retry)[ \t]*:/m.test(head.slice(0, 64))) return 'sse';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'unknown';
}

/** 嗅探窗口：只读开头这么多字节就足以判断形状。 */
export const SNIFF_LIMIT = 4096;

/**
 * 读一段响应体的开头，用于形状判断。
 *
 * 关键细节（原实现的注释也强调）：**一旦确认是 SSE 就立刻停**。否则一个短回答
 * 之后上游保持连接不关，这里会一直等到超时，而退出时的 cancel 又会把已经读到的
 * 内容丢掉——一个完整的回合被报成可重试的超时。
 *
 * 返回 `{ text, chunks, done, rest() }`。**`text` 与 `rest()` 是互补的**：
 * `rest()` 只产出还没被 `text` 覆盖的字节，调用方按 `text + rest()` 拼接即可。
 * （早期版本让 `rest()` 重放已读的 chunks，于是拼出来的 JSON 变成两份连在一起，
 * 解析必然失败——这个 bug 由真实上游的 94 字节错误体暴露出来。）
 */
export async function readHead(stream, { limit = SNIFF_LIMIT, signal, timeoutMs = 15_000 } = {}) {
  const reader = stream.getReader();
  const chunks = [];
  // 整个响应体共用一个 decoder：在这里 flush 会把一个跨块的多字节字符截断
  const dec = new TextDecoder();
  let size = 0;
  let text = '';
  let done = false;
  /** 已经被解码进 `text` 的字节数。rest() 从这里往后接，绝不重放。 */
  let consumed = 0;
  const deadline = Date.now() + timeoutMs;

  try {
    while (size < limit) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const row = await withTimeout(reader.read(), remaining, signal);
      if (row === TIMEOUT) break;
      if (row.done) {
        done = true;
        break;
      }
      if (!row.value) continue;
      chunks.push(row.value);
      size += row.value.byteLength ?? 0;
      text += dec.decode(row.value, { stream: true });
      consumed = size;
      if (sniffBody(text) === 'sse') break;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock?.();
    } catch {}
    throw err;
  }

  return {
    text,
    chunks,
    done,
    reader,
    decoder: dec,
    /** 只产出 `text` 之后的内容；与 `text` 拼接得到完整响应体。 */
    async *rest() {
      if (done) {
        const tail = dec.decode();
        if (tail) yield tail;
        return;
      }
      try {
        for (;;) {
          const row = await reader.read();
          if (row.done) break;
          if (row.value) yield row.value;
        }
      } finally {
        try {
          reader.releaseLock?.();
        } catch {}
      }
      const tail = dec.decode();
      if (tail) yield tail;
    },
    /** 已读字节数（调试用）。 */
    get consumedBytes() {
      return consumed;
    },
  };
}

const TIMEOUT = Symbol('timeout');

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(TIMEOUT);
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        reject(err);
      },
    );
  });
}

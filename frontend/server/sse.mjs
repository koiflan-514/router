/**
 * SSE 帮助函数：帧格式、心跳、连接登记。
 *
 * 对齐 frontend/docs/05-backend-contract.md §6：
 *   - `event:` 给类型，`data:` 给单行 JSON，事件之间空行分隔；
 *   - 心跳为注释行 `: ping`（默认 15s），不产生 event；
 *   - 可选 `retry: 3000`。
 */

export const HEARTBEAT_MS = 15000;

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** 单帧。data 可以是对象（自动 JSON.stringify，压成单行）或字符串。 */
export function frame({ event, data, id, retry }) {
  const chunks = [];
  if (retry !== undefined && retry !== null) chunks.push(`retry: ${Number(retry)}`);
  if (event) chunks.push(`event: ${String(event)}`);
  if (id !== undefined && id !== null) chunks.push(`id: ${String(id)}`);
  if (data !== undefined) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    // data 允许多行，但契约要求单行 JSON；这里把换行转义保住单行。
    chunks.push(`data: ${raw.replace(/\r?\n/g, '\\n')}`);
  }
  return `${chunks.join('\n')}\n\n`;
}

/**
 * 打开一条 SSE 响应，返回写入句柄。调用方负责在 `close` 时清理。
 * @returns {{send: Function, comment: Function, close: Function, onClose: Function, closed: boolean}}
 */
export function openSse(req, res, { heartbeatMs = HEARTBEAT_MS, retry = 3000 } = {}) {
  res.writeHead(200, SSE_HEADERS);
  res.write(`retry: ${retry}\n\n`);

  let closed = false;
  const closeHandlers = new Set();

  const timer = setInterval(() => {
    if (closed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      close();
    }
  }, heartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const fn of closeHandlers) {
      try {
        fn();
      } catch {
        /* 清理失败不影响其它订阅者 */
      }
    }
    closeHandlers.clear();
  }

  function close() {
    if (closed) return;
    cleanup();
    try {
      res.end();
    } catch {
      /* 已经断开 */
    }
  }

  req.on('close', cleanup);
  res.on('close', cleanup);
  req.on('error', cleanup);

  return {
    get closed() {
      return closed;
    },
    send(event, data, id) {
      if (closed) return false;
      try {
        res.write(frame({ event, data, id }));
        return true;
      } catch {
        close();
        return false;
      }
    },
    comment(text) {
      if (closed) return false;
      try {
        res.write(`: ${text}\n\n`);
        return true;
      } catch {
        close();
        return false;
      }
    },
    onClose(fn) {
      if (closed) {
        fn();
        return;
      }
      closeHandlers.add(fn);
    },
    close,
  };
}

/** 维护一组 SSE 连接，便于广播。 */
export function createSseHub() {
  const clients = new Set();
  return {
    get size() {
      return clients.size;
    },
    add(client) {
      clients.add(client);
      client.onClose(() => clients.delete(client));
    },
    broadcast(event, data, id) {
      for (const client of clients) {
        if (client.closed) {
          clients.delete(client);
          continue;
        }
        client.send(event, data, id);
      }
    },
    remove(client) {
      clients.delete(client);
    },
    closeAll() {
      for (const client of clients) client.close();
      clients.clear();
    },
  };
}

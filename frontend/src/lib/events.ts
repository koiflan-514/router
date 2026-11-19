import { useEffect, useRef } from 'react';
import { panelToken } from './api';

/**
 * 基于 fetch 的 SSE 客户端。
 *
 * 不用 EventSource：它无法携带 `x-panel-token` 请求头，而把 token 放进 URL 违反安全约定。
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SseHandlers {
  onEvent: (e: SseEvent) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
}

function parseFrame(raw: string): SseEvent | null {
  const lines = raw.split('\n');
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length && event === 'message') return null;
  return { event, data: data.join('\n'), id };
}

/** 订阅一个 SSE 端点，返回取消函数。 */
export function subscribeSse(path: string, handlers: SseHandlers): () => void {
  const controller = new AbortController();
  const signal = handlers.signal
    ? AbortSignal.any([controller.signal, handlers.signal])
    : controller.signal;

  void (async () => {
    try {
      const res = await fetch(`/api${path}`, {
        headers: panelToken ? { 'x-panel-token': panelToken } : {},
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE ${path} 失败（HTTP ${res.status}）`);
      }
      handlers.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseFrame(raw);
          if (ev) handlers.onEvent(ev);
        }
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      handlers.onError?.(err);
    }
  })();

  return () => controller.abort();
}

/** React hook：在组件生命周期内维持一条 SSE 连接。 */
export function useSse(path: string | null, onEvent: (e: SseEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  useEffect(() => {
    if (!path) return;
    const off = subscribeSse(path, { onEvent: (e) => handlerRef.current(e) });
    return off;
  }, [path]);
}

import type { z } from 'zod';

/**
 * 面板与桥接之间唯一的 HTTP 通道。
 *
 * - 统一加 `x-panel-token`（生产模式由桥接注入 meta；开发模式为空）。
 * - 统一解析 envelope `{schemaVersion,generatedAt,ok,data?,error?}`。
 * - 业务错误抛 `ApiError`，供 TanStack Query 的 error 分支消费。
 */

const metaEl =
  typeof document !== 'undefined' ? document.querySelector('meta[name="panel-token"]') : null;

export const panelToken = (metaEl?.getAttribute('content') ?? '').trim();

export interface ApiErrorShape {
  code: string;
  message: string;
  provider?: string;
  retryable: boolean;
  status: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly provider?: string;

  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.name = 'ApiError';
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.status = shape.status;
    this.provider = shape.provider;
  }
}

function buildHeaders(hasBody: boolean, extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  if (panelToken) h.set('x-panel-token', panelToken);
  if (hasBody && !h.has('content-type')) h.set('content-type', 'application/json');
  return h;
}

async function request(
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; json: unknown; text: string }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: buildHeaders(Boolean(init?.body), init?.headers),
    });
  } catch (err) {
    throw new ApiError({
      code: 'BACKEND_UNAVAILABLE',
      message: `无法连接桥接服务：${(err as Error).message}`,
      retryable: true,
      status: 0,
    });
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('text/plain')) {
        return { res, json: null, text };
      }
      throw new ApiError({
        code: 'CONTRACT_INVALID',
        message: '桥接返回了无法解析的 JSON',
        retryable: false,
        status: res.status,
      });
    }
  }
  return { res, json, text };
}

interface ErrorFields {
  code?: string;
  message?: string;
  provider?: string;
  retryable?: boolean;
}

function extractError(json: unknown): ErrorFields {
  const e = (json as { error?: unknown } | null)?.error;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    return {
      code: typeof o.code === 'string' ? o.code : undefined,
      message: typeof o.message === 'string' ? o.message : undefined,
      provider: typeof o.provider === 'string' ? o.provider : undefined,
      retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
    };
  }
  return {};
}

function unwrap<T>(path: string, res: Response, json: unknown, schema: z.ZodType<T>): T {
  const record =
    json && typeof json === 'object' ? (json as Record<string, unknown>) : null;

  if (!res.ok || record?.ok === false) {
    const e = extractError(json);
    throw new ApiError({
      code: e.code ?? `HTTP_${res.status}`,
      message: e.message ?? `请求失败（HTTP ${res.status}）`,
      provider: e.provider,
      retryable: e.retryable ?? res.status >= 500,
      status: res.status,
    });
  }

  const payload = record && 'data' in record ? record.data : json;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({
      code: 'CONTRACT_INVALID',
      message: `响应不符合契约：${path}`,
      retryable: false,
      status: res.status,
    });
  }
  return parsed.data;
}

export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const { res, json } = await request(path);
  return unwrap(path, res, json, schema);
}

export async function apiPost<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const { res, json } = await request(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
  return unwrap(path, res, json, schema);
}

/** 文本端点（日志 / doctor）。不做 JSON 解析。 */
export async function apiText(path: string): Promise<string> {
  const { res, text } = await request(path);
  if (!res.ok) {
    throw new ApiError({
      code: `HTTP_${res.status}`,
      message: text || `请求失败（HTTP ${res.status}）`,
      retryable: res.status >= 500,
      status: res.status,
    });
  }
  return text;
}

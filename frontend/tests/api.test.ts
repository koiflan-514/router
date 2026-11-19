import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * api.ts 在模块初始化时读取 `<meta name="panel-token">`，因此每个用例都先设置 meta、
 * 再 `vi.resetModules()` 后动态 import，才能观察到 token 注入行为。
 *
 * 契约：apiGet/apiPost 解析 envelope `{ok,data?,error?}` 并返回 **data**；
 * 调用方 schema 描述的是 data 载荷本身。
 */
async function loadApi() {
  vi.resetModules();
  return import('../src/lib/api');
}

const envelope = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const okEnvelope = (data: unknown) =>
  envelope({ schemaVersion: 1, generatedAt: '2026-11-12T03:00:00.000Z', ok: true, data });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.head.innerHTML = '';
});

describe('apiGet：成功 envelope', () => {
  it('解析 envelope 并取出 data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okEnvelope({ value: 42 })));
    const { apiGet } = await loadApi();

    const result = await apiGet('/demo', z.object({ value: z.number() }));
    expect(result).toEqual({ value: 42 });
  });

  it('请求路径带上 /api 前缀', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okEnvelope({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiGet } = await loadApi();

    await apiGet('/providers', z.object({ value: z.number() }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/providers');
  });
});

describe('apiGet：失败 envelope', () => {
  it('ok:false 抛 ApiError 且字段正确', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        envelope(
          {
            schemaVersion: 1,
            generatedAt: '2026-11-12T03:00:00.000Z',
            ok: false,
            error: {
              code: 'BACKEND_UNAVAILABLE',
              message: 'local gateway is not running',
              provider: 'codearts',
              retryable: true,
            },
          },
          503,
        ),
      ),
    );
    const { apiGet, ApiError } = await loadApi();

    const err = await apiGet('/gateway/status', z.object({})).catch(
      (e) => e as InstanceType<typeof ApiError>,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('BACKEND_UNAVAILABLE');
    expect(err.message).toBe('local gateway is not running');
    expect(err.provider).toBe('codearts');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
  });

  it('业务失败也可带 HTTP 200，仍以 ok:false 为准', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        envelope({
          schemaVersion: 1,
          generatedAt: '2026-11-12T03:00:00.000Z',
          ok: false,
          error: { code: 'ACTION_FAILED', message: '命令退出码非零', retryable: false },
        }),
      ),
    );
    const { apiGet, ApiError } = await loadApi();

    const err = await apiGet('/accounts/check', z.object({})).catch(
      (e) => e as InstanceType<typeof ApiError>,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('ACTION_FAILED');
    expect(err.status).toBe(200);
    expect(err.retryable).toBe(false);
  });

  it('HTTP 非 2xx 但无 error 字段时用状态码兜底', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ ok: true }, 500)));
    const { apiGet, ApiError } = await loadApi();

    const err = await apiGet('/providers', z.object({})).catch(
      (e) => e as InstanceType<typeof ApiError>,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('HTTP_500');
    expect(err.retryable).toBe(true);
  });
});

describe('apiGet：响应不可解析', () => {
  it('非 JSON 响应抛 CONTRACT_INVALID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>not json</html>', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { apiGet, ApiError } = await loadApi();

    const err = await apiGet('/providers', z.object({})).catch(
      (e) => e as InstanceType<typeof ApiError>,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('CONTRACT_INVALID');
    expect(err.status).toBe(200);
    expect(err.retryable).toBe(false);
  });

  it('data 不符合 schema 时抛 CONTRACT_INVALID（不静默返回坏数据）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okEnvelope({ value: 'not-a-number' })));
    const { apiGet, ApiError } = await loadApi();

    const err = await apiGet('/x', z.object({ value: z.number() })).catch(
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as InstanceType<typeof ApiError>;
    expect(apiErr.code).toBe('CONTRACT_INVALID');
    expect(apiErr.message).toContain('/x');
  });
});

describe('apiGet：网络异常', () => {
  it('fetch 抛错时抛 BACKEND_UNAVAILABLE 且可重试', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const { apiGet, ApiError } = await loadApi();

    const err = await apiGet('/providers', z.object({})).catch(
      (e) => e as InstanceType<typeof ApiError>,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('BACKEND_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(0);
  });
});

describe('apiGet：x-panel-token 注入', () => {
  const schema = z.object({ value: z.number() });

  it('meta 有值时携带 x-panel-token', async () => {
    document.head.innerHTML = '<meta name="panel-token" content="tok-example-123">';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okEnvelope({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiGet } = await loadApi();

    await apiGet('/providers', schema);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-panel-token')).toBe('tok-example-123');
  });

  it('meta 缺失时不携带 x-panel-token', async () => {
    document.head.innerHTML = '';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okEnvelope({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiGet } = await loadApi();

    await apiGet('/providers', schema);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-panel-token')).toBeNull();
  });

  it('meta 为空白时不携带 x-panel-token', async () => {
    document.head.innerHTML = '<meta name="panel-token" content="   ">';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okEnvelope({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiGet } = await loadApi();

    await apiGet('/providers', schema);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-panel-token')).toBeNull();
  });
});

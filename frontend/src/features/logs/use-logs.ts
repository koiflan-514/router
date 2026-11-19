import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiText } from '@/lib/api';
import { toRes, type Res } from '@/lib/query';

/**
 * 日志页的数据源与 URL 参数解析。
 *
 * 快照走 `GET /api/logs`（文本，`apiText`）；实时跟随走 `GET /api/logs/stream`（SSE，见页面）。
 * 桥接在 `text/plain` 变体上只返回正文，故此处不解析 envelope，也不读响应头。
 */

/** 尾部行数档位（离散）。上限 2000，与 05 契约一致。 */
export const LINE_OPTIONS = [200, 500, 1000, 2000] as const;
export const DEFAULT_LINES = 500;
/** 本地实时缓冲上限（NFR-104：≤2000 行，长时间运行不无限增长）。 */
export const MAX_LIVE_LINES = 2000;

export interface ParsedLines {
  lines: number;
  /** URL 取值非法、已回退默认值 */
  invalid: boolean;
}

export function parseLines(raw: unknown): ParsedLines {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if ((LINE_OPTIONS as readonly number[]).includes(n)) return { lines: n, invalid: false };
  return {
    lines: DEFAULT_LINES,
    invalid: raw !== undefined && raw !== null && raw !== '',
  };
}

export interface ParsedFollow {
  follow: boolean;
  invalid: boolean;
}

export function parseFollow(raw: unknown): ParsedFollow {
  if (raw === undefined || raw === null || raw === '') return { follow: true, invalid: false };
  if (raw === '1' || raw === 1 || raw === true || raw === 'true') return { follow: true, invalid: false };
  if (raw === '0' || raw === 0 || raw === false || raw === 'false') return { follow: false, invalid: false };
  return { follow: true, invalid: true };
}

/** 日志尾部快照。`data` 是清理后的纯文本；未知 provider 时不发起请求。 */
export function useLogsText(provider: string | null, lines: number): Res<string> {
  return toRes(
    useQuery({
      queryKey: ['logs', provider ?? 'none', lines],
      queryFn: () =>
        apiText(`/logs?provider=${encodeURIComponent(provider as string)}&lines=${lines}`),
      enabled: Boolean(provider),
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    }),
  );
}

/** 窗口可见性：不可见时暂停 SSE（NFR-103 / FR-141）。 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  );
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

import { useEnv } from '@/lib/query';

/**
 * 诊断页的环境视图。
 *
 * 共享 `useEnv()` 是**唯一**数据源：内核 `envSchema.gateway.reachable` 已接受 `null`
 * （未知），真实模式不再触发契约失败，因此这里不再发第二个 `/env` 请求，
 * 只把 shared 结果映射成页面需要的形状（含 additive 的 node/bridge/router/features 字段）。
 */

/** 环境端点运行时附带、但不在核心 schema 中的 additive 字段。 */
export interface EnvExtras {
  node?: { version?: string; platform?: string; arch?: string };
  bridge?: { version?: string; pid?: number | null; port?: number | null };
  router?: { rootOk?: boolean; nodeBin?: string };
  features?: { sse?: boolean; demo?: boolean; readOnly?: boolean; openCodeCli?: boolean };
}

export interface EnvView {
  /** 是否拿到可展示的环境数据 */
  ready: boolean;
  mode: 'real' | 'demo';
  readOnly: boolean;
  root: string;
  nodeVersion: string;
  platform: string;
  panelVersion: string;
  gateway: { url: string; reachable: boolean | null };
  extras: EnvExtras;
  lastSuccessAt: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  /** 有旧数据但最近刷新失败：保留旧值并提示，不冒充最新结果。 */
  stale: boolean;
  loading: boolean;
  refetch: () => void;
}

const EMPTY = {
  ready: false,
  mode: 'real' as const,
  readOnly: false,
  root: '',
  nodeVersion: '',
  platform: '',
  panelVersion: '',
  gateway: { url: '', reachable: null as boolean | null },
  extras: {} as EnvExtras,
};

export function useEnvView(): EnvView {
  const shared = useEnv();
  const d = shared.data;

  if (!d) {
    return {
      ...EMPTY,
      lastSuccessAt: shared.lastSuccessAt,
      error: shared.error,
      stale: shared.stale,
      loading: shared.loading,
      refetch: shared.refetch,
    };
  }

  return {
    ...EMPTY,
    ready: true,
    mode: d.mode,
    readOnly: d.readOnly,
    root: d.root,
    nodeVersion: d.nodeVersion,
    platform: d.platform,
    panelVersion: d.panelVersion,
    gateway: { url: d.gateway.url, reachable: d.gateway.reachable },
    // envSchema 是 looseObject，additive 字段原样保留；类型在上层收窄。
    extras: d as unknown as EnvExtras,
    lastSuccessAt: shared.lastSuccessAt,
    // 有旧数据时仍按"旧值 + stale"呈现，不把失败伪装成桥接不可达。
    error: null,
    stale: shared.stale,
    loading: shared.loading,
    refetch: shared.refetch,
  };
}
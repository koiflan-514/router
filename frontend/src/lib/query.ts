import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, apiGet, apiText } from './api';
import {
  accountGroupSchema,
  providerStatusSchema,
  quotaRowSchema,
  usageStatsSchema,
  type ResourceView,
  type UsageRange,
} from './contract';
import {
  balanceSchema,
  comboSchema,
  envSchema,
  freeProviderSchema,
  gatewayStatusEnvelope,
  gatewayUsageSchema,
  healthSchema,
  localAnswersSchema,
  type BalancePayload,
  type Combo,
  type FreeProvider,
  type GatewayUsage,
  type HealthPayload,
  type LocalAnswers,
  type PanelEnv,
} from './schemas';

export const qk = {
  env: ['env'] as const,
  providers: ['providers'] as const,
  accounts: (provider?: string) => ['accounts', provider ?? 'all'] as const,
  accountCheck: ['accounts', 'check'] as const,
  quota: (provider?: string) => ['quota', provider ?? 'all'] as const,
  usage: (range: UsageRange) => ['usage', range] as const,
  doctor: ['doctor'] as const,
  health: (provider?: string, probe?: boolean) => ['health', provider ?? 'all', Boolean(probe)] as const,
  gatewayStatus: ['gateway', 'status'] as const,
  gatewayUsage: (days: number) => ['gateway', 'usage', days] as const,
  gatewayBalance: ['gateway', 'balance'] as const,
  gatewayCombos: ['gateway', 'combos'] as const,
  gatewayFree: ['gateway', 'free'] as const,
  gatewayLocal: ['gateway', 'localAnswers'] as const,
};

export interface Res<T> extends ResourceView<T> {
  refetch: () => void;
}

function toErr(err: unknown): ResourceView<unknown>['error'] {
  if (!err) return null;
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return { code: 'UNKNOWN', message: (err as Error)?.message ?? '未知错误', retryable: true };
}

export function toRes<T>(q: UseQueryResult<T, Error>): Res<T> {
  return {
    data: q.data ?? null,
    lastSuccessAt: q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null,
    error: toErr(q.error),
    stale: Boolean(q.data) && q.isError,
    loading: q.isPending,
    refetch: () => void q.refetch(),
  };
}

const providerList = z.array(providerStatusSchema);
const accountGroupList = z.array(accountGroupSchema);
const quotaPayload = z.looseObject({
  fetchedAt: z.string().nullable().default(null),
  providers: z.array(quotaRowSchema).default([]),
  /** 数据来源：gateway-balance / cli-fallback / mixed（未知时不谎称）。 */
  source: z.string().optional(),
});
export type QuotaPayload = z.infer<typeof quotaPayload>;

const combosList = z.array(comboSchema);
const freeList = z.array(freeProviderSchema);

export function useEnv(): Res<PanelEnv> {
  return toRes(
    useQuery({
      queryKey: qk.env,
      queryFn: () => apiGet('/env', envSchema),
      staleTime: Infinity,
      refetchInterval: false,
    }),
  );
}

export function useProviders(refetchInterval = 5000): Res<ReturnType<typeof providerList.parse>> {
  return toRes(
    useQuery({
      queryKey: qk.providers,
      queryFn: () => apiGet('/providers', providerList),
      refetchInterval,
    }),
  );
}

export function useAccountGroups(provider?: string, enabled = true): Res<ReturnType<typeof accountGroupList.parse>> {
  return toRes(
    useQuery({
      queryKey: qk.accounts(provider),
      queryFn: () => apiGet(`/accounts${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`, accountGroupList),
      enabled,
      staleTime: 30_000,
    }),
  );
}

export function useAccountCheck(enabled: boolean): Res<ReturnType<typeof accountGroupList.parse>> {
  return toRes(
    useQuery({
      queryKey: qk.accountCheck,
      queryFn: () => apiGet('/accounts/check', accountGroupList),
      enabled,
      staleTime: 0,
    }),
  );
}

export function useQuota(provider?: string): Res<QuotaPayload> {
  return toRes(
    useQuery({
      queryKey: qk.quota(provider),
      queryFn: () => apiGet(`/quota${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`, quotaPayload),
      staleTime: 120_000,
      refetchInterval: 120_000,
    }),
  );
}

export function useUsage(range: UsageRange): Res<ReturnType<typeof usageStatsSchema.parse>> {
  return toRes(
    useQuery({
      queryKey: qk.usage(range),
      queryFn: () => apiGet(`/usage?range=${range}`, usageStatsSchema),
      staleTime: 120_000,
      refetchInterval: 120_000,
    }),
  );
}

export function useGatewayStatus(): Res<ReturnType<typeof gatewayStatusEnvelope.parse>> {
  return toRes(
    useQuery({
      queryKey: qk.gatewayStatus,
      queryFn: () => apiGet('/gateway/status', gatewayStatusEnvelope),
      refetchInterval: 5000,
    }),
  );
}

export function useGatewayUsage(days: number): Res<GatewayUsage> {
  return toRes(
    useQuery({
      queryKey: qk.gatewayUsage(days),
      queryFn: () => apiGet(`/gateway/usage?days=${days}`, gatewayUsageSchema),
      refetchInterval: 60_000,
    }),
  );
}

export function useGatewayBalance(): Res<BalancePayload> {
  return toRes(
    useQuery({
      queryKey: qk.gatewayBalance,
      queryFn: () => apiGet('/gateway/balance', balanceSchema),
      staleTime: 120_000,
    }),
  );
}

export function useGatewayCombos(): Res<Combo[]> {
  return toRes(
    useQuery({
      queryKey: qk.gatewayCombos,
      queryFn: () => apiGet('/gateway/combos', combosList),
      staleTime: 30_000,
    }),
  );
}

export function useGatewayFree(): Res<FreeProvider[]> {
  return toRes(
    useQuery({
      queryKey: qk.gatewayFree,
      queryFn: () => apiGet('/gateway/free', freeList),
      staleTime: 60_000,
    }),
  );
}

export function useGatewayLocalAnswers(): Res<LocalAnswers> {
  return toRes(
    useQuery({
      queryKey: qk.gatewayLocal,
      queryFn: () => apiGet('/gateway/local-answers', localAnswersSchema),
      staleTime: 60_000,
    }),
  );
}

export function useDoctor(enabled: boolean) {
  return useQuery({
    queryKey: qk.doctor,
    queryFn: () => apiText('/doctor'),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

export function useHealth(opts: { provider?: string; probe?: boolean; enabled: boolean }): Res<HealthPayload> {
  const params = new URLSearchParams();
  if (opts.provider) params.set('provider', opts.provider);
  if (opts.probe) params.set('probe', '1');
  const qs = params.toString();
  return toRes(
    useQuery({
      queryKey: qk.health(opts.provider, opts.probe),
      queryFn: () => apiGet(`/health-check${qs ? `?${qs}` : ''}`, healthSchema),
      enabled: opts.enabled,
      staleTime: 0,
      retry: false,
    }),
  );
}

/** 写操作后让所有只读数据失效，触发重新查询（对齐"操作后必须重新查询"）。 */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.providers });
    void qc.invalidateQueries({ queryKey: ['accounts'] });
    void qc.invalidateQueries({ queryKey: ['quota'] });
    void qc.invalidateQueries({ queryKey: qk.gatewayStatus });
    void qc.invalidateQueries({ queryKey: qk.gatewayBalance });
  };
}

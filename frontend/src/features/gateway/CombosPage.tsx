import { useMemo } from 'react';
import { Workflow } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataState } from '@/components/shared/states';
import { ProviderChip } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { useGatewayCombos, useGatewayStatus } from '@/lib/query';
import { DASH } from '@/lib/format';
import { cn } from '@/lib/cn';
import { providerTitle } from '@/lib/provider';
import {
  CliCommand,
  GatewayUnreachable,
  InfoNote,
  cooldownKindLabel,
  isUnreachable,
  useNow,
} from './gateway-shared';
import {
  comboReadiness,
  comboSteps,
  type ComboReadiness,
  type ComboStep,
  type ComboStepStatus,
} from './gateway-model';

function strategyLabel(strategy: string): string {
  if (strategy === 'round-robin') return '轮换 round-robin';
  if (strategy === 'fallback') return '顺序降级 fallback';
  return strategy;
}

const STEP_META: Record<
  ComboStepStatus,
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'muted' }
> = {
  ready: { label: '就绪', variant: 'success' },
  cooldown: { label: '冷却中', variant: 'warning' },
  offline: { label: '离线', variant: 'destructive' },
  unknown: { label: '未知', variant: 'muted' },
};

function readinessMeta(readiness: ComboReadiness): {
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'muted';
} {
  if (readiness.status === 'ready') return { label: `${readiness.ready}/${readiness.total} 环可用`, variant: 'success' };
  if (readiness.status === 'partial') return { label: `${readiness.ready}/${readiness.total} 环可用`, variant: 'warning' };
  if (readiness.status === 'down') return { label: '全部不可用', variant: 'destructive' };
  return { label: '可用性未知', variant: 'muted' };
}

function ChainStep({
  step,
  total,
  last,
}: {
  step: ComboStep;
  total: number;
  last: boolean;
}) {
  const meta = STEP_META[step.status];
  return (
    <li className="relative flex flex-wrap items-center gap-2 pl-10 text-sm">
      {!last ? (
        <span aria-hidden className="absolute left-[11px] top-6 h-[calc(100%-0.5rem)] w-px bg-border" />
      ) : null}
      <span className="absolute left-0 top-0 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium tabular-nums text-muted-foreground">
        {step.index + 1}
      </span>
      {step.provider ? (
        <ProviderChip id={step.provider} title={providerTitle(step.provider)} compact />
      ) : (
        <span className="text-muted-foreground">{DASH}</span>
      )}
      <span className="text-muted-foreground" aria-hidden>
        /
      </span>
      <span className="font-mono">{step.model}</span>
      <Badge variant={meta.variant}>
        {meta.label}
        {step.status === 'cooldown' && step.cooldownKind
          ? ` · ${cooldownKindLabel(step.cooldownKind)}`
          : ''}
      </Badge>
      {step.status === 'unknown' ? (
        <span className="text-[11px] text-muted-foreground">
          {step.provider ? '网关状态未给出该 provider' : '模型名没有 provider 前缀'}
        </span>
      ) : null}
      <span className="ml-auto text-[10px] text-muted-foreground">第 {step.index + 1} / {total} 环</span>
    </li>
  );
}

/** 降级链（combo）：只读展示有序链、成员可用性与冷却状态。 */
export function CombosPage() {
  const res = useGatewayCombos();
  const status = useGatewayStatus();
  const now = useNow(1000);

  const providerSnaps = status.data?.providers ?? null;
  const chains = useMemo(
    () =>
      (res.data ?? []).map((combo) => {
        const steps = comboSteps(combo, providerSnaps, now);
        return { combo, steps, readiness: comboReadiness(steps) };
      }),
    // now 每秒变化会让降级链也每秒重算；只依赖冷却边界所需的 now 精度即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [res.data, providerSnaps, Math.floor(now / 5000)],
  );

  if (isUnreachable(res.error)) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="降级链" description="用户命名的有序链；fallback / round-robin。" />
        <GatewayUnreachable message={res.error?.message} onRetry={res.refetch} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="降级链"
        description="combo:* 是一条用户命名的有序链，可跨供应商跨模型；链上每一环按顺序试，第一个产出正文的赢。"
      />

      <InfoNote>
        本页<strong>只读</strong>。增删链请在终端执行：
        <CliCommand className="ml-1">node router.mjs gateway combo add --name fast --models 'trae-local/glm-5.3-flash,codearts/deepseek-v4.1-flash'</CliCommand>
      </InfoNote>

      {providerSnaps === null ? (
        <InfoNote tone="warning">网关调度状态不可用，成员可用性标为未知；这不影响链本身的结构展示。</InfoNote>
      ) : null}

      <DataState
        res={res}
        loadingLabel="正在读取降级链…"
        onRetry={res.refetch}
        isEmpty={(d) => d.length === 0}
        empty={
          <Empty
            icon={<Workflow />}
            title="还没有降级链"
            description={
              <>
                降级链用 CLI 创建，面板不发明新的写命令。示例：
                <br />
                <CliCommand className="mt-1 inline-block">
                  node router.mjs gateway combo add --name fast --models 'trae-local/glm-5.3-flash,zcode/glm-5.3'
                </CliCommand>
              </>
            }
          />
        }
      >
        {() => (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {chains.map(({ combo, steps, readiness }) => {
              const meta = readinessMeta(readiness);
              return (
                <Card key={combo.name}>
                  <CardHeader className="flex-row flex-wrap items-center gap-2">
                    <CardTitle className="font-mono">combo:{combo.name}</CardTitle>
                    <Badge variant={combo.strategy === 'round-robin' ? 'info' : 'secondary'}>
                      {strategyLabel(combo.strategy)}
                    </Badge>
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{steps.length} 环</span>
                  </CardHeader>
                  <CardContent>
                    {steps.length === 0 ? (
                      <div className="text-sm text-muted-foreground">该链没有成员（{DASH}）</div>
                    ) : (
                      <ol className="flex flex-col gap-2.5">
                        {steps.map((step) => (
                          <ChainStep
                            key={`${step.raw}-${step.index}`}
                            step={step}
                            total={steps.length}
                            last={step.index === steps.length - 1}
                          />
                        ))}
                      </ol>
                    )}
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      链上可用性来自网关调度快照（running + 冷却）；「就绪」只表示可尝试，不保证模型一定成功。
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </DataState>

      <InfoNote>
        规则：正文增量<strong>之前</strong>的失败整段丢弃换下一环（思考增量不算正文）；一旦已有正文交付，之后的失败正常结束；
        容量取交集而非并集；全部环节不可用的链会保留并标注，不静默消失。
      </InfoNote>
    </div>
  );
}
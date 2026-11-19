import { Workflow } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataState } from '@/components/shared/states';
import { ProviderChip } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/empty';
import { useGatewayCombos } from '@/lib/query';
import { DASH } from '@/lib/format';
import { CliCommand, GatewayUnreachable, InfoNote, isUnreachable } from './gateway-shared';

function strategyLabel(strategy: string): string {
  if (strategy === 'round-robin') return '轮换 round-robin';
  if (strategy === 'fallback') return '顺序降级 fallback';
  return strategy;
}

/** 把 `provider/model` 拆成两段；没有前缀时 provider 为 null（裸模型名）。 */
function splitRing(model: string): { provider: string | null; model: string } {
  const i = model.indexOf('/');
  if (i <= 0) return { provider: null, model };
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}

/** 降级链（combo）：只读展示有序链与成员模型。 */
export function CombosPage() {
  const res = useGatewayCombos();

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
        {(combos) => (
          <div className="flex flex-col gap-3">
            {combos.map((combo) => {
              const available = combo.available ?? true;
              return (
                <Card key={combo.name}>
                  <CardHeader className="flex-row flex-wrap items-center gap-2">
                    <CardTitle className="font-mono">combo:{combo.name}</CardTitle>
                    <Badge variant={combo.strategy === 'round-robin' ? 'info' : 'secondary'}>
                      {strategyLabel(combo.strategy)}
                    </Badge>
                    <Badge variant={available ? 'success' : 'warning'}>
                      {available ? '可用' : '部分成员不可用'}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{combo.models.length} 环</span>
                  </CardHeader>
                  <CardContent>
                    {combo.models.length === 0 ? (
                      <div className="text-sm text-muted-foreground">该链没有成员（{DASH}）</div>
                    ) : (
                      <ol className="flex flex-col gap-1.5">
                        {combo.models.map((m, i) => {
                          const ring = splitRing(m);
                          return (
                            <li key={`${m}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] tabular-nums text-muted-foreground">
                                {i + 1}
                              </span>
                              {ring.provider ? (
                                <ProviderChip id={ring.provider} />
                              ) : (
                                <span className="text-muted-foreground">{DASH}</span>
                              )}
                              <span className="text-muted-foreground" aria-hidden>
                                /
                              </span>
                              <span className="font-mono">{ring.model}</span>
                            </li>
                          );
                        })}
                      </ol>
                    )}
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

import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { AuthBadge } from '@/components/shared/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ProviderStatus } from '@/lib/contract';
import { driftDetailText, isAuthIssue, stateComboText } from './overview-model';

/**
 * 异常与漂移入口：由 provider 明细与额度错误逐项推导，每一项给出可点击的「下一步」
 * （跳转服务/日志/诊断或重试），不在本页写操作。无异常时整块不渲染。
 */
export function AttentionList({
  providers,
  quotaError,
  onRetryQuota,
  onSelect,
}: {
  providers: ProviderStatus[];
  quotaError: { code: string; message: string; retryable: boolean } | null;
  onRetryQuota: () => void;
  onSelect: (id: string) => void;
}) {
  const flagged = providers.filter((p) => p.drift.length > 0 || isAuthIssue(p.auth));
  if (flagged.length === 0 && !quotaError) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-warning" aria-hidden />
          异常与漂移
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {flagged.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-stroke-1 px-3 py-2 text-xs"
          >
            <span className="font-medium">{p.title}</span>
            <span className="text-muted-foreground">{stateComboText(p)}</span>
            {p.drift.length ? <Badge variant="warning">漂移：{driftDetailText(p)}</Badge> : null}
            {isAuthIssue(p.auth) ? <AuthBadge auth={p.auth} /> : null}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => onSelect(p.id)}>
                查看详情
              </Button>
              <Link
                to="/providers"
                search={{ provider: p.id }}
                className="rounded text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label={`去服务页：处理 ${p.title}`}
              >
                去服务页
              </Link>
              <Link
                to="/logs"
                search={{ provider: p.id }}
                className="rounded text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label={`查看日志：${p.title}`}
              >
                查看日志
              </Link>
            </div>
          </div>
        ))}
        {quotaError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
          >
            <span className="font-medium text-destructive">额度数据读取失败（{quotaError.code}）</span>
            <span className="text-muted-foreground">{quotaError.message}</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={onRetryQuota}>
              重试
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

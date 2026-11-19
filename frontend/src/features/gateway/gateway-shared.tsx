import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * 网关各子页共用的小工具与展示块。
 * 仅服务 `src/features/gateway/**`，不放业务数据。
 */

/** 每秒走一次的时钟，用于冷却倒计时等需要"实时"的只读展示。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * 冷却原因分类（对齐 `gateway/failure.mjs` 的词汇）→ 中文。
 * 未识别的分类**保留原文**，不猜测。
 */
const COOLDOWN_KINDS: Record<string, string> = {
  auth: '凭据失效',
  permission: '权限受限',
  billing: '额度不足',
  rate_limit: '限流',
  overloaded: '上游过载',
  context_window: '上下文溢出',
  invalid_request: '请求非法',
  upstream: '上游错误',
  upstream_5xx: '上游 5xx',
  upstream_4xx: '上游 4xx',
  timeout: '超时',
};

export function cooldownKindLabel(kind: string | null | undefined): string {
  if (!kind) return '未知原因';
  return COOLDOWN_KINDS[kind] ?? kind;
}

/** 只把"桥接/网关不可达"当作可达性问题，其他错误仍按普通失败呈现。 */
export function isUnreachable(error: { code: string } | null): boolean {
  return error?.code === 'BACKEND_UNAVAILABLE';
}

/** 网关不可达：给出启动命令，不报错白屏。 */
export function GatewayUnreachable({
  message,
  onRetry,
}: {
  message?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"
    >
      <div className="flex items-center gap-2 font-medium text-warning">
        <Unplug className="size-4" />
        网关不可达
      </div>
      <p className="text-muted-foreground">
        {message || '本机网关 127.0.0.1:8785 未运行。网关是叠加层，需要单独启动。'}
      </p>
      <p className="text-muted-foreground">
        请先在终端运行：<CliCommand>node router.mjs gateway up</CliCommand>
      </p>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="size-4" />
          重试
        </Button>
      ) : null}
    </div>
  );
}

/** 终端命令展示（只用于提示，不是可编辑输入框）。 */
export function CliCommand({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground', className)}>
      {children}
    </code>
  );
}

/** 只读提示块。 */
export function InfoNote({
  children,
  tone = 'muted',
  className,
}: {
  children: ReactNode;
  tone?: 'muted' | 'warning' | 'info';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-xs',
        tone === 'warning'
          ? 'border-warning/40 bg-warning/10 text-warning'
          : tone === 'info'
            ? 'border-info/40 bg-info/10 text-info'
            : 'border-border bg-muted/40 text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

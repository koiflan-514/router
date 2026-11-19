import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';
import { sanitizeOutput } from '@/lib/redact';

/**
 * 只读日志/输出视图：先清理控制序列与密钥，再有界渲染。
 *
 * 顺序很重要：先按 maxLines 截断（保留最近内容），再对已加载文本做过滤。
 * 过滤不宣称搜索完整历史。
 */
export function LogView({
  text,
  filter,
  className,
  maxLines = 2000,
}: {
  text: string;
  filter?: string;
  className?: string;
  maxLines?: number;
}) {
  const { lines, truncated } = useMemo(() => {
    const clean = sanitizeOutput(text ?? '');
    const all = clean.split('\n');
    const capped = all.length > maxLines ? all.slice(all.length - maxLines) : all;
    const q = filter?.trim().toLowerCase();
    const matched = q ? capped.filter((l) => l.toLowerCase().includes(q)) : capped;
    return { lines: matched, truncated: all.length > maxLines };
  }, [text, filter, maxLines]);

  if (!text) {
    return <div className="p-4 text-xs text-muted-foreground">{DASH} 暂无内容</div>;
  }

  return (
    <div className={cn('relative', className)}>
      {truncated ? (
        <div className="border-b border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
          仅显示最近 {maxLines} 行
        </div>
      ) : null}
      <pre
        role="log"
        aria-live="off"
        tabIndex={0}
        className="max-h-full overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {lines.map((line, i) => (
          <div key={i} className="min-h-[1.2em]">
            {line || '\u00a0'}
          </div>
        ))}
        {lines.length === 0 ? <div className="text-muted-foreground">没有匹配当前过滤的日志</div> : null}
      </pre>
    </div>
  );
}
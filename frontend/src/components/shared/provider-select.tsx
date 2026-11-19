import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { providerColorVar } from '@/lib/provider';

export interface ProviderOption {
  id: string;
  title: string;
  overlay?: boolean;
}

/** Provider 选择器（含"全部"）。颜色点用于快速区分来源。 */
export function ProviderSelect({
  providers,
  value,
  onChange,
  allowAll = true,
  allLabel = '全部',
  className,
  placeholder = '选择 provider',
}: {
  providers: ProviderOption[];
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  allowAll?: boolean;
  allLabel?: string;
  className?: string;
  placeholder?: string;
}) {
  // 触发器名称带上当前值，读屏不必展开列表就能知道筛选条件。
  const selected = value === undefined ? undefined : providers.find((p) => p.id === value);
  const currentLabel = value === undefined ? (allowAll ? allLabel : undefined) : (selected?.title ?? value);
  const triggerLabel = currentLabel ? `选择 provider，当前：${currentLabel}` : '选择 provider';

  return (
    <Select
      value={value ?? '__all__'}
      onValueChange={(v) => onChange(v === '__all__' ? undefined : v)}
    >
      <SelectTrigger className={className} aria-label={triggerLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowAll ? <SelectItem value="__all__">{allLabel}</SelectItem> : null}
        {providers.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="size-2 rounded-sm"
                style={{ backgroundColor: providerColorVar(p.id) }}
              />
              {p.title}
              {/* 同标题不同来源时靠 id 区分。 */}
              {p.title === p.id ? null : <span className="sr-only">（{p.id}）</span>}
              {p.overlay ? <span className="text-[10px] text-muted-foreground">叠加</span> : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { UsageRange, UsageStats } from '@/lib/contract';
import { todayLocal } from '@/lib/format';
import { usageCsv, type ModelRow } from './usage-model';

/** 客户端 Blob 导出当前视图（模型表按当前排序、每日活动、Token 汇总）。 */
export function ExportCsvButton({
  data,
  models,
  range,
  disabled,
}: {
  data: UsageStats | null;
  models: ModelRow[];
  range: UsageRange;
  disabled?: boolean;
}) {
  function onExport() {
    if (!data) return;
    try {
      const csv = usageCsv(data, models);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `router-usage-${range}-${todayLocal()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('用量 CSV 已导出', { description: `${models.length} 个模型 · ${data.activity.length} 天活动` });
    } catch (err) {
      toast.error('导出失败', { description: (err as Error).message });
    }
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onExport}
      disabled={disabled || !data}
      title="导出当前范围的 Token 汇总、每日活动与模型表"
    >
      <Download className="size-4" />
      导出 CSV
    </Button>
  );
}
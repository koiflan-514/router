/** 展示格式化：数字、时间、时长、单位。所有未知值统一显示 `—`。 */

export const DASH = '—';

export function isKnown(v: unknown): v is number | string {
  return v !== null && v !== undefined && v !== '';
}

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(v);
}

export function fmtNumber(v: number | null | undefined, maxFrac = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: maxFrac }).format(v);
}

/** 大数缩写：1200 → 1.2K。 */
export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

export function fmtPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return DASH;
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtUnit(v: number | null | undefined, unit: string | undefined): string {
  const n = fmtNumber(v);
  if (n === DASH) return DASH;
  return unit ? `${n} ${unit}` : n;
}

/** 相对时间（用于"x 秒前"）；未来时间显示绝对时间。 */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const delta = now - t;
  if (delta < -1000) return fmtDateTime(iso);
  if (delta < 1500) return '刚刚';
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.round(hour / 24);
  if (day < 30) return `${day} 天前`;
  return fmtDate(iso);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(t);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(t);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const min = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  if (min < 60) return `${min} 分 ${rest} 秒`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

/** 从 ISO 时间算剩余时长（负数返回"已过期"）。 */
export function fmtCountdown(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const delta = t - now;
  if (delta <= 0) return '已过期';
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.round(min / 60);
  if (hour < 48) return `${hour} 小时`;
  return `${Math.round(hour / 24)} 天`;
}

/** 今日日期 YYYY-MM-DD（本地）。 */
export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

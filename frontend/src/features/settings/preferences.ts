import { useCallback, useState } from 'react';

/**
 * 仅本机浏览器偏好（localStorage）。
 *
 * 这些偏好**只在当前浏览器本地生效**：不写任何后端状态、不改桥接启动参数，
 * 也不参与 provider / 网关的真实读写（对齐 docs/08-operations.md §4.3：
 * MVP 不引入额外用户配置文件，刷新间隔等由浏览器本地存储承载）。
 *
 * 存储 key 统一加 `router-panel-` 前缀，与主题的 `router-panel-theme` 并列。
 */

export const PREF_KEYS = {
  defaultRange: 'router-panel-default-range',
  defaultProvider: 'router-panel-default-provider',
} as const;

/** 与 `UsageRange`（00 §2 `range`）保持一致：24h / 7d / 30d / all。 */
export const USAGE_RANGES = ['24h', '7d', '30d', 'all'] as const;
export type PrefRange = (typeof USAGE_RANGES)[number];
export const DEFAULT_PREF_RANGE: PrefRange = '7d';

export const RANGE_LABEL: Record<PrefRange, string> = {
  '24h': '近 24 小时',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
};

function isRange(v: string | null): v is PrefRange {
  return v !== null && (USAGE_RANGES as readonly string[]).includes(v);
}

function readLocal(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    // 隐私模式 / 存储被禁用时视为未设置
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 存储不可写时忽略，不抛出 */
  }
}

/** 默认时间范围：非法/未知值回退 `7d`（对齐 00 §2 非法值回退默认）。 */
export function readDefaultRange(): PrefRange {
  const v = readLocal(PREF_KEYS.defaultRange);
  return isRange(v) ? v : DEFAULT_PREF_RANGE;
}

export function useDefaultRange() {
  const [range, setRangeState] = useState<PrefRange>(readDefaultRange);
  const setRange = useCallback((v: PrefRange) => {
    writeLocal(PREF_KEYS.defaultRange, v);
    setRangeState(v);
  }, []);
  const resetRange = useCallback(() => {
    writeLocal(PREF_KEYS.defaultRange, null);
    setRangeState(DEFAULT_PREF_RANGE);
  }, []);
  return { range, setRange, resetRange };
}

/** 默认选中的 provider；`null` 表示"不默认选中"。 */
export function readDefaultProvider(): string | null {
  const v = readLocal(PREF_KEYS.defaultProvider);
  return v && v.length > 0 ? v : null;
}

export function useDefaultProvider() {
  const [provider, setProviderState] = useState<string | null>(readDefaultProvider);
  const setProvider = useCallback((v: string | null) => {
    writeLocal(PREF_KEYS.defaultProvider, v);
    setProviderState(v);
  }, []);
  const resetProvider = useCallback(() => {
    writeLocal(PREF_KEYS.defaultProvider, null);
    setProviderState(null);
  }, []);
  return { provider, setProvider, resetProvider };
}

/** Provider 分类色与展示辅助（对齐 00 设计基线 §10 / 06 设计系统 §3）。 */

export const PROVIDER_COLOR_VAR: Record<string, string> = {
  codearts: 'var(--provider-codearts)',
  'qoder-cn': 'var(--provider-qoder-cn)',
  qoder: 'var(--provider-qoder)',
  'trae-local': 'var(--provider-trae-local)',
  workbuddy: 'var(--provider-workbuddy)',
  'workbuddy-global': 'var(--provider-workbuddy-global)',
  zcode: 'var(--provider-zcode)',
  loomy: 'var(--provider-loomy)',
  raccoon: 'var(--provider-raccoon)',
  gateway: 'var(--provider-gateway)',
};

export function providerColorVar(id: string | null | undefined): string {
  if (!id) return 'var(--provider-default)';
  return PROVIDER_COLOR_VAR[id] ?? 'var(--provider-default)';
}

export const PROVIDER_FALLBACK_TITLE: Record<string, string> = {
  'qoder-cn': 'Qoder 国内版',
  qoder: 'Qoder 国际版',
  'trae-local': 'Trae',
  codearts: 'CodeArts Agent',
  zcode: 'ZCode',
  workbuddy: 'WorkBuddy 国内版',
  'workbuddy-global': 'WorkBuddy 国际版',
  loomy: 'Loomy（讯飞）',
  raccoon: '商汤小浣熊',
  gateway: '统一网关',
};

export function providerTitle(id: string, seen?: string | null): string {
  if (seen) return seen;
  return PROVIDER_FALLBACK_TITLE[id] ?? id;
}

/** 分类色的小圆点样式，供 ProviderChip 使用。 */
export function providerDotStyle(id: string): { backgroundColor: string } {
  return { backgroundColor: providerColorVar(id) };
}

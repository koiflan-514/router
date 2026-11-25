/** Provider 分类色与展示辅助（对齐 00 设计基线 §10 / 06 设计系统 §3）。 */

/**
 * 已知 provider id：与 `router.mjs list --json` 的 13 家反代逐项对齐（顺序一致），
 * 外加 `gateway` 叠加层。新增 provider 时这里与 `server/normalize.mjs` 的
 * `PROVIDER_IDS` 必须一起改，`tests/bridge-provider-whitelist.test.ts` 会比对两者。
 */
export const PROVIDER_IDS = [
  'qoder-cn',
  'qoder',
  'trae-local',
  'codearts',
  'zcode',
  'loomy',
  'raccoon',
  'qwenwork',
  'dumate',
  'lingxi',
  'lobster',
  'workbuddy',
  'workbuddy-global',
  'gateway',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

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
  qwenwork: 'var(--provider-qwenwork)',
  dumate: 'var(--provider-dumate)',
  lingxi: 'var(--provider-lingxi)',
  lobster: 'var(--provider-lobster)',
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
  qwenwork: '千问办公',
  dumate: '百度搭子',
  lingxi: 'WPS 灵犀',
  lobster: '有道龙虾（LobsterAI）',
  gateway: '统一网关',
};

export function providerTitle(id: string, seen?: string | null): string {
  if (seen) return seen;
  return PROVIDER_FALLBACK_TITLE[id] ?? id;
}

/** 分类色变量名是否已知（未知 id 会回落到 `--provider-default`）。 */
export function hasProviderColor(id: string | null | undefined): boolean {
  return Boolean(id && id in PROVIDER_COLOR_VAR);
}

/** 分类色的小圆点样式，供 ProviderChip 使用。 */
export function providerDotStyle(id: string): { backgroundColor: string } {
  return { backgroundColor: providerColorVar(id) };
}

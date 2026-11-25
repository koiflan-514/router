import { describe, expect, it } from 'vitest';
import {
  PROVIDER_COLOR_VAR,
  PROVIDER_FALLBACK_TITLE,
  PROVIDER_IDS,
  hasProviderColor,
  providerColorVar,
} from '@/lib/provider';

/**
 * 前端 provider 覆盖：13 家反代 + gateway 叠加层。
 *
 * 漏掉任何一家都会让分类色回落到默认色、标题退化成裸 id，
 * 所以这里把「颜色变量 / 兜底标题 / id 清单」三份映射钉在一起。
 */

const NEW_PROVIDERS = [
  { id: 'qwenwork', title: '千问办公' },
  { id: 'dumate', title: '百度搭子' },
  { id: 'lingxi', title: 'WPS 灵犀' },
  { id: 'lobster', title: '有道龙虾（LobsterAI）' },
] as const;

describe('provider 覆盖', () => {
  it('id 清单 = 13 家反代 + gateway', () => {
    expect(PROVIDER_IDS).toHaveLength(14);
    expect(PROVIDER_IDS.at(-1)).toBe('gateway');
  });

  it('每个 id 都有分类色、兜底标题，且颜色互不重复', () => {
    for (const id of PROVIDER_IDS) {
      expect(hasProviderColor(id), `${id} 缺分类色变量`).toBe(true);
      expect(PROVIDER_FALLBACK_TITLE[id], `${id} 缺兜底标题`).toBeTruthy();
    }
    const colorNames = PROVIDER_IDS.map((id) => PROVIDER_COLOR_VAR[id]);
    expect(new Set(colorNames).size).toBe(colorNames.length);
  });

  it('新增 4 家：颜色变量与标题正确', () => {
    for (const { id, title } of NEW_PROVIDERS) {
      expect(PROVIDER_COLOR_VAR[id]).toBe(`var(--provider-${id})`);
      expect(PROVIDER_FALLBACK_TITLE[id]).toBe(title);
    }
  });

  it('未知 id 才回落到默认色', () => {
    expect(providerColorVar('qwenwork')).toBe('var(--provider-qwenwork)');
    expect(providerColorVar('nope')).toBe('var(--provider-default)');
    expect(providerColorVar(null)).toBe('var(--provider-default)');
    // 与网关同色的「叠加层」不算未知。
    expect(hasProviderColor('gateway')).toBe(true);
  });
});

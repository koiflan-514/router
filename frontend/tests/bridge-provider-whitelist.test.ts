import { describe, expect, it } from 'vitest';
import type { ProviderId } from '../src/lib/provider';

/**
 * 桥接层是纯 ESM 的 `.mjs`，没有类型声明；只用到少量运行时导出。
 * 真实模式冒烟（`tests/bridge-real.test.ts`）负责在真实数据上再校一遍。
 */
const RUNTIME = '../server/normalize.mjs';
const {
  ACTION_PROVIDER_WHITELIST,
  PROVIDER_IDS,
  deriveDrift,
  toProviderStatus,
} = (await import(RUNTIME)) as {
  ACTION_PROVIDER_WHITELIST: Set<string>;
  PROVIDER_IDS: string[];
  deriveDrift: (input: { on: boolean; up: boolean; overlay?: boolean }) => string[];
  toProviderStatus: (raw: Record<string, unknown>) => {
    id: string;
    title: string;
    overlay: boolean;
    drift: string[];
  };
};

/**
 * 桥接层 provider 白名单（真实数据覆盖）。
 *
 * 背景：`router.mjs list --json` 现有 13 家反代 + gateway 叠加层；白名单漏掉任何一家，
 * 该家的写操作都会在桥接层被当成「未知 provider」拒绝，前端分类色也会回落到默认色。
 * 这里把「白名单 ⊇ router 的真实 id」钉成契约，新增 provider 时测试会先失败。
 */

/** 与 `node router.mjs list --json` 的 providers[].id 逐项对齐（顺序即输出顺序）。 */
const ROUTER_PROVIDER_IDS: ProviderId[] = [
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
];

describe('bridge PROVIDER_IDS', () => {
  it('顺序与 router.mjs list 一致，且不含 gateway（叠加层单独进白名单）', () => {
    expect(PROVIDER_IDS).toEqual(ROUTER_PROVIDER_IDS);
    expect(PROVIDER_IDS).not.toContain('gateway');
  });

  it('覆盖 13 家反代 + gateway 叠加层', () => {
    expect(PROVIDER_IDS).toHaveLength(13);
    expect(ACTION_PROVIDER_WHITELIST.size).toBe(14);
    for (const id of [...ROUTER_PROVIDER_IDS, 'gateway']) {
      expect(ACTION_PROVIDER_WHITELIST.has(id), `${id} 应在写操作白名单内`).toBe(true);
    }
  });

  it('新增的 4 家都在白名单里', () => {
    for (const id of ['qwenwork', 'dumate', 'lingxi', 'lobster']) {
      expect(ACTION_PROVIDER_WHITELIST.has(id), `${id} 会被桥接层拒绝写操作`).toBe(true);
    }
  });

  it('toProviderStatus 对新增 provider 透传标题且不作 overlay', () => {
    const row = toProviderStatus({
      id: 'qwenwork',
      title: '千问办公',
      on: true,
      up: false,
      port: 8794,
      models: null,
      control: 'spawn',
    });
    expect(row.id).toBe('qwenwork');
    expect(row.title).toBe('千问办公');
    expect(row.overlay).toBe(false);
    // on && !up → stopped，且未写入 opencode → notSynced；推导口径与既有 9 家一致。
    expect(row.drift).toEqual(['stopped', 'notSynced']);
  });

  it('gateway 仍是叠加层，不报 drift', () => {
    expect(deriveDrift({ on: true, up: true, overlay: true })).toEqual([]);
  });
});

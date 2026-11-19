import { describe, expect, it } from 'vitest';
import {
  actionCatalog,
  actionNameSchema,
  providerStatusSchema,
  taskSchema,
  usageStatsSchema,
  type ActionName,
} from '../src/lib/contract';

const validProvider = {
  id: 'qoder-cn',
  title: 'Qoder 国内版',
  on: true,
  up: true,
  models: 11,
  port: 8789,
  pid: 1234,
  pids: [1234],
  control: 'spawn',
  oc: true,
  ocUserOwned: false,
  auth: {
    ok: true,
    state: 'expiring',
    expiresAt: '2026-11-14T00:00:00.000Z',
    label: '凭证即将到期',
  },
  drift: [] as string[],
};

describe('providerStatusSchema', () => {
  it('合法对象可解析', () => {
    const parsed = providerStatusSchema.parse(validProvider);
    expect(parsed.id).toBe('qoder-cn');
    expect(parsed.auth.state).toBe('expiring');
    expect(parsed.drift).toEqual([]);
  });

  it('忽略未知字段（增量兼容）', () => {
    const parsed = providerStatusSchema.parse({
      ...validProvider,
      futureField: 'ignored',
      nested: { anything: true },
    });
    expect(parsed).not.toHaveProperty('futureField');
    expect(parsed).not.toHaveProperty('nested');
  });

  it('models:null 与 models:0 都合法且可区分', () => {
    const unknownModels = providerStatusSchema.parse({ ...validProvider, models: null });
    const zeroModels = providerStatusSchema.parse({ ...validProvider, models: 0 });
    expect(unknownModels.models).toBeNull();
    expect(zeroModels.models).toBe(0);
    expect(unknownModels.models).not.toBe(zeroModels.models);
  });

  it('可选字段有默认值', () => {
    const { pids, control, ocUserOwned, drift, ...minimal } = validProvider;
    const parsed = providerStatusSchema.parse(minimal);
    expect(parsed.pids).toEqual([]);
    expect(parsed.control).toBe('');
    expect(parsed.ocUserOwned).toBe(false);
    expect(parsed.drift).toEqual([]);
  });

  it('未知 auth.state 被拒绝（保留原文由上层处理）', () => {
    const res = providerStatusSchema.safeParse({
      ...validProvider,
      auth: { ...validProvider.auth, state: 'something-new' },
    });
    expect(res.success).toBe(false);
  });
});

describe('taskSchema', () => {
  it('终态任务（succeeded）可解析', () => {
    const parsed = taskSchema.parse({
      actionId: 'act_7f3a',
      action: 'Restart',
      providerIds: ['trae-local'],
      accountKey: null,
      startedAt: '2026-11-12T03:00:00.000Z',
      finishedAt: '2026-11-12T03:00:04.000Z',
      exitCode: 0,
      status: 'succeeded',
      stdout: '重启 trae-local…\n',
      stderr: '',
      truncated: false,
      refreshStatus: 'confirmed',
    });
    expect(parsed.status).toBe('succeeded');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.refreshStatus).toBe('confirmed');
  });

  it('进行态任务（running，未结束）可解析', () => {
    const parsed = taskSchema.parse({
      actionId: 'act_0001',
      action: 'Start',
      providerIds: ['qoder-cn'],
      startedAt: '2026-11-12T03:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      status: 'running',
    });
    expect(parsed.status).toBe('running');
    expect(parsed.finishedAt).toBeNull();
    expect(parsed.stdout).toBe('');
    expect(parsed.stderr).toBe('');
    expect(parsed.truncated).toBe(false);
    expect(parsed.refreshStatus).toBe('pending');
  });

  it('非法状态被拒绝', () => {
    const res = taskSchema.safeParse({
      actionId: 'act_x',
      action: 'Start',
      startedAt: '2026-11-12T03:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      status: 'bogus',
    });
    expect(res.success).toBe(false);
  });

  it('未知 action 被拒绝', () => {
    const res = taskSchema.safeParse({
      actionId: 'act_x',
      action: 'NotAnAction',
      startedAt: '2026-11-12T03:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      status: 'queued',
    });
    expect(res.success).toBe(false);
  });
});

describe('usageStatsSchema', () => {
  it('缺字段时使用默认值', () => {
    const parsed = usageStatsSchema.parse({});
    expect(parsed.sessions).toBe(0);
    expect(parsed.subagents).toBe(0);
    expect(parsed.prompts).toBe(0);
    expect(parsed.steps).toBe(0);
    expect(parsed.tokens).toEqual({ input: 0, output: 0, reasoning: 0 });
    expect(parsed.cost).toBe(0);
    expect(parsed.activeDays).toBe(0);
    expect(parsed.streak).toBe(0);
    expect(parsed.activity).toEqual([]);
    expect(parsed.models).toEqual([]);
  });

  it('tokens 子字段独立缺省', () => {
    const parsed = usageStatsSchema.parse({ tokens: { input: 10 } });
    expect(parsed.tokens.input).toBe(10);
    expect(parsed.tokens.output).toBe(0);
    expect(parsed.tokens.reasoning).toBe(0);
  });

  it('多余字段不报错', () => {
    const parsed = usageStatsSchema.parse({
      sessions: 5,
      steps: 42,
      extraField: 'ignored',
      nestedExtra: { a: 1 },
    });
    expect(parsed.sessions).toBe(5);
    expect(parsed.steps).toBe(42);
  });

  it('接受完整结构', () => {
    const parsed = usageStatsSchema.parse({
      range: { from: 1762308000000, to: 1762912800000 },
      sessions: 12,
      steps: 320,
      tokens: { input: 411200, output: 98200, reasoning: 5400, cache: { read: 12000, write: 3000 } },
      cost: 1.8421,
      tools: { totals: { calls: 210, succeeded: 200, failed: 10 } },
      models: [{ id: 'glm-5.3-flash', providerID: 'trae-local', steps: 120, cost: 0.7 }],
    });
    expect(parsed.models[0]?.id).toBe('glm-5.3-flash');
    expect(parsed.tools?.totals?.succeeded).toBe(200);
  });
});

describe('actionCatalog', () => {
  const names = actionNameSchema.options;

  it('每个 ActionName 都有条目', () => {
    for (const name of names) {
      expect(actionCatalog[name], `缺少 ActionName 条目：${name}`).toBeDefined();
    }
    expect(Object.keys(actionCatalog).sort()).toEqual([...names].sort());
  });

  it('needsAccount 只出现在 SwitchAccount* 动作上', () => {
    for (const name of names) {
      if (actionCatalog[name].needsAccount) {
        expect(name.startsWith('SwitchAccount')).toBe(true);
      }
    }
    // 反向确认：SwitchAccount* 的两个动作确实需要账号。
    expect(actionCatalog.SwitchAccountPreview.needsAccount).toBe(true);
    expect(actionCatalog.SwitchAccount.needsAccount).toBe(true);
  });

  it('条目字段形状合法，危险级取值受限', () => {
    for (const name of names) {
      const entry = actionCatalog[name as ActionName];
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.confirm).toBe('string');
      expect(entry.confirm.length).toBeGreaterThan(0);
      expect(['normal', 'high']).toContain(entry.risk);
      expect(typeof entry.needsProvider).toBe('boolean');
    }
  });

  it('高风险动作与设计基线一致', () => {
    for (const name of ['OnlyEnable', 'EnableAll', 'DisableAll', 'EnableAllAccounts', 'Probe'] as ActionName[]) {
      expect(actionCatalog[name].risk).toBe('high');
    }
  });
});

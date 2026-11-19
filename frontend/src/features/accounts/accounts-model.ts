import type { Account, AccountGroup } from '@/lib/contract';

/** 账号页呈现辅助：图例标记、健康文案、体检结果合并。 */

export type HealthLevel = Account['health']['level'];

export interface AccountMarker {
  symbol: '*' | '+' | '-';
  text: string;
}

/** `*` 当前生效 · `+` 参与轮询 · `-` 停用（符号 + 文字，不只靠颜色）。 */
export function accountMarker(account: Account): AccountMarker {
  if (account.active) return { symbol: '*', text: '当前生效' };
  if (account.enabled) return { symbol: '+', text: '参与轮询' };
  return { symbol: '-', text: '停用' };
}

const HEALTH_TEXT: Record<HealthLevel, string> = {
  ok: '正常',
  warn: '注意',
  error: '错误',
  unknown: '未知',
};

export function healthText(level: HealthLevel): string {
  return HEALTH_TEXT[level] ?? '未知';
}

/** `account check` 只返回有问题的账号；以 `id::key` 建立索引。 */
export function buildCheckIndex(
  groups: AccountGroup[] | null | undefined,
): Map<string, Account['health']> {
  const index = new Map<string, Account['health']>();
  for (const group of groups ?? []) {
    for (const account of group.accounts) index.set(`${group.id}::${account.key}`, account.health);
  }
  return index;
}

/** 结构化体检结果优先于账号池自带 health（不解析文本推断）。 */
export function mergeCheckHealth(
  group: AccountGroup,
  index: Map<string, Account['health']>,
): AccountGroup {
  if (!index.size) return group;
  return {
    ...group,
    accounts: group.accounts.map((account) => {
      const checked = index.get(`${group.id}::${account.key}`);
      return checked ? { ...account, health: checked } : account;
    }),
  };
}

export function activeAccount(group: AccountGroup): Account | null {
  return group.accounts.find((a) => a.active) ?? null;
}

export interface AccountStats {
  total: number;
  active: number;
  issues: number;
}

export function countHealth(groups: AccountGroup[]): AccountStats {
  let total = 0;
  let active = 0;
  let issues = 0;
  for (const group of groups) {
    for (const account of group.accounts) {
      total += 1;
      if (account.active) active += 1;
      if (account.health.level === 'warn' || account.health.level === 'error') issues += 1;
    }
  }
  return { total, active, issues };
}

export function countCheckedIssues(groups: AccountGroup[] | null | undefined): number {
  return (groups ?? []).reduce((n, group) => n + group.accounts.length, 0);
}

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QuotaBar } from '@/components/shared/quota-bar';
import type { QuotaBucket } from '@/lib/contract';

/**
 * QuotaBar：额度条。
 * 口径（docs/09-testing.md §2.1 额度计算）：total 缺失或 0 时不计算百分比、不画进度条，
 * 但仍显示剩余的原始数值，并给出"不显示占比"的可读说明；真实 0 与未知要区分。
 */

afterEach(() => {
  cleanup();
});

function makeBucket(overrides: Partial<QuotaBucket> = {}): QuotaBucket {
  return {
    id: 'daily',
    label: '每日额度',
    total: 100,
    remaining: 50,
    unit: 'credits',
    ...overrides,
  };
}

describe('QuotaBar', () => {
  it('total > 0 时渲染进度条、百分比与可访问数值', () => {
    render(<QuotaBar bucket={makeBucket()} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar).toHaveAttribute('aria-label', '每日额度剩余额度');
    expect(bar).toHaveAttribute('aria-valuetext', '剩余 50 / 100 credits（50%）');
    expect(screen.getByText(/50 \/ 100 credits/)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('total 缺失（undefined）时不渲染进度条，但仍显示数值与说明', () => {
    render(<QuotaBar bucket={makeBucket({ total: undefined, remaining: 42 })} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(/42 credits/)).toBeInTheDocument();
    expect(screen.queryByText(/\/ /)).not.toBeInTheDocument();
    expect(screen.getByText('未提供总量，暂不显示占比')).toBeInTheDocument();
  });

  it('total 为 null 时不渲染进度条，但仍显示数值与说明', () => {
    render(<QuotaBar bucket={makeBucket({ total: null, remaining: 7 })} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(/7 credits/)).toBeInTheDocument();
    expect(screen.getByText('未提供总量，暂不显示占比')).toBeInTheDocument();
  });

  it('total 为 0 时不渲染进度条，也不显示 / 0', () => {
    render(<QuotaBar bucket={makeBucket({ total: 0, remaining: 0 })} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(/0 credits/)).toBeInTheDocument();
    expect(screen.queryByText(/\/ 0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.getByText('未提供总量，暂不显示占比')).toBeInTheDocument();
  });

  it('total > 0 但 remaining 未知时不渲染进度条，显示 `— / total` 与「剩余量未知」', () => {
    render(<QuotaBar bucket={makeBucket({ remaining: null })} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(/— \/ 100 credits/)).toBeInTheDocument();
    expect(screen.getByText('剩余量未知，暂不显示占比')).toBeInTheDocument();
  });

  it('remaining=0 且 total>0 时渲染 0% 进度条（真实 0 不是未知）', () => {
    render(<QuotaBar bucket={makeBucket({ remaining: 0 })} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('显示 bucket.label 与 unit', () => {
    render(<QuotaBar bucket={makeBucket({ label: 'Trae 免费额度', unit: '次' })} />);
    expect(screen.getByText('Trae 免费额度')).toBeInTheDocument();
    expect(screen.getByText(/50 \/ 100 次/)).toBeInTheDocument();
  });

  it('label 为空时进度条回退到「额度」命名', () => {
    render(<QuotaBar bucket={makeBucket({ label: '' })} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', '额度剩余额度');
  });
});
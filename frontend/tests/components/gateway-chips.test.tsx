import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProviderChip } from '@/components/shared/status';
import { providerTitle } from '@/lib/provider';

/**
 * 网关三页（调度 / 降级链 / 网关用量）的 provider chip 用 compact：
 * 可见文本只有中文名，id 只进 title / aria-label，不再出现「qoder-cn qoder-cn」。
 */

afterEach(() => {
  cleanup();
});

/** 与 SchedulerPage 的 LaneCard 头部写法一致。 */
function renderLaneChip(id: string) {
  return render(<ProviderChip id={id} title={providerTitle(id)} compact />);
}

describe('网关页 provider chip：compact + 中文标题', () => {
  it('已知 provider 显示中文名，title/aria-label 保留 id', () => {
    renderLaneChip('trae-local');
    const chip = screen.getByText('Trae');
    expect(chip).toBeInTheDocument();
    expect(screen.getByLabelText('Trae (trae-local)')).toBeInTheDocument();
    expect(screen.getByTitle('Trae (trae-local)')).toBeInTheDocument();
    // 可见文本里不能再出现 id。
    expect(screen.queryByText('trae-local')).not.toBeInTheDocument();
  });

  it('qoder-cn 只渲染一次，不再重复成「qoder-cn qoder-cn」', () => {
    const { container } = renderLaneChip('qoder-cn');
    expect(screen.getByTitle('Qoder 国内版 (qoder-cn)')).toBeInTheDocument();
    expect(container.textContent).toBe('Qoder 国内版');
    expect(container.textContent).not.toContain('qoder-cn');
  });

  it('未知 id 回落成 id 本身，且不出现「ollama ollama」重复', () => {
    const { container } = render(<ProviderChip id="ollama" title={providerTitle('ollama')} compact />);
    const chip = screen.getByText('ollama');
    expect(chip).toBeInTheDocument();
    expect(screen.getByTitle('ollama (ollama)')).toBeInTheDocument();
    expect(container.textContent).toBe('ollama');
  });
});

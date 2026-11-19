import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResourceView } from '@/lib/contract';
import { DataState, ErrorState, LoadingState, StaleNotice } from '@/components/shared/states';

/**
 * DataState：统一处理 加载 / 失败 / 空 / stale 四态。
 * 关键口径（00 §7 / docs/09-testing.md §1 P5）：
 * `data === null` 且无 error 才是"加载中"；有 error 是失败；有数据但 stale 不清空内容，只加提示。
 */

afterEach(() => {
  cleanup();
});

function makeRes<T>(overrides: Partial<ResourceView<T>> = {}): ResourceView<T> {
  return {
    data: null,
    lastSuccessAt: null,
    error: null,
    stale: false,
    loading: false,
    ...overrides,
  };
}

const LAST_SUCCESS = '2026-01-05T04:00:00Z';

describe('DataState', () => {
  it('data 为 null 且无 error 时渲染加载态', () => {
    render(<DataState res={makeRes<string[]>()}>{() => null}</DataState>);
    expect(screen.getByText('正在读取…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('支持自定义 loadingLabel', () => {
    render(
      <DataState res={makeRes<string[]>()} loadingLabel="拉取 provider 列表…">
        {() => null}
      </DataState>,
    );
    expect(screen.getByText('拉取 provider 列表…')).toBeInTheDocument();
    expect(screen.queryByText('正在读取…')).not.toBeInTheDocument();
  });

  it('有 error 时渲染错误态与错误码', () => {
    render(
      <DataState
        res={makeRes<string[]>({
          error: { code: 'BACKEND_UNAVAILABLE', message: '无法连接桥接服务', retryable: true },
        })}
      >
        {() => null}
      </DataState>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('读取失败（BACKEND_UNAVAILABLE）');
    expect(alert).toHaveTextContent('无法连接桥接服务');
  });

  it('点「重试」触发 onRetry', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <DataState
        res={makeRes<string[]>({
          error: { code: 'BROKEN', message: '出错了', retryable: true },
        })}
        onRetry={onRetry}
      >
        {() => null}
      </DataState>,
    );
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('无 onRetry 时不渲染重试按钮', () => {
    render(
      <DataState
        res={makeRes<string[]>({
          error: { code: 'BROKEN', message: '出错了', retryable: false },
        })}
      >
        {() => null}
      </DataState>,
    );
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('stale 有数据时显示过期提示，同时仍渲染内容', () => {
    render(
      <DataState
        res={makeRes<string[]>({ data: ['trae-local'], stale: true, lastSuccessAt: LAST_SUCCESS })}
      >
        {(data) => <ul>{data.map((d) => <li key={d}>{d}</li>)}</ul>}
      </DataState>,
    );
    expect(screen.getByText(/数据已过期（最近成功：/)).toBeInTheDocument();
    expect(screen.getByText(/显示的是上一份结果/)).toBeInTheDocument();
    // stale 只加提示，不清空数据。
    expect(screen.getByText('trae-local')).toBeInTheDocument();
  });

  it('非 stale 时不显示过期提示', () => {
    render(<DataState res={makeRes<string[]>({ data: ['trae-local'] })}>{(data) => <span>{data[0]}</span>}</DataState>);
    expect(screen.queryByText(/数据已过期/)).not.toBeInTheDocument();
    expect(screen.getByText('trae-local')).toBeInTheDocument();
  });

  it('isEmpty 命中时渲染传入的空态', () => {
    render(
      <DataState
        res={makeRes<string[]>({ data: [] })}
        isEmpty={(data) => data.length === 0}
        empty={<div>还没有 provider</div>}
      >
        {() => <div>不该出现</div>}
      </DataState>,
    );
    expect(screen.getByText('还没有 provider')).toBeInTheDocument();
    expect(screen.queryByText('不该出现')).not.toBeInTheDocument();
  });

  it('isEmpty 命中且未传 empty 时渲染默认空态', () => {
    render(
      <DataState res={makeRes<string[]>({ data: [] })} isEmpty={(data) => data.length === 0}>
        {() => null}
      </DataState>,
    );
    expect(screen.getByText('没有可展示的数据')).toBeInTheDocument();
  });

  it('空态与 stale 可同时出现', () => {
    render(
      <DataState
        res={makeRes<string[]>({ data: [], stale: true, lastSuccessAt: LAST_SUCCESS })}
        isEmpty={(data) => data.length === 0}
        empty={<div>空桶</div>}
      >
        {() => null}
      </DataState>,
    );
    expect(screen.getByText('空桶')).toBeInTheDocument();
    expect(screen.getByText(/数据已过期/)).toBeInTheDocument();
  });
});

describe('LoadingState / ErrorState / StaleNotice 独立渲染', () => {
  it('LoadingState 默认文案', () => {
    render(<LoadingState />);
    expect(screen.getByText('正在读取…')).toBeInTheDocument();
  });

  it('ErrorState 无 error 时回退为「未知错误」', () => {
    render(<ErrorState error={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('未知错误');
  });

  it('StaleNotice 未知最近成功时间显示 `—`', () => {
    render(<StaleNotice lastSuccessAt={null} />);
    expect(screen.getByText(/数据已过期（最近成功：—）/)).toBeInTheDocument();
  });
});
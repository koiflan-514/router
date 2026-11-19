import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { LogView } from '@/components/shared/log-view';

/**
 * LogView：只读日志视图。
 * 语义（docs/09-testing.md §2.2 / R6）：先清理控制序列与脱敏，再按 maxLines 截断（保留最近），最后做过滤。
 * 过滤只作用于已加载的最近内容，不宣称搜索完整历史。
 */

afterEach(() => {
  cleanup();
});

const ESC = '\u001b';
const BEL = '\u0007';

describe('LogView 清理与脱敏', () => {
  it('去除 ANSI CSI 颜色序列后再显示', () => {
    render(<LogView text={`${ESC}[31mred${ESC}[0m ok`} />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('red ok');
    expect(log.textContent).not.toContain(ESC);
    expect(log.textContent).not.toContain('[31m');
  });

  it('去除 OSC 序列的控制字符（ESC/BEL）', () => {
    render(<LogView text={`${ESC}]0;title${BEL}body`} />);
    const log = screen.getByRole('log');
    expect(log.textContent).not.toContain(ESC);
    expect(log.textContent).not.toContain(BEL);
    expect(log).toHaveTextContent('body');
  });

  it('脱敏 Bearer token', () => {
    render(<LogView text="Authorization: Bearer pretty-long-token-123" />);
    const log = screen.getByRole('log');
    // Authorization 整值一次替换，不会出现两层占位符
    expect(log.textContent).not.toContain('pretty-long-token-123');
    expect(log).toHaveTextContent('authorization=<redacted>');
  });

  it('单独的 Bearer token 替换为占位符', () => {
    render(<LogView text="curl -H 'Bearer abc.def-123_456'" />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('Bearer <redacted>');
    expect(log.textContent).not.toContain('abc.def-123_456');
  });

  it('脱敏 sk- 前缀密钥', () => {
    render(<LogView text="key=sk-abcdefgh12345678 end" />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('<redacted-key>');
    expect(log.textContent).not.toContain('sk-abcdefgh12345678');
  });

  it('脱敏 zsk- 前缀密钥', () => {
    render(<LogView text="key=zsk-abcdefgh12345678 end" />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('<redacted-key>');
    expect(log.textContent).not.toContain('zsk-abcdefgh12345678');
  });

  it('脱敏下划线形式的 zsk_ 密钥', () => {
    render(<LogView text="key=zsk_abcdefgh12345678 end" />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('<redacted-key>');
    expect(log.textContent).not.toContain('zsk_abcdefgh12345678');
  });
});

describe('LogView 截断与过滤', () => {
  it('maxLines 截断只显示最近 N 行并给出提示', () => {
    const text = ['line-1', 'line-2', 'line-3', 'line-4'].join('\n');
    render(<LogView text={text} maxLines={2} />);
    expect(screen.getByText('仅显示最近 2 行')).toBeInTheDocument();
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('line-3');
    expect(log).toHaveTextContent('line-4');
    expect(log.textContent).not.toContain('line-1');
    expect(log.textContent).not.toContain('line-2');
  });

  it('未超限时不显示截断提示', () => {
    render(<LogView text={'a\nb'} maxLines={2000} />);
    expect(screen.queryByText(/仅显示最近/)).not.toBeInTheDocument();
  });

  it('filter 大小写不敏感地只保留命中行', () => {
    render(<LogView text={'INFO started\nERROR boom\ninfo fine'} filter="error" />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('ERROR boom');
    expect(log.textContent).not.toContain('INFO started');
    expect(log.textContent).not.toContain('info fine');
  });

  it('filter 无命中时给出明确提示', () => {
    render(<LogView text={'alpha\nbeta'} filter="zzz" />);
    expect(screen.getByText('没有匹配当前过滤的日志')).toBeInTheDocument();
  });

  it('先按 maxLines 截断再过滤（过滤不覆盖被截掉的历史）', () => {
    // needle 只出现在最早一行，已被 maxLines 截掉，因此过滤后无命中。
    const text = ['needle here', 'a', 'b'].join('\n');
    render(<LogView text={text} maxLines={2} filter="needle" />);
    expect(screen.getByText('没有匹配当前过滤的日志')).toBeInTheDocument();
    expect(screen.getByRole('log').textContent).not.toContain('needle');
  });

  it('多次脱敏后仍保留普通文本与行结构', () => {
    render(<LogView text={'重启 trae-local 完成\nBearer abc.def-123_456'} />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('重启 trae-local 完成');
    expect(log).toHaveTextContent('Bearer <redacted>');
  });
});

describe('LogView 空内容', () => {
  it('text 为空串时显示暂无内容', () => {
    render(<LogView text="" />);
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.getByText(/暂无内容/)).toBeInTheDocument();
  });

  it('日志行渲染在带 aria-live="off" 的 pre 中（不主动打断读屏）', () => {
    render(<LogView text="hello" />);
    const log = screen.getByRole('log');
    expect(log.tagName).toBe('PRE');
    expect(within(log).getByText('hello')).toBeInTheDocument();
    expect(log).toHaveAttribute('aria-live', 'off');
  });
});
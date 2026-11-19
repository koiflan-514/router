import { describe, expect, it } from 'vitest';
import { clampText, redactSecrets, sanitizeOutput, stripControl } from '../src/lib/redact';

/** 断言字符串里不再残留任何 C0/C1/ESC 控制字符。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const hasControl = (s: string) => CONTROL_CHARS.test(s);

describe('stripControl：去除终端控制序列', () => {
  it('剥离 ANSI CSI 颜色序列', () => {
    expect(stripControl('\u001b[31mred\u001b[0m')).toBe('red');
    expect(stripControl('\u001b[1;32mok\u001b[0m plain')).toBe('ok plain');
    expect(hasControl(stripControl('\u001b[31mred\u001b[0m'))).toBe(false);
  });

  it('剥离 C0 与 DEL 控制字符', () => {
    expect(stripControl('a\u0001b\u0007c\u007fd')).toBe('abcd');
    expect(hasControl(stripControl('a\u0001b\u0007c\u007fd'))).toBe(false);
  });

  it('剥离 OSC 序列引入符（ESC/BEL）', () => {
    // OSC 0;title BEL：至少保证引入控制符被去掉，不留可改变界面的控制字符。
    expect(hasControl(stripControl('\u001b]0;title\u0007text'))).toBe(false);
    expect(stripControl('\u001b]52;c;AAAA\u0007')).not.toContain('\u001b');
    expect(stripControl('\u001b]52;c;AAAA\u0007')).not.toContain('\u0007');
  });

  it('保留合法的换行与制表符', () => {
    expect(stripControl('a\nb\tc')).toBe('a\nb\tc');
  });

  it('空串安全', () => {
    expect(stripControl('')).toBe('');
  });
});

describe('redactSecrets：替换常见密钥', () => {
  it('函数覆盖 Bearer', () => {
    expect(redactSecrets('Authorization: Bearer sk-live-abcdefghijklmnop')).not.toContain(
      'sk-live-abcdefghijklmnop',
    );
    expect(redactSecrets('Bearer abc.def-123_456')).toBe('Bearer <redacted>');
  });

  it('替换 sk-/zsk-/pt-/pk- 前缀密钥', () => {
    expect(redactSecrets('sk-abcdefgh12345678')).toBe('<redacted-key>');
    expect(redactSecrets('zsk-abcdefgh12345678')).toBe('<redacted-key>');
    expect(redactSecrets('pt-abcdefgh12345678')).toBe('<redacted-key>');
    expect(redactSecrets('pk-abcdefgh12345678')).toBe('<redacted-key>');
    // 下划线形式也必须脱敏（`zsk_` / `pt_` 等）
    expect(redactSecrets('zsk_abcdefgh12345678')).toBe('<redacted-key>');
    expect(redactSecrets('pt_abcdefgh12345678')).toBe('<redacted-key>');
  });

  it('替换 JSON 字段中的 api_key / access_token', () => {
    const jsonKey = redactSecrets('{"api_key":"abc1234567890"}');
    expect(jsonKey).toContain('api_key=<redacted>');
    expect(jsonKey).not.toContain('abc1234567890');

    const jsonTok = redactSecrets('{"access_token": "tok-value-xyz"}');
    expect(jsonTok).toContain('access_token=<redacted>');
    expect(jsonTok).not.toContain('tok-value-xyz');
  });

  it('替换 URL query 中的 token=/key=', () => {
    const u = redactSecrets('https://panel.example/api?token=abc123&provider=trae-local');
    expect(u).toContain('token=<redacted>');
    expect(u).not.toContain('abc123');
    expect(u).toContain('provider=trae-local');

    const u2 = redactSecrets('/x?key=secretvalue&n=1');
    expect(u2).toBe('/x?key=<redacted>&n=1');
  });

  it('替换 JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(jwt)).toBe('<redacted-jwt>');
  });

  it('普通文本保持不变', () => {
    expect(redactSecrets('重启 trae-local 完成')).toBe('重启 trae-local 完成');
  });
});

describe('sanitizeOutput：清理 + 脱敏组合', () => {
  it('先剥离控制序列再脱敏密钥', () => {
    const raw = '\u001b[32mBearer sk-abcdefgh12345678\u001b[0m';
    expect(sanitizeOutput(raw)).toBe('Bearer <redacted>');
  });

  it('多行日志中的控制符与密钥都被处理', () => {
    const raw = '\u001b[0mINFO request https://svc.example/v1?token=abc123\u001b[0m\npanic: \u0001boom';
    const out = sanitizeOutput(raw);
    expect(out).not.toContain('abc123');
    expect(out).toContain('token=<redacted>');
    expect(hasControl(out)).toBe(false);
    expect(out).toContain('boom');
  });
});

describe('clampText：有界截断', () => {
  it('不超过上限时原样返回', () => {
    expect(clampText('abc', 5)).toBe('abc');
    expect(clampText('abcde', 5)).toBe('abcde');
  });

  it('超过上限时截断并追加省略号', () => {
    expect(clampText('abcdef', 5)).toBe('abcd…');
  });

  it('默认上限 120，结果长度不超过上限', () => {
    const long = 'x'.repeat(130);
    const out = clampText(long);
    expect(out).toBe(`${'x'.repeat(119)}…`);
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light' | 'system';
/** 对比度模式：默认 normal；high 强制 Fluent 高对比调色板。 */
export type Contrast = 'normal' | 'high';

const STORAGE_KEY = 'router-panel-theme';
const CONTRAST_KEY = 'router-panel-contrast';

interface ThemeState {
  theme: Theme;
  resolved: 'dark' | 'light';
  setTheme: (t: Theme) => void;
  /** 高对比开关（可选扩展，旧调用方可以忽略）。 */
  contrast: Contrast;
  setContrast: (c: Contrast) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

function systemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof localStorage === 'undefined') return defaultTheme;
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? defaultTheme;
  });
  const [contrast, setContrastState] = useState<Contrast>(() => {
    if (typeof localStorage === 'undefined') return 'normal';
    return localStorage.getItem(CONTRAST_KEY) === 'high' ? 'high' : 'normal';
  });
  const [resolved, setResolved] = useState<'dark' | 'light'>(() =>
    theme === 'system' ? systemTheme() : theme,
  );

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const next: 'dark' | 'light' = theme === 'system' ? systemTheme() : theme;
      root.classList.toggle('dark', next === 'dark');
      root.classList.toggle('light', next === 'light');
      root.style.colorScheme = next;
      setResolved(next);
    };
    apply();
    if (theme !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // 系统偏好高对比时也自动启用（可用手动开关覆盖回 normal）。
  useEffect(() => {
    const root = document.documentElement;
    const mq = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-contrast: more)')
      : null;
    const apply = () => {
      root.classList.toggle('high-contrast', contrast === 'high' || Boolean(mq?.matches));
    };
    apply();
    mq?.addEventListener('change', apply);
    return () => mq?.removeEventListener('change', apply);
  }, [contrast]);

  const value: ThemeState = {
    theme,
    resolved,
    setTheme: (t) => {
      try {
        localStorage.setItem(STORAGE_KEY, t);
      } catch {
        /* 隐私模式下 localStorage 可能不可写 */
      }
      setThemeState(t);
    },
    contrast,
    setContrast: (c) => {
      try {
        localStorage.setItem(CONTRAST_KEY, c);
      } catch {
        /* 同上 */
      }
      setContrastState(c);
    },
  };

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}

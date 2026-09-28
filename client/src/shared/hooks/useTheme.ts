import { useCallback, useEffect, useState } from 'react';

// public/common.js의 getPreferredTheme/setTheme/toggleTheme 포팅.
// localStorage 키('theme')를 그대로 써서 vanilla 페이지들과 테마 상태를 공유한다.
const THEME_STORAGE_KEY = 'theme';

type Theme = 'light' | 'dark';

function getPreferredTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => getPreferredTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}

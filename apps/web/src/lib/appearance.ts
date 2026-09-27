import { useEffect, useState } from 'react';
import { safeStorage } from './pwa';

export type ThemeMode = 'light' | 'dark' | 'system';
export type TextSize = 'normal' | 'large';

const storage = safeStorage();
const THEME_KEY = 'somar.theme';
const TEXT_KEY = 'somar.text';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Applies the chosen theme (resolving «system» from the device) and text size to <html>. */
function apply(mode: ThemeMode, text: TextSize) {
  const root = document.documentElement;
  const dark = mode === 'dark' || (mode === 'system' && Boolean(media?.matches));
  root.dataset.theme = dark ? 'dark' : 'light';
  if (text === 'large') root.dataset.text = 'large';
  else delete root.dataset.text;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0F1216' : '#C1121F');
}

function readTheme(): ThemeMode {
  const v = storage.get(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function readText(): TextSize {
  return storage.get(TEXT_KEY) === 'large' ? 'large' : 'normal';
}

/** Theme and text-size preferences for this device, kept in local storage. */
export function useAppearance() {
  const [theme, setThemeState] = useState<ThemeMode>(readTheme);
  const [text, setTextState] = useState<TextSize>(readText);

  useEffect(() => {
    apply(theme, text);
    if (theme !== 'system' || !media) return;
    const follow = () => apply('system', text);
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [theme, text]);

  return {
    theme,
    text,
    setTheme: (next: ThemeMode) => {
      storage.set(THEME_KEY, next);
      setThemeState(next);
    },
    setText: (next: TextSize) => {
      storage.set(TEXT_KEY, next);
      setTextState(next);
    },
  };
}

import { useCallback, useEffect, useState } from 'react';

export type DiffViewMode = 'unified' | 'split';

export interface DiffPrefs {
  mode: DiffViewMode;
  ignoreWhitespace: boolean;
}

export const DIFF_PREFS_DEFAULTS: DiffPrefs = {
  mode: 'unified',
  ignoreWhitespace: true,
};

const STORAGE_KEY = 'kanbots:diff-prefs';

function read(): DiffPrefs {
  if (typeof window === 'undefined') return DIFF_PREFS_DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DIFF_PREFS_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<DiffPrefs>;
    return { ...DIFF_PREFS_DEFAULTS, ...parsed };
  } catch {
    return DIFF_PREFS_DEFAULTS;
  }
}

function write(p: DiffPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // private mode / quota — fall through
  }
}

export function useDiffPrefs(): {
  prefs: DiffPrefs;
  set: <K extends keyof DiffPrefs>(key: K, value: DiffPrefs[K]) => void;
  toggleMode: () => void;
} {
  const [prefs, setPrefs] = useState<DiffPrefs>(() => read());

  useEffect(() => {
    write(prefs);
  }, [prefs]);

  const set = useCallback(<K extends keyof DiffPrefs>(key: K, value: DiffPrefs[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleMode = useCallback(() => {
    setPrefs((prev) => ({ ...prev, mode: prev.mode === 'unified' ? 'split' : 'unified' }));
  }, []);

  return { prefs, set, toggleMode };
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { applyTheme, defaultPrefs, loadPrefs, savePrefs, type Prefs } from '../lib/prefs.js';

/**
 * View preferences (theme, list/grid, density).
 *
 * Only these three values are ever stored, on the user's own machine, and only to remember how
 * they like the file browser. Nothing about their files or credentials touches storage.
 */
interface PrefsContextValue {
  prefs: Prefs;
  setPrefs: (next: Prefs) => void;
  toggleTheme: () => void;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function usePrefs(): PrefsContextValue {
  const value = useContext(PrefsContext);
  if (value === null) throw new Error('usePrefs must be used inside <PrefsProvider>');
  return value;
}

export function PrefsProvider({ children, initial }: { children: ReactNode; initial?: Prefs }) {
  const [prefs, setPrefsState] = useState<Prefs>(() => initial ?? loadPrefs());

  useEffect(() => {
    applyTheme(prefs.theme);
  }, [prefs.theme]);

  const setPrefs = useCallback((next: Prefs) => {
    setPrefsState(next);
    savePrefs(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setPrefsState((current) => {
      const next: Prefs = { ...current, theme: current.theme === 'dark' ? 'light' : 'dark' };
      savePrefs(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, setPrefs, toggleTheme }), [prefs, setPrefs, toggleTheme]);

  // The system default is only consulted on a first visit; after that the stored choice wins.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      if (loadPrefs() === null) return;
      setPrefsState((current) => ({ ...current, theme: event.matches ? 'dark' : 'light' }));
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export { defaultPrefs };

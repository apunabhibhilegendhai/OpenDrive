/**
 * Non-sensitive view preferences only: theme, list/grid, density.
 *
 * Nothing about a session, a file, a share token or a credential is ever written here. The
 * value is a single JSON object under one key so a future preference can be added without
 * scattering storage keys through the codebase.
 */
export type Theme = 'light' | 'dark';
export type ViewMode = 'list' | 'grid';
export type Density = 'comfortable' | 'compact';

export interface Prefs {
  theme: Theme;
  view: ViewMode;
  density: Density;
}

export const PREFS_KEY = 'opendrive.web.prefs';

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function defaultPrefs(): Prefs {
  return { theme: prefersDark() ? 'dark' : 'light', view: 'list', density: 'comfortable' };
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function isView(value: unknown): value is ViewMode {
  return value === 'list' || value === 'grid';
}

function isDensity(value: unknown): value is Density {
  return value === 'comfortable' || value === 'compact';
}

/** Read stored preferences, falling back per-field to the system-derived default. */
export function loadPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Prefs {
  const fallback = defaultPrefs();
  if (storage === null) return fallback;
  let raw: string | null;
  try {
    raw = storage.getItem(PREFS_KEY);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    return {
      theme: isTheme(record.theme) ? record.theme : fallback.theme,
      view: isView(record.view) ? record.view : fallback.view,
      density: isDensity(record.density) ? record.density : fallback.density,
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(
  prefs: Prefs,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A full or blocked storage area is not a reason to break the interface.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Apply the theme to the document so the token layer can switch on one attribute. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

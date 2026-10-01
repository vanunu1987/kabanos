import { create } from 'zustand'
import { api } from '../api'

export type ThemePref = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const KEY = 'kabanos.theme'
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: light)') : undefined

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark'
  } catch {
    return 'dark'
  }
}
const resolve = (pref: ThemePref): ResolvedTheme => (pref === 'system' ? (media?.matches ? 'light' : 'dark') : pref)

function apply(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
}

interface ThemeStore {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref(p: ThemePref): void
  /** Title-bar toggle: flip between light and dark (leaves "system" for an explicit choice). */
  toggle(): void
}

export const useTheme = create<ThemeStore>((set, get) => ({
  pref: readPref(),
  resolved: resolve(readPref()),
  setPref: (pref) => {
    try {
      localStorage.setItem(KEY, pref)
    } catch {
      /* not persisted */
    }
    const resolved = resolve(pref)
    apply(resolved)
    set({ pref, resolved })
    // Native dialogs, menus and the window background follow the app theme.
    void api.app.setTheme(pref).catch(() => undefined)
  },
  toggle: () => get().setPref(get().resolved === 'dark' ? 'light' : 'dark')
}))

/** Apply before the first render so there is no flash of the other theme. */
export function initTheme(): void {
  apply(useTheme.getState().resolved)
  void api.app.setTheme(useTheme.getState().pref).catch(() => undefined)
  media?.addEventListener('change', () => {
    const { pref } = useTheme.getState()
    if (pref !== 'system') return
    const resolved = resolve(pref)
    apply(resolved)
    useTheme.setState({ resolved })
  })
}

export const monacoTheme = (t: ResolvedTheme) => (t === 'light' ? 'kabanos-light' : 'kabanos-dark')
export function useMonacoTheme(): string {
  return monacoTheme(useTheme((s) => s.resolved))
}

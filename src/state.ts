import {
  createContext,
  // `createElement` rather than JSX: this module is a `.ts` file and stays
  // free of markup.
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { DashboardData, LiveSnapshot, PageId, Prefs, ToastMsg } from '../shared/types'
import { bridge } from './bridge'
import { useCustomCss } from './customCss'

export interface InitialPayload {
  prefs: Prefs
  dashboard: DashboardData
  storage: { file: string; bytes: number; recovered: boolean; healthy: boolean }
  version: string
  platform: string
  historyDays: { date: string; activeMs: number; onMs: number }[]
}

export function useAppInit() {
  const [initial, setInitial] = useState<InitialPayload | null>(null)
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const toastId = useRef(0)

  useEffect(() => {
    let cancelled = false
    bridge
      .getInitial()
      .then((res) => {
        if (cancelled) return
        setInitial(res)
        setPrefs(res.prefs)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    const offToast = bridge.toast((msg) => {
      const id = ++toastId.current
      setToasts((t) => [...t, { id, message: msg }])
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
    })
    const offPrefs = bridge.onPrefsChanged((p) => setPrefs(p))
    return () => {
      cancelled = true
      offToast()
      offPrefs()
    }
  }, [])

  const setPref = useCallback(async (key: keyof Prefs, value: string | number | boolean) => {
    const next = await bridge.setPref(key, value)
    setPrefs(next)
  }, [])

  return { initial, prefs, setPref, loading, toasts }
}

/**
 * Applies theme + transparency + motion to the document root.
 *
 * The accent tokens are deliberately *not* set from JS: they are defined in
 * the stylesheet per theme, so the palette is grayscale by construction and a
 * user's custom CSS can override them without a re-render.
 */
export function useThemeEffects(prefs: Prefs | null): void {
  useTheme(prefs)
  useCustomCss(prefs?.customCss ?? '')
}

/** Theme class, motion preference and window transparency. */
export function useTheme(prefs: Prefs | null): void {
  useEffect(() => {
    if (!prefs) return
    const root = document.documentElement
    root.dataset.theme = prefs.theme
    const glassy = prefs.theme === 'dark-glass' || prefs.theme === 'white-glass'
    root.dataset.glass = glassy ? '1' : '0'
    root.dataset.reducedMotion = prefs.reducedMotion ? 'true' : 'false'
    // Tell the main process which window class (opaque vs transparent) the
    // theme needs, so it can repaint the existing window when the class flips.
    void bridge.notifyThemeClass(glassy).catch(() => undefined)
    root.style.setProperty('--blur', `${Math.round(10 + (1 - prefs.transparency) * 18)}px`)
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
    if (glassy && bg) {
      root.style.setProperty('--backdrop', withAlphaCss(bg, Math.min(0.85, 0.25 + prefs.transparency * 0.6)))
    } else {
      root.style.setProperty('--backdrop', bg)
    }
  }, [prefs])
}

function withAlphaCss(color: string, alpha: number): string {
  const m = color.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s))
    const [r, g, b] = parts
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
  }
  return color
}

/**
 * The dashboard payload `getInitial` already paid for.
 *
 * It used to be fetched at startup and then thrown away, because the Dashboard
 * module was mounted long after and had no way to see it — so the home screen
 * rendered nothing until the next usage push arrived. Handing it down through
 * context costs nothing, paints the dashboard on the first frame, and removes
 * a redundant fetch.
 */
const DashboardSeedContext = createContext<DashboardData | null>(null)

export function DashboardSeedProvider({
  seed,
  children,
}: {
  seed: DashboardData | null
  children: ReactNode
}) {
  return createElement(DashboardSeedContext.Provider, { value: seed }, children)
}

/**
 * Live dashboard state.
 *
 * Seeds from the startup payload, then follows pushes. Falls back to one
 * explicit fetch when there is no seed, so the screen can never be left blank
 * waiting for a tick.
 */
export function useDashboard(): { dashboard: DashboardData | null; snapshot: LiveSnapshot | null } {
  const seed = useContext(DashboardSeedContext)
  const [pushed, setPushed] = useState<DashboardData | null>(null)
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)

  useEffect(() => {
    const offU = bridge.onUsageUpdated((d) => setPushed(d))
    const offS = bridge.snapshot((s) => setSnapshot(s))
    return () => {
      offU()
      offS()
    }
  }, [])

  // With no seed there is nothing on screen yet, so ask once rather than
  // waiting for the next push — which can be a minute away.
  useEffect(() => {
    if (seed) return
    let cancelled = false
    bridge
      .getDashboard()
      .then((d) => {
        if (!cancelled) setPushed(d)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [seed])

  // A seed change (startup finishing, or a reset) wins over older pushes.
  const dashboard = seed ?? pushed
  const live = snapshot ?? seed?.snapshot ?? pushed?.snapshot ?? null

  return useMemo(() => ({ dashboard, snapshot: live }), [dashboard, live])
}

export function useNavigation(initialPage: PageId = 'dashboard') {
  const [page, setPage] = useState<PageId>(initialPage)
  const [appDetailKey, setAppDetailKey] = useState<string | null>(null)

  useEffect(() => {
    const offPage = bridge.pageChanged((p) => {
      setPage(p)
      if (p !== 'apps') setAppDetailKey(null)
    })
    const offDetail = bridge.appDetailOpened((key) => {
      setPage('apps')
      setAppDetailKey(key)
    })
    return () => {
      offPage()
      offDetail()
    }
  }, [])

  const navigate = useCallback((p: PageId) => {
    setPage(p)
    if (p !== 'apps') setAppDetailKey(null)
  }, [])

  return { page, navigate, appDetailKey, setAppDetailKey }
}

export type { ToastMsg }

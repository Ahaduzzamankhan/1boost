import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * A one-shot focus target handed to a module: the palette and quick capture
 * ask "open notes, and show me this one" without the shell knowing anything
 * about how a module stores its list.
 */
export interface FocusTarget {
  /** Page id to open in Pages. */
  pageId?: string
  /** Task id to highlight in Tasks. */
  taskId?: string
  /** Monotonic marker so re-selecting the same row still re-focuses it. */
  nonce: number
}

export interface NavContextValue {
  focus: FocusTarget | null
  setFocus: (t: Omit<FocusTarget, 'nonce'> | null) => void
  clearFocus: () => void
}

const NavContext = createContext<NavContextValue>({
  focus: null,
  setFocus: () => undefined,
  clearFocus: () => undefined,
})

let nonce = 0

export function NavProvider({ children }: { children: ReactNode }) {
  const [focus, setFocusState] = useState<FocusTarget | null>(null)

  const setFocus = useCallback((t: Omit<FocusTarget, 'nonce'> | null) => {
    nonce += 1
    setFocusState(t ? { ...t, nonce } : null)
  }, [])
  const clearFocus = useCallback(() => setFocusState(null), [])

  const value = useMemo<NavContextValue>(
    () => ({ focus, setFocus, clearFocus }),
    [focus, setFocus, clearFocus],
  )
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

/** Modules consume this to react to palette / capture deep links. */
export function useFocusTarget(): NavContextValue {
  return useContext(NavContext)
}
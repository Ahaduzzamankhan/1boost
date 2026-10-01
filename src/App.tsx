import { useCallback, useEffect, useState } from 'react'
import { DashboardSeedProvider, useAppInit, useThemeEffects } from './state'
import { bridge } from './bridge'
import AppShell from './components/AppShell'
import { LoadingScreen } from './components/ui'

export default function App() {
  const { initial, prefs, loading, toasts } = useAppInit()
  useThemeEffects(prefs)
  const [storage, setStorage] = useState<{
    file: string
    bytes: number
    recovered: boolean
    healthy: boolean
  } | null>(initial?.storage ?? null)

  useEffect(() => {
    if (initial?.storage) setStorage(initial.storage)
  }, [initial])

  const onDelete = useCallback(async () => {
    try {
      const res = await bridge.clearData()
      if (res.ok) {
        const fresh = await bridge.getInitial()
        setStorage(fresh.storage)
        window.location.reload()
      }
    } catch {
      /* toast already surfaced by main */
    }
  }, [])

  if (loading) return <LoadingScreen />
  if (!prefs || !initial) {
    return (
      <LoadingScreen label="1Boost couldn't start tracking. Restart the app to try again." />
    )
  }
  return (
    <DashboardSeedProvider seed={initial.dashboard}>
      <AppShell
        prefs={prefs}
        toasts={toasts}
        storage={storage}
        onDelete={onDelete}
        version={initial.version}
      />
    </DashboardSeedProvider>
  )
}

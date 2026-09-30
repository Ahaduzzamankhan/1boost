import { createRoot } from 'react-dom/client'
import App from './App'
import { isTauriBackend } from './bridge'

// --- Desktop shell behavior (Tauri) ---------------------------------------
// The custom frameless titlebar has no -webkit-app-region in WebView2:
// forward mousedown on the titlebar to the Rust start_titlebar_drag command.
// Everything else stays app-UI: no browser context menu, no navigation.
if (isTauriBackend) {
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement | null
    if (!target) return
    const bar = target.closest('.titlebar') as HTMLElement | null
    if (!bar) return
    // Buttons inside the titlebar (min/max/close) must stay clickable.
    if (target.closest('button')) return
    e.preventDefault()
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('start_titlebar_drag'))
      .catch(() => undefined)
  })
}

// Suppress any webview context menu; the app shows its own custom menu via
// React (AppShell useContextMenu). Double-click on the titlebar toggles
// maximize like a native caption bar.
if (isTauriBackend) {
  document.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement | null
    if (!target || !target.closest('.titlebar') || target.closest('button')) return
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('toggle_maximize'))
      .catch(() => undefined)
  })
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}

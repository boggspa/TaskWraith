import './assets/main.css'

import { StrictMode } from 'react'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { HostProjectionProvider } from './components/HostProjectionProvider'
import { installWindowIdlePause } from './hooks/installWindowIdlePause'
import {
  loadWithoutReactPerformanceTracks,
  shouldDisableReactPerformanceTracks
} from './lib/reactPerformanceTracks'
import { PopoutApp } from './PopoutApp'

// Electron disables macOS occlusion tracking — pause ambient animations while
// the window is unfocused/hidden so a covered window does not composite at
// full display rate. Class sync is documentElement-side; CSS pauses play-state
// only (no transition:none — see useRailFrameRemeasure).
installWindowIdlePause()

const params = new URLSearchParams(window.location.search)
const popoutKind = params.get('popout')
const isUtilityPopout = Boolean(popoutKind && popoutKind !== 'chat')

async function startRenderer(): Promise<void> {
  const loadReactDomClient = () => import('react-dom/client')
  const reactDomClient = shouldDisableReactPerformanceTracks(
    import.meta.env.DEV,
    import.meta.env.VITE_REACT_PERFORMANCE_TRACKS
  )
    ? await loadWithoutReactPerformanceTracks(loadReactDomClient)
    : await loadReactDomClient()

  reactDomClient.createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* Host Arc 4.3c — the provider sits INSIDE ErrorBoundary (a provider
          throwing outside it would take down the boundary meant to catch it),
          and wraps the child EXPRESSION so both roots are covered: a popout
          window is a second app root, and wrapping only <App /> would leave
          popouts with no Host projection at all. */}
      <ErrorBoundary>
        <HostProjectionProvider>{isUtilityPopout ? <PopoutApp /> : <App />}</HostProjectionProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}

void startRenderer()

import './assets/main.css'

import { StrictMode } from 'react'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import {
  loadWithoutReactPerformanceTracks,
  shouldDisableReactPerformanceTracks
} from './lib/reactPerformanceTracks'
import { PopoutApp } from './PopoutApp'

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
      <ErrorBoundary>{isUtilityPopout ? <PopoutApp /> : <App />}</ErrorBoundary>
    </StrictMode>
  )
}

void startRenderer()

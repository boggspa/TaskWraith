import './assets/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UpdateDialogApp } from './components/UpdateDialogApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <UpdateDialogApp />
    </ErrorBoundary>
  </StrictMode>
)

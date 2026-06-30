import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Phase K1 — top-level error boundary. Prevents a render-time
 * exception in any descendant from leaving the BrowserWindow as a
 * blank gray rectangle. Without this, a thrown React error unmounts
 * the entire tree and the user has to restart the app — same visual
 * symptom as the accidental-navigation bug (which the `will-navigate`
 * guard in main now also catches).
 *
 * The fallback UI is intentionally inline-styled and uses no app
 * context (no IPC bridge, no theme provider) so even if our usual
 * styles or APIs are unavailable, the user sees a readable recovery
 * prompt with a "Reload window" button.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to console so it shows up in DevTools / log capture.

    console.error('[ErrorBoundary] caught render-time error', error, info)
  }

  handleReload = (): void => {
    try {
      window.location.reload()
    } catch {
      // Reload should never fail in a normal Electron renderer.
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          color: '#e7e7ea',
          background: '#1e1e1e',
          textAlign: 'center'
        }}
      >
        <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.75rem', fontWeight: 600 }}>
          TaskWraith hit a render error
        </h1>
        <p
          style={{
            margin: '0 0 1rem',
            maxWidth: '480px',
            lineHeight: 1.5,
            opacity: 0.85
          }}
        >
          The transcript surface failed to render. Your work is safe — reload to recover.
        </p>
        <pre
          id="error-boundary-details"
          style={{
            margin: '0 0 1.5rem',
            padding: '12px',
            background: '#111',
            border: '1px solid #333',
            borderRadius: '6px',
            maxWidth: '640px',
            maxHeight: '160px',
            overflow: 'auto',
            fontSize: '12px',
            textAlign: 'left',
            whiteSpace: 'pre-wrap'
          }}
        >
          {String(this.state.error.stack || this.state.error.message || this.state.error)}
        </pre>
        <button
          type="button"
          onClick={this.handleReload}
          aria-label="Reload TaskWraith window"
          aria-describedby="error-boundary-details"
          style={{
            padding: '8px 18px',
            border: '1px solid #555',
            background: '#2a2a2a',
            color: '#fff',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '14px'
          }}
        >
          Reload window
        </button>
      </div>
    )
  }
}

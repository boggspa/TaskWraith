import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'

interface PendingPairing {
  sessionID: string
  controllerDisplayName: string
  code: string
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 150,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'rgba(0, 0, 0, 0.48)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)'
  },
  panel: {
    width: 'min(420px, calc(100vw - 48px))',
    border: '1px solid var(--panel-border)',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--panel-bg-solid)',
    boxShadow: 'var(--shadow-lg)',
    padding: 24,
    color: 'var(--text-primary)',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  header: {
    margin: 0,
    fontSize: '1.25rem',
    lineHeight: 1.2,
    fontWeight: 700
  },
  label: {
    margin: '8px 0 0',
    color: 'var(--text-secondary)',
    fontSize: 'var(--font-size-sm)'
  },
  code: {
    margin: '20px 0',
    padding: '14px 18px',
    border: '1px solid color-mix(in srgb, var(--accent) 42%, var(--panel-border))',
    borderRadius: 'var(--radius-md)',
    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    color: 'var(--text-primary)',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '2rem',
    fontWeight: 750,
    letterSpacing: 0,
    textAlign: 'center'
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10
  },
  button: {
    appearance: 'none',
    border: '1px solid var(--panel-border)',
    borderRadius: 'var(--radius-md)',
    background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
    color: 'var(--text-primary)',
    font: 'inherit',
    fontWeight: 650,
    padding: '9px 13px',
    cursor: 'pointer'
  },
  primaryButton: {
    borderColor: 'color-mix(in srgb, var(--accent) 58%, var(--panel-border))',
    background: 'color-mix(in srgb, var(--accent) 20%, transparent)'
  },
  error: {
    margin: '0 0 14px',
    color: 'var(--danger)',
    fontSize: 'var(--font-size-sm)'
  }
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizePairingResponse(params: unknown): PendingPairing | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null
  }
  const record = params as Record<string, unknown>
  const sessionID = readString(record, 'sessionID') ?? readString(record, 'pairingSessionID')
  const controllerDisplayName = readString(record, 'controllerDisplayName') ?? 'iPhone'
  const code = readString(record, 'code') ?? readString(record, 'confirmationCode')
  if (!sessionID || !code) {
    return null
  }
  return { sessionID, controllerDisplayName, code }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function IncomingPairingPrompt(): ReactElement | null {
  const [pending, setPending] = useState<PendingPairing | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    return window.api.onBridgePairingResponseReceived((params) => {
      const next = normalizePairingResponse(params)
      if (next) {
        setPending(next)
        setError(null)
        setIsSubmitting(false)
      }
    })
  }, [])

  const finalize = async (userConfirmed: boolean): Promise<void> => {
    if (!pending) return
    setIsSubmitting(true)
    setError(null)
    try {
      await window.api.bridgeFinalizePairing(pending.sessionID, userConfirmed)
      setPending(null)
    } catch (err) {
      setError(formatError(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  useEffect(() => {
    if (!pending) return
    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null
    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
    }, 0)
    return () => {
      window.clearTimeout(focusTimer)
      const last = lastFocusedRef.current
      if (last && typeof last.focus === 'function') {
        try {
          last.focus()
        } catch {
          // element may be gone; ignore
        }
      }
    }
  }, [pending?.sessionID])

  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (isSubmitting) return
        event.preventDefault()
        void finalize(false)
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>('button:not([disabled])')
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (active && !root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isSubmitting, pending])

  if (!pending) {
    return null
  }

  const deviceLabel = pending.controllerDisplayName.trim() || 'A device'

  return (
    <div
      style={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || isSubmitting) return
        void finalize(false)
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="incoming-pairing-title"
        aria-describedby="incoming-pairing-description"
        style={styles.panel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="incoming-pairing-title" style={styles.header}>
          {deviceLabel} wants to pair
        </h2>
        <p id="incoming-pairing-description" style={styles.label}>
          {pending.controllerDisplayName}
        </p>
        <div style={styles.code} aria-label={`Pairing confirmation code ${pending.code}`}>
          {pending.code}
        </div>
        {error && (
          <p style={styles.error} role="alert">
            {error}
          </p>
        )}
        <div style={styles.actions}>
          <button
            type="button"
            style={styles.button}
            onClick={() => void finalize(false)}
            disabled={isSubmitting}
          >
            Codes don&apos;t match
          </button>
          <button
            type="button"
            style={{ ...styles.button, ...styles.primaryButton }}
            onClick={() => void finalize(true)}
            disabled={isSubmitting}
            autoFocus
          >
            Codes match
          </button>
        </div>
      </section>
    </div>
  )
}

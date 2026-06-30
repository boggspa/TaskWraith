import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/**
 * Phase K3 — Approval modal for creative-app actions that mutate state.
 *
 * Renders a queue of pending approval requests broadcast from the main
 * process via the `creative-action:request` IPC. Each modal shows:
 *  - The title + description of what's about to happen
 *  - The target app (bundle id) + file path / payload preview when relevant
 *  - Three controls: Approve, Approve & remember for session, Reject
 *
 * The "Approve & remember" choice maps to the session-class approval
 * cache in `CreativeApprovalGate` — subsequent identical-class requests
 * skip the modal until app restart. Used by K3 (FCP import), K4
 * (AppleScript), K5 (Blender Python) — same shape, different className.
 *
 * Multiple pending requests stack vertically (a queue), but only the
 * top one is interactive; the rest are dimmed. This avoids the
 * confusing case where two model agents race to ask for permission and
 * the user can't tell which click goes to which request.
 */

export interface CreativeApprovalRequestPayload {
  requestId: string
  className: string
  details: {
    title: string
    description: string
    filePath?: string
    targetBundleId?: string
    payloadPreview?: string
  }
}

interface CreativeActionApprovalModalProps {
  /** Subscribe to incoming approval requests from the main process. */
  onSubscribe: (handler: (request: CreativeApprovalRequestPayload) => void) => () => void
  /** Send the user's decision back to the main process. */
  onDecide: (requestId: string, approved: boolean, rememberForSession: boolean) => void
}

export function CreativeActionApprovalModal({
  onSubscribe,
  onDecide
}: CreativeActionApprovalModalProps): ReactElement | null {
  const [queue, setQueue] = useState<CreativeApprovalRequestPayload[]>([])
  // Track focus restoration so closing the modal returns the user to
  // wherever they were typing.
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const unsubscribe = onSubscribe((request) => {
      // Dedupe — main might re-broadcast on renderer reload. Keep
      // insertion order so the first asker stays at the head.
      setQueue((current) =>
        current.some((q) => q.requestId === request.requestId) ? current : [...current, request]
      )
    })
    return unsubscribe
  }, [onSubscribe])

  useEffect(() => {
    if (queue.length > 0) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null
    } else if (lastFocusedRef.current) {
      // Modal queue is empty — restore focus.
      try {
        lastFocusedRef.current.focus()
      } catch {
        /* element may have been unmounted */
      }
      lastFocusedRef.current = null
    }
  }, [queue.length])

  const handleDecide = useCallback(
    (requestId: string, approved: boolean, rememberForSession: boolean) => {
      onDecide(requestId, approved, rememberForSession)
      setQueue((current) => current.filter((q) => q.requestId !== requestId))
    },
    [onDecide]
  )

  useEffect(() => {
    if (queue.length === 0) return
    const activeRequest = queue[0]
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleDecide(activeRequest.requestId, false, false)
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
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
  }, [handleDecide, queue])

  if (queue.length === 0) return null

  // Render the top request as interactive; behind it, a small badge
  // shows how many more are queued so the user can tell they're
  // working through a stack.
  const active = queue[0]
  const remaining = queue.length - 1

  return createPortal(
    <div
      className="creative-approval-backdrop"
      role="presentation"
      onMouseDown={() => handleDecide(active.requestId, false, false)}
    >
      <div
        ref={dialogRef}
        className="creative-approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`creative-approval-title-${active.requestId}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="creative-approval-modal-header">
          <span className="creative-approval-modal-eyebrow" aria-hidden>
            Action approval
          </span>
          <h2
            id={`creative-approval-title-${active.requestId}`}
            className="creative-approval-modal-title"
          >
            {active.details.title}
          </h2>
        </header>
        <p className="creative-approval-modal-description">{active.details.description}</p>
        <dl className="creative-approval-modal-fields">
          {active.details.targetBundleId && (
            <div className="creative-approval-modal-field">
              <dt>Target app</dt>
              <dd>
                <code>{active.details.targetBundleId}</code>
              </dd>
            </div>
          )}
          {active.details.filePath && (
            <div className="creative-approval-modal-field">
              <dt>File</dt>
              <dd>
                <code title={active.details.filePath}>{active.details.filePath}</code>
              </dd>
            </div>
          )}
          <div className="creative-approval-modal-field">
            <dt>Action class</dt>
            <dd>
              <code>{active.className}</code>
            </dd>
          </div>
        </dl>
        {active.details.payloadPreview && (
          <details className="creative-approval-modal-preview" open>
            <summary>Preview</summary>
            <pre>{active.details.payloadPreview}</pre>
          </details>
        )}
        <footer className="creative-approval-modal-actions">
          <button
            type="button"
            className="creative-approval-modal-reject"
            onClick={() => handleDecide(active.requestId, false, false)}
          >
            Reject
          </button>
          <button
            type="button"
            className="creative-approval-modal-approve-once"
            onClick={() => handleDecide(active.requestId, true, false)}
          >
            Approve once
          </button>
          <button
            type="button"
            className="creative-approval-modal-approve-remember"
            onClick={() => handleDecide(active.requestId, true, true)}
            // Approve & remember picks up the user's "Approve once,
            // allow class for session" preference from the K-phase
            // kickoff — subsequent identical-class invocations skip
            // this modal until app restart.
            title={`Approve this and future ${active.className} actions until you quit TaskWraith.`}
          >
            Approve &amp; remember for session
          </button>
        </footer>
        {remaining > 0 && (
          <div className="creative-approval-modal-badge" aria-live="polite">
            +{remaining} more {remaining === 1 ? 'request' : 'requests'} queued
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

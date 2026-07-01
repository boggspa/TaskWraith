import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord } from '../../../main/store/types'
import { MarkdownMessage } from './MarkdownMessage'

export interface ProposedPlanApprovalModalProps {
  open: boolean
  title: string
  body: string
  chat?: ChatRecord
  isEnsemble?: boolean
  onApprove: (planBody: string) => void
  onDeny: () => void
  onCancel: () => void
}

/**
 * Full-screen approval modal for a proposed plan.
 *
 * Mirrors the creative-action approval chrome so it reuses the existing
 * backdrop / modal / header / action styling. Lets the user Deny, Edit,
 * Cancel, or Approve the plan. Editing is local to the modal; Approve always
 * sends the current edited body.
 */
export function ProposedPlanApprovalModal({
  open,
  title,
  body,
  chat,
  isEnsemble,
  onApprove,
  onDeny,
  onCancel
}: ProposedPlanApprovalModalProps): ReactElement | null {
  const [draftBody, setDraftBody] = useState(body)
  const [isEditing, setIsEditing] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  // Reset local state whenever the modal opens/closes.
  useEffect(() => {
    if (open) {
      setDraftBody(body)
      setIsEditing(false)
      setSubmitted(false)
      lastFocusedRef.current = document.activeElement as HTMLElement | null
    } else if (lastFocusedRef.current) {
      try {
        lastFocusedRef.current.focus()
      } catch {
        /* element may have been unmounted */
      }
      lastFocusedRef.current = null
    }
  }, [open, body])

  // Escape cancels the modal; Tab traps focus inside the dialog.
  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
  }, [open, onCancel])

  const fire = (action: () => void): void => {
    if (submitted) return
    setSubmitted(true)
    action()
  }

  if (!open) return null

  return createPortal(
    <div
      className="creative-approval-backdrop"
      role="presentation"
      onMouseDown={onCancel}
    >
      <div
        ref={dialogRef}
        className="creative-approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proposed-plan-approval-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="creative-approval-modal-header">
          <span className="creative-approval-modal-eyebrow" aria-hidden>
            Proposed plan
          </span>
          <h2 id="proposed-plan-approval-title" className="creative-approval-modal-title">
            {title}
          </h2>
        </header>

        <p className="creative-approval-modal-description">
          Approve this plan to switch from read-only review to implementation.
          {isEnsemble && (
            <>
              {' '}
              Approving lets all participants continue with Default Approval.
            </>
          )}
        </p>

        {isEditing ? (
          <textarea
            className="creative-approval-modal-preview"
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            rows={Math.min(24, Math.max(6, draftBody.split('\n').length + 1))}
            autoFocus
            aria-label="Edit the plan before approving"
          />
        ) : (
          <div className="creative-approval-modal-preview">
            <MarkdownMessage content={draftBody} chat={chat || undefined} />
          </div>
        )}

        <footer className="creative-approval-modal-actions">
          <button
            type="button"
            className="creative-approval-modal-reject"
            disabled={submitted}
            onClick={() => fire(onDeny)}
          >
            Deny
          </button>
          <button
            type="button"
            className="creative-approval-modal-approve-once"
            disabled={submitted}
            onClick={() => {
              if (isEditing) {
                setIsEditing(false)
              } else {
                setIsEditing(true)
              }
            }}
          >
            {isEditing ? 'Cancel edit' : 'Edit'}
          </button>
          <button
            type="button"
            className="creative-approval-modal-reject"
            disabled={submitted}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="creative-approval-modal-approve-remember"
            disabled={submitted || !draftBody.trim()}
            onClick={() => fire(() => onApprove(draftBody.trim()))}
          >
            Approve
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

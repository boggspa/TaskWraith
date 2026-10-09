import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

interface TrustedSessionConfirmSheetProps {
  subjectLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

export function TrustedSessionConfirmSheet({
  subjectLabel = 'this lane',
  onCancel,
  onConfirm
}: TrustedSessionConfirmSheetProps): ReactElement {
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return createPortal(
    <div className="creative-approval-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="creative-approval-modal approval-elevation-modal trusted-session-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trusted-session-title"
        data-elevation-tier="2"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="creative-approval-modal-header">
          <span className="creative-approval-modal-eyebrow" aria-hidden>
            Full Access
          </span>
          <h2 id="trusted-session-title" className="creative-approval-modal-title">
            Start Full Access for {subjectLabel}?
          </h2>
        </header>

        <p className="creative-approval-modal-description">
          Full Access lets this chat or participant lane use available native tools, run commands
          outside the workspace sandbox, and change files without TaskWraith approval cards.
        </p>
        <p className="creative-approval-modal-description approval-elevation-caution">
          Destructive actions, external publishing and media recording are included. Other chats and
          participants are unchanged. Provider sign-in and operating-system permission prompts still
          apply.
        </p>

        <label className="approval-elevation-ack" htmlFor="trusted-session-ack">
          <input
            id="trusted-session-ack"
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            I understand this applies only to {subjectLabel} and stays active until I lower that
            lane&apos;s permission or restart TaskWraith.
          </span>
        </label>

        <footer className="creative-approval-modal-actions">
          <button
            type="button"
            className="creative-approval-modal-reject"
            title="Keep normal approval prompts."
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="creative-approval-modal-approve-once"
            title={`Start Full Access for ${subjectLabel}.`}
            onClick={onConfirm}
            disabled={!acknowledged}
          >
            Start Full Access
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

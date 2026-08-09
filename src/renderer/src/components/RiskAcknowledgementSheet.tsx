import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface RiskAcknowledgementSheetSurfaceProps {
  titleId: string
  eyebrow: string
  title: ReactNode
  description: ReactNode
  caution?: ReactNode
  acknowledgementId?: string
  acknowledgementLabel?: ReactNode
  acknowledged: boolean
  onAcknowledgedChange: (next: boolean) => void
  onCancel: () => void
  onConfirm: () => void
  cancelLabel?: string
  cancelTitle?: string
  confirmLabel: string
  confirmTitle?: string
  riskLevel?: 'standard' | 'high'
}

/**
 * Shared warning surface for permission changes that can suppress TaskWraith
 * approval prompts. It deliberately owns the same modal chrome and explicit
 * acknowledgement gate used by Full WS Access and Full Access.
 */
export function RiskAcknowledgementSheetSurface({
  titleId,
  eyebrow,
  title,
  description,
  caution,
  acknowledgementId,
  acknowledgementLabel,
  acknowledged,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
  cancelLabel = 'Cancel',
  cancelTitle,
  confirmLabel,
  confirmTitle,
  riskLevel = 'high'
}: RiskAcknowledgementSheetSurfaceProps): ReactElement {
  const requiresAcknowledgement = Boolean(acknowledgementId && acknowledgementLabel)

  return (
    <div className="creative-approval-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="creative-approval-modal approval-elevation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-elevation-tier={riskLevel === 'high' ? 2 : 1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="creative-approval-modal-header">
          <span className="creative-approval-modal-eyebrow" aria-hidden>
            {eyebrow}
          </span>
          <h2 id={titleId} className="creative-approval-modal-title">
            {title}
          </h2>
        </header>

        <p className="creative-approval-modal-description">{description}</p>
        {caution && (
          <p className="creative-approval-modal-description approval-elevation-caution">
            {caution}
          </p>
        )}
        {requiresAcknowledgement && (
          <label className="approval-elevation-ack" htmlFor={acknowledgementId}>
            <input
              id={acknowledgementId}
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => onAcknowledgedChange(event.target.checked)}
            />
            <span>{acknowledgementLabel}</span>
          </label>
        )}

        <footer className="creative-approval-modal-actions">
          <button
            type="button"
            className="creative-approval-modal-reject"
            title={cancelTitle}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="creative-approval-modal-approve-once"
            title={confirmTitle}
            onClick={onConfirm}
            disabled={requiresAcknowledgement && !acknowledged}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}

export type RiskAcknowledgementSheetProps = Omit<
  RiskAcknowledgementSheetSurfaceProps,
  'acknowledged' | 'onAcknowledgedChange'
>

export function RiskAcknowledgementSheet({
  onCancel,
  ...surfaceProps
}: RiskAcknowledgementSheetProps): ReactElement {
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
    <RiskAcknowledgementSheetSurface
      {...surfaceProps}
      onCancel={onCancel}
      acknowledged={acknowledged}
      onAcknowledgedChange={setAcknowledged}
    />,
    document.body
  )
}

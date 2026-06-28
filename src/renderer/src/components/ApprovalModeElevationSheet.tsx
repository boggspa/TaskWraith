import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ApprovalElevationTier } from '../lib/approvalElevation'

/**
 * Permission-mode ELEVATION warning sheet (mirrors the Claude / Codex desktop
 * failsafes). Shown when the user raises the approval mode:
 *  - Tier 1 → Default Approval: small, reassuring (shown once per workspace+provider).
 *  - Tier 2 → Full Workspace Access: larger, stern, with an explicit
 *    "I understand the risks" confirm gate.
 *
 * Presentational + storage-agnostic: the decision (which tier, whether to show,
 * once-vs-every-time) lives in lib/approvalElevation; persistence + the picker
 * interception are wired by the caller. Reuses the existing creative-approval
 * modal theming so it adds no new CSS (the polish pass can restyle later).
 */

interface ApprovalModeElevationSheetProps {
  tier: ApprovalElevationTier
  provider: string
  workspaceLabel?: string | null
  onCancel: () => void
  onConfirm: () => void
}

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor'
}

function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? (provider.charAt(0).toUpperCase() + provider.slice(1))
}

export function ApprovalModeElevationSheet({
  tier,
  provider,
  workspaceLabel,
  onCancel,
  onConfirm
}: ApprovalModeElevationSheetProps): ReactElement {
  const [acknowledged, setAcknowledged] = useState(false)
  const name = providerLabel(provider)
  const where = workspaceLabel && workspaceLabel.trim() !== '' ? workspaceLabel : 'this workspace'
  const isFull = tier === 2
  const canConfirm = !isFull || acknowledged

  // Escape cancels (dismiss = stay at the lower, safer mode).
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
        className="creative-approval-modal approval-elevation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-elevation-title"
        data-elevation-tier={tier}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="creative-approval-modal-header">
          <span className="creative-approval-modal-eyebrow" aria-hidden>
            {isFull ? 'Full Workspace Access' : 'Permission change'}
          </span>
          <h2 id="approval-elevation-title" className="creative-approval-modal-title">
            {isFull
              ? `Enable Full Workspace Access for ${name}?`
              : `Let ${name} edit files in ${where}?`}
          </h2>
        </header>

        {isFull ? (
          <>
            <p className="creative-approval-modal-description">
              Full Workspace Access lets {name} create, edit, run, and delete files in {where}{' '}
              <strong>without approving each action</strong>. Once enabled there is no per-step
              confirmation — it can modify or remove anything in the workspace autonomously.
            </p>
            <p className="creative-approval-modal-description approval-elevation-caution">
              Only enable this on a disposable VM or a device you can fully recover. You can revoke
              it at any time from the permission picker.
            </p>
            <label className="approval-elevation-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>I understand the risks and am on a disposable or recoverable device.</span>
            </label>
          </>
        ) : (
          <p className="creative-approval-modal-description">
            In Default Approval, {name} can create, edit, and delete files in {where}. You still see
            every change and can drop back to Read-only at any time. This notice shows once per
            workspace.
          </p>
        )}

        <footer className="creative-approval-modal-actions">
          <button
            type="button"
            className="creative-approval-modal-reject"
            title="Keep the current safer permission mode."
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="creative-approval-modal-approve-once"
            title={
              isFull
                ? `Let ${name} create, edit, run, and delete files in ${where} without per-step prompts until you lower the mode.`
                : `Let ${name} edit files in ${where}; individual risky actions can still be reviewed.`
            }
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {isFull ? 'Enable Full Access' : 'Continue'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

import React from 'react'
import { LinkCircleSymbolIcon } from './AppChromeSymbols'

export interface HumanCollaborationInviteComposerControlProps {
  active?: boolean
  disabled?: boolean
  onCopyInvite?: () => void
}

export function HumanCollaborationInviteComposerControl({
  active = false,
  disabled = false,
  onCopyInvite
}: HumanCollaborationInviteComposerControlProps): React.JSX.Element | null {
  if (!active || !onCopyInvite) return null
  return (
    <button
      type="button"
      className="composer-human-invite-button composer-hint-pill composer-hint-pill--left"
      data-hint-label="Copy People invite"
      onClick={onCopyInvite}
      disabled={disabled}
      title="Create and copy a fresh People invite for this shared chat."
      aria-label="Create and copy a fresh People invite"
    >
      <LinkCircleSymbolIcon />
      <span className="human-collaboration-live-dot" aria-hidden />
      <span className="composer-human-invite-label">New invite</span>
    </button>
  )
}

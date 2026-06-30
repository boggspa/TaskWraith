import React, { useEffect, useRef, useState } from 'react'
import type { HumanCollaborationShare } from '../../../main/collaboration/HumanCollaborationStore'
import type {
  HumanCollaborationInviteCopyResult,
  HumanCollaborationInviteHealth
} from '../lib/humanCollaborationInviteHealth'
import { LinkCircleSymbolIcon } from './AppChromeSymbols'

export interface HumanCollaborationInviteComposerControlProps {
  active?: boolean
  disabled?: boolean
  share?: HumanCollaborationShare | null
  health?: HumanCollaborationInviteHealth | null
  live?: boolean
  busy?: boolean
  defaultOpen?: boolean
  onCopyInvite?: (options?: { allowLanOnly?: boolean }) =>
    | Promise<HumanCollaborationInviteCopyResult>
    | HumanCollaborationInviteCopyResult
    | void
  onCopyInviteText?: (invitePayload: string) => Promise<boolean> | boolean
  onStopSharing?: () => void
  onOpenRemoteSetup?: () => void
  onRefreshHealth?: () => Promise<HumanCollaborationInviteHealth> | HumanCollaborationInviteHealth | void
}

export function HumanCollaborationInviteComposerControl({
  active = false,
  disabled = false,
  share,
  health,
  live = false,
  busy = false,
  defaultOpen = false,
  onCopyInvite,
  onCopyInviteText,
  onStopSharing,
  onOpenRemoteSetup,
  onRefreshHealth
}: HumanCollaborationInviteComposerControlProps): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const [localBusy, setLocalBusy] = useState(false)
  const [result, setResult] = useState<HumanCollaborationInviteCopyResult | null>(null)
  const [status, setStatus] = useState('')
  const [manualInvite, setManualInvite] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open || !onRefreshHealth) return
    void Promise.resolve(onRefreshHealth()).catch(() => {})
  }, [onRefreshHealth, open])

  useEffect(() => {
    setResult(null)
    setStatus('')
    setManualInvite('')
  }, [share?.shareId])

  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [open])

  if (!active || !share || !onCopyInvite) return null

  const activeCollaborators = share.participants.filter(
    (participant) => participant.status === 'active'
  )
  const pendingCollaborators = share.participants.filter(
    (participant) => participant.status === 'pending'
  )
  const modeLabel = share.mode === 'readOnly' ? 'Read-only' : 'Comments'
  const copyBusy = busy || localBusy
  const bridgeLabel = !health
    ? 'Checking'
    : health.bridgeRunning
      ? 'Running'
      : health.bridgeEnabled
        ? 'Stopped'
        : 'Off'
  const lanLabel = health?.lanAvailable ? 'Ready' : 'Unavailable'
  const remoteLabel = health?.remoteAvailable ? 'Ready' : 'Setup needed'
  const latestResult = result && !result.ok ? result : null
  const showLanOnlyAction = Boolean(
    latestResult?.code === 'no-relay-url' && latestResult.canCopyLanOnly && latestResult.invitePayload
  )
  const showManualInvite = Boolean(manualInvite)

  const copyFreshInvite = async (allowLanOnly = false): Promise<void> => {
    setLocalBusy(true)
    setStatus('')
    setManualInvite('')
    try {
      const next = await Promise.resolve(onCopyInvite({ allowLanOnly }))
      if (!next) return
      setResult(next)
      setStatus(next.message)
      if (!next.ok && next.code === 'clipboard-failed' && next.invitePayload) {
        setManualInvite(next.invitePayload)
      }
    } finally {
      setLocalBusy(false)
    }
  }

  const copyExistingPayload = async (): Promise<void> => {
    const payload = latestResult?.invitePayload
    if (!payload || !onCopyInviteText) return
    setLocalBusy(true)
    try {
      const copied = await Promise.resolve(onCopyInviteText(payload))
      if (copied) {
        setManualInvite('')
        setStatus('LAN-only People invite copied.')
      } else {
        setManualInvite(payload)
        setStatus('Clipboard copy failed. The invite is shown below so you can copy it manually.')
      }
    } finally {
      setLocalBusy(false)
    }
  }

  return (
    <span className="composer-human-invite-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-human-invite-button composer-hint-pill composer-hint-pill--left${open ? ' is-open' : ''}`}
        data-hint-label="People share"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        title="Open People sharing controls for this chat."
        aria-label="Open People sharing controls"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <LinkCircleSymbolIcon />
        <span className="human-collaboration-live-dot" aria-hidden />
        <span className="composer-human-invite-label">New invite</span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="composer-human-invite-popover"
          role="dialog"
          aria-label="People sharing"
        >
          <div className="composer-human-invite-popover-head">
            <div>
              <span className="composer-human-invite-kicker">People share</span>
              <strong>Copy fresh invite</strong>
            </div>
            <span className={`composer-human-invite-live-state${live ? ' is-live' : ''}`}>
              {live ? 'Live' : 'Idle'}
            </span>
          </div>

          <dl className="composer-human-invite-status-grid">
            <div>
              <dt>Mode</dt>
              <dd>{modeLabel}</dd>
            </div>
            <div>
              <dt>Collaborators</dt>
              <dd>
                {activeCollaborators.length}
                {pendingCollaborators.length > 0 ? ` + ${pendingCollaborators.length} pending` : ''}
              </dd>
            </div>
            <div>
              <dt>Bridge</dt>
              <dd>{bridgeLabel}</dd>
            </div>
            <div>
              <dt>LAN</dt>
              <dd>{lanLabel}</dd>
            </div>
            <div>
              <dt>Remote</dt>
              <dd>{remoteLabel}</dd>
            </div>
          </dl>

          {activeCollaborators.length > 0 ? (
            <div className="composer-human-invite-collaborators">
              {activeCollaborators.map((participant) => (
                <span key={participant.collaboratorId}>{participant.displayName || 'Guest'}</span>
              ))}
            </div>
          ) : (
            <div className="composer-human-invite-empty">No active collaborators.</div>
          )}

          {status && (
            <div
              className={`composer-human-invite-message${latestResult ? ' is-warning' : ''}`}
              role={latestResult ? 'alert' : 'status'}
            >
              {status}
            </div>
          )}

          {health?.bridgeError && !health.bridgeRunning && (
            <div className="composer-human-invite-message is-warning">{health.bridgeError}</div>
          )}

          {showManualInvite && (
            <textarea
              className="composer-human-invite-manual"
              value={manualInvite}
              readOnly
              aria-label="People invite payload"
              onFocus={(event) => event.currentTarget.select()}
            />
          )}

          <div className="composer-human-invite-actions">
            <button
              type="button"
              className="composer-human-invite-primary"
              disabled={disabled || copyBusy}
              onClick={() => void copyFreshInvite(false)}
            >
              {copyBusy ? 'Preparing...' : 'Copy fresh invite'}
            </button>
            {showLanOnlyAction && (
              <button
                type="button"
                className="composer-human-invite-secondary"
                disabled={disabled || copyBusy}
                onClick={() => void copyExistingPayload()}
              >
                Copy LAN-only invite
              </button>
            )}
            {(latestResult?.code === 'bridge-stopped' || latestResult?.code === 'no-relay-url') && (
              <button
                type="button"
                className="composer-human-invite-secondary"
                onClick={onOpenRemoteSetup}
              >
                Open remote setup
              </button>
            )}
            <button
              type="button"
              className="composer-human-invite-danger"
              onClick={onStopSharing}
            >
              Stop sharing
            </button>
          </div>
        </div>
      )}
    </span>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownMessage } from './MarkdownMessage'

/**
 * Collaborator-side "Join shared chat" flow (L5-2 / L6-2). Three steps:
 *   paste  → paste the host's invite JSON + a display name, dial in
 *   sas    → compare the 6-digit code with the host OUT OF BAND, then confirm
 *   viewing→ live read-only projection of the host's transcript (+ comment box)
 *
 * All transport/crypto lives in main (HumanCollaborationCollaboratorClient via
 * the human-collaboration-collaborator:* IPC); this is purely UI + orchestration.
 */
type Step = 'paste' | 'connecting' | 'sas' | 'viewing'
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected'

export interface ParsedHumanCollaborationInvite {
  shareId: string
  chatId: string
  inviteToken: string
  mode: 'readOnly' | 'comments'
  relayUrl: string
  relayUrls: string[]
  roomId: string
  hostIdentityPubKeyB64?: string
}

interface ProjectionRow {
  id: string
  role: 'host' | 'assistant' | 'collaborator' | 'placeholder'
  speaker: string
  preview: string
  truncated: boolean
  timestamp: string
  sequence?: number
}
interface Projection {
  title: string
  mode: 'readOnly' | 'comments'
  rows: ProjectionRow[]
  participants: Array<{ collaboratorId: string; displayName: string; status: string }>
  totalRows: number
}

function bubbleClass(role: ProjectionRow['role']): string {
  if (role === 'host') return 'message-bubble user'
  if (role === 'assistant') return 'message-bubble assistant'
  if (role === 'collaborator') return 'message-bubble system human-collaborator-comment'
  return 'message-bubble system join-projection-placeholder'
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function decodeInvitePayload(value: string): string {
  const trimmed = value.trim()
  try {
    return decodeURIComponent(trimmed)
  } catch {
    // Fall through to base64url.
  }
  try {
    const padded = trimmed.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(trimmed.length / 4) * 4, '=')
    return atob(padded)
  } catch {
    return trimmed
  }
}

function parseInviteText(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Paste the invite the host shared with you.')
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    // Accept link-shaped invites too:
    // taskwraith://join-shared-chat?invite=<encoded-json-or-base64url-json>
    // https://.../join?invite=<encoded-json-or-base64url-json>
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new Error('That does not look like a valid invite. Paste the JSON or invite link the host copied.')
    }
    const hashParams = url.hash.startsWith('#') ? new URLSearchParams(url.hash.slice(1)) : null
    const encoded =
      url.searchParams.get('invite') ||
      url.searchParams.get('payload') ||
      hashParams?.get('invite') ||
      hashParams?.get('payload') ||
      (url.hash.length > 1 ? url.hash.slice(1) : '')
    if (!encoded) {
      throw new Error('That invite link is missing its invite payload.')
    }
    try {
      return JSON.parse(decodeInvitePayload(encoded)) as Record<string, unknown>
    } catch {
      throw new Error('That invite link contains an unreadable invite payload.')
    }
  }
}

export function parseHumanCollaborationInvite(raw: string): ParsedHumanCollaborationInvite {
  const invite = parseInviteText(raw)
  if (invite?.type !== 'taskwraith-human-collaboration-invite') {
    throw new Error('That JSON is not a TaskWraith collaboration invite.')
  }
  const shareId = asNonEmptyString(invite.shareId)
  const chatId = asNonEmptyString(invite.chatId)
  const inviteToken = asNonEmptyString(invite.inviteToken)
  const roomId = asNonEmptyString(invite.roomId)
  const relayUrls = Array.from(
    new Set(
      [
        ...(Array.isArray(invite.relayUrls) ? invite.relayUrls : []),
        invite.relayUrl
      ]
        .map(asNonEmptyString)
        .filter((url): url is string => Boolean(url))
    )
  )
  if (!shareId || !chatId || !inviteToken || !roomId) {
    throw new Error('This invite is missing required share information. Ask the host for a fresh invite.')
  }
  if (relayUrls.length === 0) {
    throw new Error('This invite has no connection info — the host needs remote access ON, then a fresh invite.')
  }
  return {
    shareId,
    chatId,
    inviteToken,
    mode: invite.mode === 'readOnly' ? 'readOnly' : 'comments',
    relayUrl: relayUrls[0],
    relayUrls,
    roomId,
    ...(typeof invite.hostIdentityPubKeyB64 === 'string' && invite.hostIdentityPubKeyB64.trim()
      ? { hostIdentityPubKeyB64: invite.hostIdentityPubKeyB64.trim() }
      : {})
  }
}

export function JoinSharedChatModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>('paste')
  const [inviteText, setInviteText] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sasCode, setSasCode] = useState('')
  const [mode, setMode] = useState<'readOnly' | 'comments'>('comments')
  const [projection, setProjection] = useState<Projection | null>(null)
  const [comment, setComment] = useState('')
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [busy, setBusy] = useState(false)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  // Live projection + status while the modal is open.
  useEffect(() => {
    if (!open) return
    const off = window.api.onHumanCollaborationCollaboratorProjection?.((payload) =>
      setProjection(payload.projection as Projection)
    )
    const offStatus = window.api.onHumanCollaborationCollaboratorStatus?.((payload) => {
      if (payload.connected === true) setConnectionState('connected')
      else if (payload.connected === false) setConnectionState('disconnected')
      if (payload.error) {
        setError(payload.error)
        setConnectionState('disconnected')
      }
    })
    return () => {
      off?.()
      offStatus?.()
    }
  }, [open])

  // Reset everything when the modal closes.
  useEffect(() => {
    if (open) return
    setStep('paste')
    setInviteText('')
    setDisplayName('')
    setError(null)
    setConnectionState('idle')
    setSasCode('')
    setProjection(null)
    setComment('')
    setBusy(false)
  }, [open])

  // Keep the projection pinned to the latest row.
  useEffect(() => {
    if (step === 'viewing') rowsRef.current?.scrollTo({ top: rowsRef.current.scrollHeight })
  }, [projection, step])

  const leaveAndClose = useCallback(() => {
    void window.api.humanCollaborationCollaboratorLeave?.()
    onClose()
  }, [onClose])

  const requestLeave = useCallback(() => {
    if (step === 'viewing' || step === 'sas') {
      if (!window.confirm('Leave this shared chat?')) return
    }
    leaveAndClose()
  }, [leaveAndClose, step])

  useEffect(() => {
    if (!open) return
    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null
    const focusTimer = window.setTimeout(() => {
      const el = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
      )
      el?.focus()
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
  }, [open, step])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (busy) return
        event.preventDefault()
        if (step === 'paste' || step === 'connecting' || step === 'sas') {
          leaveAndClose()
        } else if (step === 'viewing') {
          requestLeave()
        }
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
  }, [busy, leaveAndClose, open, requestLeave, step])

  const handleJoin = useCallback(async () => {
    setError(null)
    let invite: ParsedHumanCollaborationInvite
    try {
      invite = parseHumanCollaborationInvite(inviteText)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That does not look like a valid invite.')
      setConnectionState('disconnected')
      return
    }
    setBusy(true)
    setConnectionState('connecting')
    setStep('connecting')
    try {
      const res = await window.api.humanCollaborationCollaboratorJoin({
        shareId: invite.shareId,
        chatId: invite.chatId,
        inviteToken: invite.inviteToken,
        displayName: displayName.trim() || 'Guest',
        mode: invite.mode,
        relayUrl: invite.relayUrl,
        relayUrls: invite.relayUrls,
        roomId: invite.roomId,
        hostIdentityPubKeyB64: invite.hostIdentityPubKeyB64
      })
      setSasCode(res.confirmCode)
      setMode(res.mode)
      setStep('sas')
      setConnectionState('connecting')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect to the shared chat.')
      setConnectionState('disconnected')
      void window.api.humanCollaborationCollaboratorLeave?.()
      setStep('paste')
    } finally {
      setBusy(false)
    }
  }, [inviteText, displayName])

  const handleSasMatch = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await window.api.humanCollaborationCollaboratorConfirm()
      setStep('viewing')
      setConnectionState('connected')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the session.')
      setConnectionState('disconnected')
    } finally {
      setBusy(false)
    }
  }, [])

  const connectionLabel =
    connectionState === 'connected'
      ? 'Connected'
      : connectionState === 'connecting'
        ? 'Connecting…'
        : connectionState === 'disconnected'
          ? 'Disconnected'
          : 'Not connected'

  const connectionClassName =
    connectionState === 'connected'
      ? 'join-connection-status is-connected'
      : connectionState === 'disconnected'
        ? 'join-connection-status is-disconnected'
        : connectionState === 'connecting'
          ? 'join-connection-status is-connecting'
          : 'join-connection-status'

  const handleSendComment = useCallback(async () => {
    const text = comment.trim()
    if (!text) return
    setComment('')
    try {
      await window.api.humanCollaborationCollaboratorAppendComment({ content: text })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the comment.')
    }
  }, [comment])

  if (!open) return null

  const backdropDismissible = step === 'paste' || step === 'connecting'

  return createPortal(
    <div
      className="creative-approval-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (backdropDismissible && !busy) leaveAndClose()
      }}
    >
      <div
        ref={dialogRef}
        className="creative-approval-modal join-shared-chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Join a shared chat"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="creative-approval-modal-eyebrow">Collaborate · People</div>

        {step === 'paste' || step === 'connecting' ? (
          <>
            <h2 className="creative-approval-modal-title">Join a shared chat</h2>
            <div className={connectionClassName}>Connection: {connectionLabel}</div>
            <p className="creative-approval-modal-description">
              Paste the invite the host shared with you, then verify the 6-digit code together.
            </p>
            <label className="join-field-label" htmlFor="join-shared-chat-display-name">
              Your name (shown to the host)
            </label>
            <input
              id="join-shared-chat-display-name"
              className="join-text-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Olly"
              maxLength={80}
            />
            <label className="join-field-label" htmlFor="join-shared-chat-invite">
              Invite
            </label>
            <textarea
              id="join-shared-chat-invite"
              className="join-invite-textarea"
              value={inviteText}
              onChange={(e) => setInviteText(e.target.value)}
              placeholder="Paste the invite JSON here…"
              rows={5}
              spellCheck={false}
            />
            {error && <div className="join-error" role="alert">{error}</div>}
            <div className="join-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={leaveAndClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={handleJoin}
                disabled={busy || step === 'connecting' || !inviteText.trim()}
              >
                {step === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </>
        ) : null}

        {step === 'sas' ? (
          <>
            <h2 className="creative-approval-modal-title">Compare the code</h2>
            <div className={connectionClassName}>Connection: {connectionLabel}</div>
            <p className="creative-approval-modal-description">
              The host sees a 6-digit code too. Confirm out of band (call/message) that these match
              before joining — this is what stops an imposter in the middle.
            </p>
            <div className="join-sas-code" aria-label="Security code">{sasCode}</div>
            {error && <div className="join-error" role="alert">{error}</div>}
            <div className="join-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={requestLeave} disabled={busy}>
                Codes don&apos;t match
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={handleSasMatch} disabled={busy}>
                {busy ? 'Joining…' : 'Codes match — join'}
              </button>
            </div>
          </>
        ) : null}

        {step === 'viewing' ? (
          <>
            <h2 className="creative-approval-modal-title">{projection?.title || 'Shared chat'}</h2>
            <div className={connectionClassName}>Connection: {connectionLabel}</div>
            <p className="creative-approval-modal-description">
              You are following this chat live{mode === 'comments' ? ' and can leave comments' : ' (read-only)'}.
              The host stays in control of the AI.
            </p>
            <div className="join-projection-rows" ref={rowsRef}>
              {!projection || projection.rows.length === 0 ? (
                <div className="join-projection-empty">Waiting for the host’s transcript…</div>
              ) : (
                projection.rows.map((row) => (
                  <div key={row.id} className="join-projection-row">
                    <div className="join-projection-speaker">
                      {row.speaker}
                      {row.role === 'collaborator' && (
                        <span className="message-meta-model-badge human-collaborator-badge">External</span>
                      )}
                    </div>
                    <div className={bubbleClass(row.role)}>
                      <MarkdownMessage content={row.preview} />
                      {row.truncated && <span className="join-projection-truncated"> …(truncated)</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
            {error && <div className="join-error" role="alert">{error}</div>}
            {mode === 'comments' ? (
              <div className="join-comment-row">
                <textarea
                  className="join-comment-input"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      void handleSendComment()
                    }
                  }}
                  placeholder="Add a comment for the host…"
                  rows={2}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleSendComment}
                  disabled={!comment.trim()}
                >
                  Send
                </button>
              </div>
            ) : null}
            <div className="join-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={requestLeave}>
                Leave
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  )
}

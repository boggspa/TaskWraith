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
  const [busy, setBusy] = useState(false)
  const rowsRef = useRef<HTMLDivElement | null>(null)

  // Live projection + status while the modal is open.
  useEffect(() => {
    if (!open) return
    const off = window.api.onHumanCollaborationCollaboratorProjection?.((payload) =>
      setProjection(payload.projection as Projection)
    )
    const offStatus = window.api.onHumanCollaborationCollaboratorStatus?.((payload) => {
      if (payload.error) setError(payload.error)
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

  const handleJoin = useCallback(async () => {
    setError(null)
    let invite: Record<string, unknown>
    try {
      invite = JSON.parse(inviteText) as Record<string, unknown>
    } catch {
      setError('That does not look like a valid invite. Paste the JSON the host copied.')
      return
    }
    if (invite?.type !== 'taskwraith-human-collaboration-invite' || !invite.relayUrl) {
      setError(
        invite?.type === 'taskwraith-human-collaboration-invite'
          ? 'This invite has no connection info — the host needs remote access ON, then a fresh invite.'
          : 'That JSON is not a TaskWraith collaboration invite.'
      )
      return
    }
    setBusy(true)
    setStep('connecting')
    try {
      const res = await window.api.humanCollaborationCollaboratorJoin({
        shareId: String(invite.shareId),
        chatId: String(invite.chatId),
        inviteToken: String(invite.inviteToken),
        displayName: displayName.trim() || 'Guest',
        mode: invite.mode === 'readOnly' ? 'readOnly' : 'comments',
        relayUrl: String(invite.relayUrl),
        roomId: String(invite.roomId),
        hostIdentityPubKeyB64:
          typeof invite.hostIdentityPubKeyB64 === 'string' ? invite.hostIdentityPubKeyB64 : undefined
      })
      setSasCode(res.confirmCode)
      setMode(res.mode)
      setStep('sas')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect to the shared chat.')
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the session.')
    } finally {
      setBusy(false)
    }
  }, [])

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

  return createPortal(
    <div className="creative-approval-backdrop" onClick={leaveAndClose}>
      <div
        className="creative-approval-modal join-shared-chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Join a shared chat"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="creative-approval-modal-eyebrow">Collaborate · People</div>

        {step === 'paste' || step === 'connecting' ? (
          <>
            <h2 className="creative-approval-modal-title">Join a shared chat</h2>
            <p className="creative-approval-modal-description">
              Paste the invite the host shared with you, then verify the 6-digit code together.
            </p>
            <label className="join-field-label">Your name (shown to the host)</label>
            <input
              className="join-text-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Olly"
              maxLength={80}
            />
            <label className="join-field-label">Invite</label>
            <textarea
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
            <p className="creative-approval-modal-description">
              The host sees a 6-digit code too. Confirm out of band (call/message) that these match
              before joining — this is what stops an imposter in the middle.
            </p>
            <div className="join-sas-code" aria-label="Security code">{sasCode}</div>
            {error && <div className="join-error" role="alert">{error}</div>}
            <div className="join-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={leaveAndClose} disabled={busy}>
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
              <button type="button" className="btn btn-sm btn-ghost" onClick={leaveAndClose}>
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

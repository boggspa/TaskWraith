import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  HumanCollaborationShare,
  HumanCollaboratorParticipant
} from '../../../main/collaboration/HumanCollaborationStore'

/**
 * SharesPanel — Settings → Shares.
 *
 * The lifecycle home for human-collaboration shares (a host sharing one of
 * their chats with remote human collaborators). The container is self-contained:
 * it pulls the enabled-share list via `humanCollaborationListShares`, resolves
 * chat titles via `getChatList`, and refetches whenever main broadcasts a
 * collaboration update (create / join / comment / revoke). Each share shows its
 * access mode, the participants and their status, any open invites, and a
 * per-share revoke.
 *
 * Per-participant revoke is intentionally deferred — the store only exposes a
 * whole-share revoke today; this panel is the place that gains it later.
 *
 * The pure `SharesPanelView` is split out so the rendering is unit-testable
 * without the IPC bridge (the suite has no jsdom, so effects don't run).
 */

function shareModeLabel(mode: HumanCollaborationShare['mode']): string {
  return mode === 'readOnly' ? 'Read-only' : 'Comments'
}

function participantStatusLabel(status: HumanCollaboratorParticipant['status']): string {
  if (status === 'active') return 'Active'
  if (status === 'pending') return 'Pending'
  return 'Removed'
}

export function SharesPanelView({
  shares,
  chatTitles,
  loading,
  error,
  connectedChatIds,
  onRevoke,
  onRevokeParticipant,
  now
}: {
  shares: HumanCollaborationShare[]
  chatTitles: Record<string, string>
  loading: boolean
  error: string | null
  connectedChatIds?: Set<string>
  onRevoke: (shareId: string) => void
  onRevokeParticipant?: (shareId: string, collaboratorId: string) => void
  // The "current time" for open-invite expiry, supplied by the container so the
  // view stays a pure function of its props (no clock read during render).
  now: number
}) {
  const rows = useMemo(
    () =>
      shares.map((share) => {
        const participants = share.participants.filter(
          (participant) => participant.status !== 'revoked'
        )
        const isConnected = connectedChatIds?.has(share.chatId) ?? false
        const openInvites = share.invites.filter(
          (invite) => typeof invite.consumedAt !== 'number' && invite.expiresAt > now
        ).length
        return {
          share,
          title: chatTitles[share.chatId] || 'Shared chat',
          participants,
          openInvites,
          isConnected
        }
      }),
    [shares, chatTitles, now, connectedChatIds]
  )

  return (
    <div className="shares-panel">
      <div className="shares-panel-header">
        <label className="settings-label">Shares</label>
        <div className="settings-hint">
          Chats you&apos;ve shared with human collaborators. Each collaborator joins over an
          out-of-band invite and a one-time security code; you can stop a share at any time.
        </div>
      </div>

      <div className="settings-hint shares-panel-note">
        Collaborators connect over your remote-access relay — if invites aren&apos;t connecting,
        make sure remote access is enabled under Devices.
      </div>

      {error && <div className="settings-error">{error}</div>}

      {loading ? (
        <div className="settings-hint shares-panel-empty">Loading shares…</div>
      ) : rows.length === 0 ? (
        <div className="settings-hint shares-panel-empty">
          No active shares. Start one from a chat&apos;s share action or the “+ New” menu.
        </div>
      ) : (
        <ul className="shares-panel-list">
          {rows.map(({ share, title, participants, openInvites, isConnected }) => (
            <li className="shares-panel-card" key={share.shareId}>
              <div className="shares-panel-card-head">
                <div className="shares-panel-card-title-wrap">
                  <span className="shares-panel-card-title">{title}</span>
                  <span className="shares-panel-card-mode">
                    {shareModeLabel(share.mode)} · {isConnected ? 'Live' : 'Not connected'}
                  </span>
                </div>
                <button
                  type="button"
                  className="shares-panel-revoke"
                  onClick={() => onRevoke(share.shareId)}
                  aria-label={`Stop sharing ${title}`}
                >
                  Stop sharing
                </button>
              </div>

              <div className="shares-panel-card-body">
                {participants.length === 0 ? (
                  <span className="shares-panel-muted">
                    {openInvites > 0 ? 'Invite sent — awaiting collaborator' : 'No collaborators yet'}
                  </span>
                ) : (
                  <ul className="shares-panel-participants">
                    {participants.map((participant) => (
                      <li className="shares-panel-participant" key={participant.collaboratorId}>
                        <span
                          className={`shares-panel-dot is-${participant.status}`}
                          aria-hidden
                        />
                        <span className="shares-panel-participant-name">
                          {participant.displayName}
                        </span>
                        <span className="shares-panel-participant-status">
                          {participantStatusLabel(participant.status)}
                        </span>
                        {onRevokeParticipant && (
                          <button
                            type="button"
                            className="shares-panel-participant-remove"
                            onClick={() => onRevokeParticipant(share.shareId, participant.collaboratorId)}
                            aria-label={`Remove ${participant.displayName} from this share`}
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {openInvites > 0 && participants.length > 0 && (
                  <span className="shares-panel-muted shares-panel-open-invites">
                    {openInvites} open invite{openInvites === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function SharesPanel() {
  const [shares, setShares] = useState<HumanCollaborationShare[]>([])
  const [chatTitles, setChatTitles] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Sampled at each data refresh (never during render) so the view's
  // open-invite expiry check is pure and stable across a render pass.
  const [now, setNow] = useState(() => Date.now())
  const [connectedChatIds, setConnectedChatIds] = useState<Set<string>>(new Set())

  const refresh = useCallback(() => {
    setNow(Date.now())
    if (typeof window.api.humanCollaborationListShares !== 'function') {
      setShares([])
      setLoading(false)
      return
    }
    void window.api
      .humanCollaborationListShares()
      .then((next) => {
        setShares((next || []).filter((share) => share?.enabled !== false))
        setError(null)
      })
      .catch(() => setError('Could not load shares.'))
      .finally(() => setLoading(false))
  }, [])

  const refreshConnected = useCallback(() => {
    if (typeof window.api.humanCollaborationConnectedChatIds !== 'function') return
    void window.api
      .humanCollaborationConnectedChatIds()
      .then((ids) => {
        setConnectedChatIds(new Set(Array.isArray(ids) ? ids : []))
      })
      .catch(() => {
        // Optional/ephemeral endpoint; leave the current connected set unchanged on
        // best-effort failure to avoid noisy jitter.
      })
  }, [])

  // Resolve chat titles for the shared chatIds. Best-effort — a share whose
  // chat can't be resolved falls back to a generic label.
  const refreshTitles = useCallback(() => {
    if (typeof window.api.getChatList !== 'function') return
    void window.api
      .getChatList()
      .then((list) => {
        const map: Record<string, string> = {}
        for (const chat of list || []) {
          if (chat?.appChatId) map[chat.appChatId] = chat.title || 'Untitled chat'
        }
        setChatTitles(map)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    refreshTitles()
    refreshConnected()
    if (typeof window.api.onHumanCollaborationUpdated !== 'function') return
    const unsubscribe = window.api.onHumanCollaborationUpdated(() => {
      refresh()
      refreshTitles()
      refreshConnected()
    })

    const connectedInterval = window.setInterval(() => {
      refreshConnected()
    }, 5000)

    return () => {
      unsubscribe?.()
      window.clearInterval(connectedInterval)
    }
  }, [refresh, refreshTitles, refreshConnected])

  const handleRevoke = useCallback(
    (shareId: string) => {
      if (typeof window.api.humanCollaborationRevokeShare !== 'function') return
      if (!window.confirm('Stop sharing this chat? Collaborators will lose access immediately.'))
        return
      void window.api
        .humanCollaborationRevokeShare(shareId)
        .then(() => refresh())
        .catch(() => {
          setError('Could not stop sharing.')
          refresh()
        })
    },
    [refresh]
  )

  const handleRevokeParticipant = useCallback(
    (shareId: string, collaboratorId: string) => {
      if (typeof window.api.humanCollaborationRevokeParticipant !== 'function') return
      if (!window.confirm('Remove this collaborator? They lose access immediately.')) return
      void window.api
        .humanCollaborationRevokeParticipant({ shareId, collaboratorId })
        .then(() => refresh())
        .catch(() => {
          setError('Could not remove the collaborator.')
          refresh()
        })
    },
    [refresh]
  )

  return (
    <SharesPanelView
      shares={shares}
      chatTitles={chatTitles}
      loading={loading}
      error={error}
      onRevoke={handleRevoke}
      onRevokeParticipant={handleRevokeParticipant}
      connectedChatIds={connectedChatIds}
      now={now}
    />
  )
}

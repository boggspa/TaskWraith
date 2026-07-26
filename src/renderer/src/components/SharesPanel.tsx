import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  HumanCollaborationShare,
  HumanCollaboratorParticipant
} from '../../../main/collaboration/HumanCollaborationStore'
import type { HumanCollaborationAuditEvent } from '../../../main/collaboration/HumanCollaborationAuditLog'
import { buildHumanCollaborationInvitePayload } from '../lib/humanCollaborationInvitePayload'

/**
 * SharesPanel — Settings → Shares.
 *
 * The lifecycle home for human-collaboration shares (a host sharing one of
 * their chats with remote human collaborators). The container is self-contained:
 * it pulls the enabled-share list via `humanCollaborationListShares`, resolves
 * chat titles via `getChatList`, and refetches whenever main broadcasts a
 * collaboration update (create / join / comment / revoke). Each share shows its
 * contribution rules, the participants and their status, any open invites,
 * per-participant remove, and a per-share revoke.
 *
 * The pure `SharesPanelView` is split out so the rendering is unit-testable
 * without the IPC bridge (the suite has no jsdom, so effects don't run).
 */

// P2a rule-preset labels. A share without persisted rules falls back to its
// Phase 1 mode label (identical strings, so nothing shifts for legacy shares).
function shareRuleLabel(share: HumanCollaborationShare): string {
  switch (share.contributionRules?.preset) {
    case 'readOnly':
      return 'Read-only'
    case 'requestHostAction':
      return 'Host actions'
    case 'autoDraft':
      return 'Auto-draft'
    case 'comments':
      return 'Comments'
    default:
      return share.mode === 'readOnly' ? 'Read-only' : 'Comments'
  }
}

const SHARE_RULE_PRESET_OPTIONS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'readOnly', label: 'View only', hint: 'Collaborators can watch, nothing else.' },
  {
    value: 'comments',
    label: 'Comments — host-reviewed before AI',
    hint: 'Collaborators can leave comments; you decide what reaches the AI.'
  },
  {
    value: 'requestHostAction',
    label: 'Request host action — host-reviewed',
    hint: 'Comments plus structured action requests, all reviewed by you.'
  },
  {
    value: 'autoDraft',
    label: 'Auto-draft — you still send',
    hint: 'Action requests pre-fill your composer as a draft; nothing sends itself.'
  }
]

function participantStatusLabel(status: HumanCollaboratorParticipant['status']): string {
  if (status === 'active') return 'Active'
  if (status === 'pending') return 'Pending'
  return 'Removed'
}

/**
 * Activity log (P2 audit surface).
 *
 * `HumanCollaborationAuditLog` has always recorded the full admission and
 * contribution timeline — including the reason a contribution was DROPPED —
 * but nothing rendered it, so a silently-rejected comment looked identical to
 * one that was never sent. These labels turn the machine vocabulary into what a
 * host actually needs to see while a share is live.
 */
const AUDIT_KIND_LABELS: Record<string, string> = {
  'share.created': 'Share created',
  'share.rules_changed': 'Contribution rules changed',
  'share.revoked': 'Sharing stopped',
  'participant.revoked': 'Collaborator removed',
  'invite.created': 'Invite created',
  'invite.consumed': 'Invite used',
  'admission.began': 'Join started — security code shown',
  'admission.sas_confirmed': 'Security code confirmed',
  'admission.sas_failed': 'Security code REJECTED',
  'session.disconnected': 'Collaborator disconnected',
  'contribution.received': 'Comment received',
  'contribution.deduped': 'Duplicate ignored',
  'contribution.rejected': 'Contribution rejected',
  'draft.inserted': 'Inserted into your composer'
}

/** Denial codes read as jargon in a log line; say what actually happened. */
const AUDIT_CODE_LABELS: Record<string, string> = {
  read_only: 'share is view-only',
  rule_denied: 'blocked by the contribution rules',
  quota_exceeded: 'rate limit — too many, too fast',
  revoked: 'access had been revoked',
  stale_session: 'session was stale — needs a reconnect',
  protocol_unsupported: 'unsupported protocol version',
  duplicate_contribution: 'duplicate of one already recorded'
}

/** Kinds that mean something went wrong — tinted so they stand out in a scan. */
const AUDIT_PROBLEM_KINDS = new Set([
  'admission.sas_failed',
  'contribution.rejected',
  'share.revoked',
  'participant.revoked'
])

function auditKindLabel(kind: string): string {
  return AUDIT_KIND_LABELS[kind] || kind
}

function auditCodeLabel(code: string | undefined): string | null {
  if (!code) return null
  return AUDIT_CODE_LABELS[code] || code
}

/** Relative time from the view's supplied `now` — no clock read during render. */
function auditRelativeTime(at: number, now: number): string {
  const deltaMs = Math.max(0, now - at)
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function SharesPanelView({
  shares,
  chatTitles,
  loading,
  error,
  connectedChatIds,
  onRevoke,
  onCopyInvite,
  onRevokeParticipant,
  onChangeRules,
  liveSessionKeys,
  auditEvents,
  auditError,
  now
}: {
  shares: HumanCollaborationShare[]
  chatTitles: Record<string, string>
  loading: boolean
  error: string | null
  connectedChatIds?: Set<string>
  onRevoke: (shareId: string) => void
  onCopyInvite?: (share: HumanCollaborationShare) => void
  onRevokeParticipant?: (shareId: string, collaboratorId: string) => void
  /** P2a: host-only contribution-rules preset change. */
  onChangeRules?: (shareId: string, preset: string) => void
  /** P2a presence clarity: `${shareId}:${collaboratorId}` keys with a LIVE session. */
  liveSessionKeys?: Set<string>
  /** Newest-first audit timeline. Omitted entirely when the bridge lacks it. */
  auditEvents?: HumanCollaborationAuditEvent[]
  auditError?: string | null
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
        // Spec §6: invite issued / participant active / live session connected /
        // offline are DISTINCT states — don't collapse them into one string.
        const connectionLabel = isConnected
          ? 'Live'
          : participants.length > 0
            ? 'Offline'
            : openInvites > 0
              ? 'Invite issued'
              : 'Not connected'
        return {
          share,
          title: chatTitles[share.chatId] || 'People chat',
          participants,
          openInvites,
          isConnected,
          connectionLabel
        }
      }),
    [shares, chatTitles, now, connectedChatIds]
  )

  return (
    <div className="shares-panel">
      <div className="shares-panel-header">
        <label className="settings-label">People</label>
        <div className="settings-hint">
          Chats you&apos;ve shared with human collaborators. Each collaborator joins over an
          out-of-band invite and a one-time security code; you can stop a share at any time.
          Collaborator contributions are host-reviewed — nothing reaches the AI unless you
          insert it as a draft and send it yourself.
        </div>
      </div>

      <div className="settings-hint shares-panel-note">
        Collaborators connect over your remote-access relay — if invites aren&apos;t connecting,
        make sure remote access is enabled under Devices.
      </div>

      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="settings-hint shares-panel-empty" role="status">
          Loading shares…
        </div>
      ) : rows.length === 0 ? (
        <div className="settings-hint shares-panel-empty">
          No active shares. Start one from a chat&apos;s share action or the “+ New” menu.
        </div>
      ) : (
        <ul className="shares-panel-list">
          {rows.map(({ share, title, participants, openInvites, connectionLabel }) => (
            <li className="shares-panel-card" key={share.shareId}>
              <div className="shares-panel-card-head">
                <div className="shares-panel-card-title-wrap">
                  <span className="shares-panel-card-title">{title}</span>
                  <span className="shares-panel-card-mode">
                    {shareRuleLabel(share)} · {connectionLabel}
                  </span>
                  {onChangeRules && (
                    <select
                      className="shares-panel-rules-select"
                      aria-label={`Contribution rules for ${title}`}
                      value={share.contributionRules?.preset ?? (share.mode === 'readOnly' ? 'readOnly' : 'comments')}
                      onChange={(event) => onChangeRules(share.shareId, event.target.value)}
                      title={
                        SHARE_RULE_PRESET_OPTIONS.find(
                          (option) =>
                            option.value ===
                            (share.contributionRules?.preset ??
                              (share.mode === 'readOnly' ? 'readOnly' : 'comments'))
                        )?.hint
                      }
                    >
                      {SHARE_RULE_PRESET_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {onCopyInvite && (
                  <button
                    type="button"
                    className="shares-panel-copy-invite"
                    onClick={() => onCopyInvite(share)}
                    aria-label={`Copy a fresh invite for ${title}`}
                  >
                    Copy invite
                  </button>
                )}
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
                        {liveSessionKeys && participant.status === 'active' && (
                          <span
                            className={`shares-panel-participant-live ${
                              liveSessionKeys.has(`${share.shareId}:${participant.collaboratorId}`)
                                ? 'is-live'
                                : 'is-offline'
                            }`}
                          >
                            {liveSessionKeys.has(`${share.shareId}:${participant.collaboratorId}`)
                              ? 'Live'
                              : 'Offline'}
                          </span>
                        )}
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

      {(auditEvents !== undefined || auditError) && (
        <details className="shares-panel-audit">
          <summary className="shares-panel-audit-summary">
            Activity log
            {auditEvents && auditEvents.length > 0 ? ` (${auditEvents.length})` : ''}
          </summary>
          <div className="settings-hint shares-panel-audit-hint">
            Every admission and contribution, newest first — including the ones that were
            dropped and why. Nothing here is sent anywhere; it stays on this Mac.
          </div>
          {auditError ? (
            <div className="settings-error" role="alert">
              {auditError}
            </div>
          ) : !auditEvents || auditEvents.length === 0 ? (
            <div className="settings-hint shares-panel-audit-empty">No collaboration activity yet.</div>
          ) : (
            <ul className="shares-panel-audit-list">
              {auditEvents.map((entry) => {
                const codeLabel = auditCodeLabel(entry.code)
                return (
                  <li
                    className={`shares-panel-audit-row${
                      AUDIT_PROBLEM_KINDS.has(entry.kind) ? ' is-problem' : ''
                    }`}
                    key={entry.id}
                  >
                    <span className="shares-panel-audit-time">
                      {auditRelativeTime(entry.at, now)}
                    </span>
                    <span className="shares-panel-audit-kind">{auditKindLabel(entry.kind)}</span>
                    {codeLabel && (
                      <span className="shares-panel-audit-code">{codeLabel}</span>
                    )}
                    {entry.detail && (
                      <span className="shares-panel-audit-detail">{entry.detail}</span>
                    )}
                    {entry.preview && (
                      <span className="shares-panel-audit-preview">“{entry.preview}”</span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </details>
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
  const [liveSessionKeys, setLiveSessionKeys] = useState<Set<string>>(new Set())
  // `undefined` = the bridge doesn't expose the audit log, so the section is
  // hidden entirely rather than rendering a permanently-empty box.
  const [auditEvents, setAuditEvents] = useState<HumanCollaborationAuditEvent[] | undefined>(
    undefined
  )
  const [auditError, setAuditError] = useState<string | null>(null)

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
    if (typeof window.api.humanCollaborationConnectedChatIds === 'function') {
      void window.api
        .humanCollaborationConnectedChatIds()
        .then((ids) => {
          setConnectedChatIds(new Set(Array.isArray(ids) ? ids : []))
        })
        .catch(() => {
          // Optional/ephemeral endpoint; leave the current connected set unchanged on
          // best-effort failure to avoid noisy jitter.
        })
    }
    // P2a presence clarity — per-collaborator live-session keys.
    if (typeof window.api.humanCollaborationSessionStatus === 'function') {
      void window.api
        .humanCollaborationSessionStatus()
        .then((sessions) => {
          setLiveSessionKeys(
            new Set(
              (Array.isArray(sessions) ? sessions : []).map(
                (session) => `${session.shareId}:${session.collaboratorId}`
              )
            )
          )
        })
        .catch(() => {})
    }
  }, [])

  // A rejected contribution does NOT broadcast a collaboration update (nothing
  // was recorded), so the log has to be polled to stay live during a session —
  // an update-only refresh would never show the very rows you need most.
  const refreshAudit = useCallback(() => {
    if (typeof window.api.humanCollaborationAuditLog !== 'function') {
      setAuditEvents(undefined)
      return
    }
    void window.api
      .humanCollaborationAuditLog({ limit: 80 })
      .then((events) => {
        setAuditEvents(Array.isArray(events) ? (events as HumanCollaborationAuditEvent[]) : [])
        setAuditError(null)
      })
      .catch(() => setAuditError('Could not load the activity log.'))
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
    refreshAudit()
    if (typeof window.api.onHumanCollaborationUpdated !== 'function') return
    const unsubscribe = window.api.onHumanCollaborationUpdated(() => {
      refresh()
      refreshTitles()
      refreshConnected()
      refreshAudit()
    })

    const connectedInterval = window.setInterval(() => {
      refreshConnected()
      refreshAudit()
    }, 5000)

    return () => {
      unsubscribe?.()
      window.clearInterval(connectedInterval)
    }
  }, [refresh, refreshTitles, refreshConnected, refreshAudit])

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

  const handleChangeRules = useCallback(
    (shareId: string, preset: string) => {
      if (typeof window.api.humanCollaborationUpdateShareRules !== 'function') return
      void window.api
        .humanCollaborationUpdateShareRules({ shareId, preset })
        .then(() => refresh())
        .catch(() => {
          setError('Could not update the share rules.')
          refresh()
        })
    },
    [refresh]
  )

  const handleCopyInvite = useCallback(
    (share: HumanCollaborationShare) => {
      if (typeof window.api.humanCollaborationCreateShare !== 'function') return
      void window.api
        .humanCollaborationCreateShare({ chatId: share.chatId, mode: share.mode })
        .then(async (result) => {
          const { payload, relayUrls, relayWarning } =
            buildHumanCollaborationInvitePayload(result)
          let copied = false
          let copyError: unknown = null
          if (typeof window.api.humanCollaborationCopyInvite === 'function') {
            try {
              await window.api.humanCollaborationCopyInvite({ invite: payload })
              copied = true
            } catch (error) {
              copyError = error
            }
          }
          if (!copied) {
            if (!navigator.clipboard?.writeText) {
              throw copyError instanceof Error
                ? copyError
                : new Error('Clipboard is not available.')
            }
            await navigator.clipboard.writeText(payload)
          }
          const warningSuffix = relayWarning ? `\n\n${relayWarning}` : ''
          window.alert(
            (relayUrls.length > 0
              ? 'Fresh People invite copied. Share it out of band with the collaborator.'
              : 'Fresh People invite copied. Remote access is OFF, so collaborators cannot connect yet. Enable remote access in Devices, then create a new invite.') +
              warningSuffix
          )
          refresh()
        })
        .catch((error) => {
          console.error('[human-collaboration] copy invite failed', error)
          setError('Could not copy invite.')
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
      onCopyInvite={handleCopyInvite}
      onRevokeParticipant={handleRevokeParticipant}
      onChangeRules={handleChangeRules}
      connectedChatIds={connectedChatIds}
      liveSessionKeys={liveSessionKeys}
      auditEvents={auditEvents}
      auditError={auditError}
      now={now}
    />
  )
}

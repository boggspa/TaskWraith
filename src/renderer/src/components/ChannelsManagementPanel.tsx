import { useCallback, useEffect, useState } from 'react'
import type {
  ChannelIpcApi,
  ChannelIpcAuditEvent,
  ChannelIpcChannel,
  ChannelIpcMember
} from '../../../shared/collaboration/ChannelIpc'

function channelsApi(): ChannelIpcApi | null {
  return window.api?.channels || null
}

function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  return new Date(at).toLocaleString()
}

/**
 * Settings → Channels: every channel this host owns, with membership and the
 * audit trail. Per-chat sharing controls (fresh invites, admissions, review)
 * live in the chat's own Channel panel; this tab is the global overview and
 * the revoke/close authority of last resort.
 */
export function ChannelsManagementPanel(): React.JSX.Element {
  const [channels, setChannels] = useState<ChannelIpcChannel[] | null>(null)
  const [membersByChannelId, setMembersByChannelId] = useState<Record<string, ChannelIpcMember[]>>(
    {}
  )
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null)
  const [auditEvents, setAuditEvents] = useState<ChannelIpcAuditEvent[]>([])
  const [auditOpen, setAuditOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    const api = channelsApi()
    if (!api) return
    void api
      .list()
      .then((result) => {
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setError(null)
        setChannels([...result.value].sort((left, right) => right.updatedAt - left.updatedAt))
      })
      .catch(() => setError('Channels are unavailable in this window.'))
  }, [])

  const loadMembers = useCallback((channelId: string) => {
    const api = channelsApi()
    if (!api) return
    void api
      .read({ channelId, resumeAfter: 0, maxRecords: 1 })
      .then((result) => {
        if (!result.ok) return
        setMembersByChannelId((current) => ({
          ...current,
          [channelId]: result.value.members
        }))
      })
      .catch(() => {})
  }, [])

  const loadAudit = useCallback(() => {
    const api = channelsApi()
    if (!api) return
    void api
      .audit({ limit: 50 })
      .then((result) => {
        if (result.ok) setAuditEvents(result.value)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const api = channelsApi()
    if (!api?.onChanged) return
    return api.onChanged((event) => {
      refresh()
      if (event.channelId === expandedChannelId) loadMembers(event.channelId)
      if (auditOpen) loadAudit()
    })
  }, [auditOpen, expandedChannelId, loadAudit, loadMembers, refresh])

  const toggleExpanded = (channelId: string): void => {
    setExpandedChannelId((current) => {
      const next = current === channelId ? null : channelId
      if (next) loadMembers(next)
      return next
    })
  }

  const revokeMember = (channelId: string, member: ChannelIpcMember): void => {
    const api = channelsApi()
    if (!api) return
    if (
      !window.confirm(
        `Revoke ${member.displayName || 'this member'}? They lose access immediately.`
      )
    ) {
      return
    }
    setBusy(`revoke:${member.memberId}`)
    void api
      .revokeMember({ channelId, memberId: member.memberId })
      .then((result) => {
        if (!result.ok) setError(result.error.message)
        loadMembers(channelId)
        refresh()
      })
      .catch(() => setError('Could not revoke that member.'))
      .finally(() => setBusy(null))
  }

  const closeChannel = (channel: ChannelIpcChannel): void => {
    const api = channelsApi()
    if (!api) return
    if (
      !window.confirm(
        `Close “${channel.display.title}”? Members lose access and the chat stops being shared.`
      )
    ) {
      return
    }
    setBusy(`close:${channel.channelId}`)
    void api
      .close({ channelId: channel.channelId })
      .then((result) => {
        if (!result.ok) setError(result.error.message)
        refresh()
      })
      .catch(() => setError('Could not close that channel.'))
      .finally(() => setBusy(null))
  }

  if (!channelsApi()) {
    return (
      <div className="shares-panel">
        <p className="settings-hint shares-panel-note">Channels are unavailable in this window.</p>
      </div>
    )
  }

  const active = (channels || []).filter((channel) => channel.status === 'active')
  const closed = (channels || []).filter((channel) => channel.status !== 'active')

  return (
    <div className="shares-panel">
      <p className="settings-hint shares-panel-note">
        Channels are chats you share. Invites, admissions, and message review live on each
        chat&apos;s Channel panel; this page is the overview. A channel is reachable only while this
        Mac is online.
      </p>
      {error && <p className="settings-error">{error}</p>}
      {channels !== null && active.length === 0 && (
        <p className="settings-hint shares-panel-empty">
          No active channels. Open a chat and use its Channel panel to invite someone.
        </p>
      )}
      {active.map((channel) => {
        const members = membersByChannelId[channel.channelId]
        const expanded = expandedChannelId === channel.channelId
        return (
          <div key={channel.channelId} className="shares-panel-card">
            <div className="shares-panel-card-head">
              <div className="shares-panel-card-title-wrap">
                <button
                  type="button"
                  className="shares-panel-card-title"
                  onClick={() => toggleExpanded(channel.channelId)}
                  aria-expanded={expanded}
                >
                  {channel.display.title}
                </button>
                <span className="settings-hint shares-panel-card-counts">
                  {channel.display.memberCount} member
                  {channel.display.memberCount === 1 ? '' : 's'} · {channel.display.messageCount}{' '}
                  message
                  {channel.display.messageCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="shares-panel-card-actions">
                <button
                  type="button"
                  className="shares-panel-revoke"
                  disabled={busy === `close:${channel.channelId}`}
                  onClick={() => closeChannel(channel)}
                >
                  Close channel
                </button>
              </div>
            </div>
            {expanded && (
              <div className="shares-panel-card-body">
                {!members && <p className="settings-hint">Loading members…</p>}
                {members?.length === 0 && <p className="settings-hint">No members yet.</p>}
                {members?.map((member) => (
                  <div key={member.memberId} className="shares-panel-participant">
                    <span className="shares-panel-participant-name">
                      {member.displayName || member.memberId}
                    </span>
                    <span className="settings-hint">
                      {member.kind === 'agent' ? 'Agent' : 'Human'} · {member.status} · joined{' '}
                      {formatTime(member.joinedAt)}
                    </span>
                    {member.status !== 'revoked' && (
                      <button
                        type="button"
                        className="shares-panel-revoke"
                        disabled={busy === `revoke:${member.memberId}`}
                        onClick={() => revokeMember(channel.channelId, member)}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {closed.length > 0 && (
        <p className="settings-hint shares-panel-note">
          {closed.length} closed channel{closed.length === 1 ? '' : 's'} retained in history.
        </p>
      )}
      <div className="shares-panel-audit">
        <button
          type="button"
          className="shares-panel-audit-summary"
          onClick={() => {
            setAuditOpen((open) => {
              const next = !open
              if (next) loadAudit()
              return next
            })
          }}
          aria-expanded={auditOpen}
        >
          Audit log
        </button>
        {auditOpen && auditEvents.length === 0 && (
          <p className="settings-hint shares-panel-audit-empty">No audit events yet.</p>
        )}
        {auditOpen && auditEvents.length > 0 && (
          <div className="shares-panel-audit-list">
            {auditEvents.map((event) => (
              <div key={event.id} className="shares-panel-audit-preview">
                <span className="shares-panel-audit-time">{formatTime(event.at)}</span>
                <span className="shares-panel-audit-kind">{event.kind}</span>
                {event.detail && <span className="shares-panel-audit-detail">{event.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

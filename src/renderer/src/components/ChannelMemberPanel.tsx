import { useEffect, useId, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { ChannelMemberIpcApi } from '../../../shared/collaboration/ChannelMemberIpc'
import {
  ChannelMemberPanelController,
  createChannelMemberPanelInitialState,
  type ChannelMemberPanelControllerOptions,
  type ChannelMemberPanelState
} from '../lib/channelMemberPanelModel'

export interface ChannelMemberPanelProps {
  api?: ChannelMemberIpcApi
  defaultDisplayName?: string
  createClientMessageId?: ChannelMemberPanelControllerOptions['createClientMessageId']
}

export type ChannelMemberConfirmation =
  | { kind: 'reset'; channelId: string; title: string }
  | { kind: 'forget'; channelId: string; title: string }
  | null

export interface ChannelMemberPanelViewProps {
  panelId: string
  open: boolean
  inviteText: string
  displayName: string
  draft: string
  confirmation: ChannelMemberConfirmation
  state: ChannelMemberPanelState
  onToggleOpen: () => void
  onClosePanel: () => void
  onInviteTextChange: (value: string) => void
  onDisplayNameChange: (value: string) => void
  onDraftChange: (value: string) => void
  onBeginJoin: () => void
  onConfirmJoin: () => void
  onReconnect: (channelId?: string) => void
  onResume: () => void
  onDisconnect: () => void
  onAppend: () => void
  onRefresh: () => void
  onRequestReset: (channelId: string, title: string) => void
  onRequestForget: (channelId: string, title: string) => void
  onCancelConfirmation: () => void
  onConfirmDestructiveAction: () => void
}

function resolveRendererApi(): ChannelMemberIpcApi | null {
  if (typeof window === 'undefined') return null
  return window.api?.channelMemberships || null
}

function isoTime(timestamp: number): string {
  try {
    return new Date(timestamp).toISOString()
  } catch {
    return ''
  }
}

function phaseLabel(state: ChannelMemberPanelState): string {
  switch (state.phase) {
    case 'connecting':
      return 'Connecting'
    case 'awaiting_sas':
      return 'Verify code'
    case 'connected':
      return state.connected ? 'Connected' : 'Disconnected'
    case 'disconnected':
      return 'Offline'
    case 'revoked':
      return 'Revoked'
    case 'recovery_blocked':
      return 'Repair needed'
    default:
      return 'Not connected'
  }
}

function actionLabel(
  state: ChannelMemberPanelState,
  action: ChannelMemberPanelState['busy'],
  idle: string
): string {
  return state.busy === action ? 'Working…' : idle
}

export function ChannelMemberPanelView({
  panelId,
  open,
  inviteText,
  displayName,
  draft,
  confirmation,
  state,
  onToggleOpen,
  onClosePanel,
  onInviteTextChange,
  onDisplayNameChange,
  onDraftChange,
  onBeginJoin,
  onConfirmJoin,
  onReconnect,
  onResume,
  onDisconnect,
  onAppend,
  onRefresh,
  onRequestReset,
  onRequestForget,
  onCancelConfirmation,
  onConfirmDestructiveAction
}: ChannelMemberPanelViewProps) {
  const busy = state.busy !== null
  const channel = state.channel
  const postable = Boolean(
    channel && channel.status === 'active' && state.phase === 'connected' && state.connected
  )
  const memberById = new Map(state.members.map((member) => [member.memberId, member]))

  const submitDraft = (): void => {
    if (postable && !busy && draft.trim()) onAppend()
  }

  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submitDraft()
  }

  return (
    <div className="channel-member-control">
      <button
        type="button"
        className="human-collaboration-people-btn channel-member-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggleOpen}
        title="Open Channels you joined on this Mac"
      >
        Joined
        {state.connected && (
          <span className="channel-member-live-dot" aria-label="Joined Channel connected" />
        )}
        {state.memberships.length > 0 && (
          <span
            className="channel-member-trigger-count"
            aria-label={`${state.memberships.length} saved Channel memberships`}
          >
            {state.memberships.length}
          </span>
        )}
      </button>

      {open && (
        <section
          id={panelId}
          className="channel-member-panel"
          role="dialog"
          aria-label="Joined Channels"
        >
          <header className="channel-member-panel-header">
            <div>
              <span className="channel-member-eyebrow">Human memberships</span>
              <h2>Joined Channels</h2>
            </div>
            <div className="channel-member-inline-actions">
              <button type="button" onClick={onRefresh} disabled={busy}>
                {actionLabel(state, 'refresh', 'Refresh')}
              </button>
              <button
                type="button"
                className="channel-member-icon-button"
                onClick={onClosePanel}
                aria-label="Close Joined Channels panel"
              >
                ×
              </button>
            </div>
          </header>

          <p className="channel-member-safety-note">
            Human messages only. Joining, reading, or posting never starts an agent run.
          </p>

          {state.error && (
            <div className="channel-member-feedback is-error" role="alert">
              {state.error}
            </div>
          )}
          {state.notice && (
            <div className="channel-member-feedback is-success" role="status">
              {state.notice}
            </div>
          )}

          {state.loading ? (
            <div className="channel-member-empty" role="status">
              Loading joined Channels…
            </div>
          ) : (
            <>
              <section className="channel-member-section" aria-labelledby={`${panelId}-saved`}>
                <div className="channel-member-section-heading">
                  <h3 id={`${panelId}-saved`}>Saved on this Mac</h3>
                  <span>{state.memberships.length}</span>
                </div>
                {state.memberships.length === 0 ? (
                  <p className="channel-member-muted">No saved Channel memberships yet.</p>
                ) : (
                  <div className="channel-member-memberships">
                    {state.memberships.map((membership) => {
                      const current =
                        membership.active && channel?.channelId === membership.channelId
                      const canReconnect = membership.status === 'active' && !state.confirmCode
                      const canOpenHistory =
                        membership.status === 'revoked' && !current && !state.confirmCode
                      return (
                        <article
                          key={membership.channelId}
                          className={`channel-member-membership is-${membership.status}${current ? ' is-current' : ''}`}
                        >
                          <div>
                            <strong>{membership.title}</strong>
                            <span>
                              {membership.displayName} ·{' '}
                              {membership.status === 'revoked'
                                ? 'Revoked'
                                : current
                                  ? 'Current'
                                  : 'Saved'}
                            </span>
                          </div>
                          <div className="channel-member-inline-actions">
                            {canReconnect && (!current || !state.connected) && (
                              <button
                                type="button"
                                onClick={() => onReconnect(membership.channelId)}
                                disabled={busy}
                              >
                                {actionLabel(
                                  state,
                                  'reconnect',
                                  current ? 'Reconnect' : 'Open & reconnect'
                                )}
                              </button>
                            )}
                            {canOpenHistory && (
                              <button
                                type="button"
                                onClick={() => onReconnect(membership.channelId)}
                                disabled={busy}
                                aria-label={`Open retained history for ${membership.title} Channel`}
                              >
                                {actionLabel(state, 'reconnect', 'Open history')}
                              </button>
                            )}
                            <button
                              type="button"
                              className="is-danger-quiet"
                              onClick={() =>
                                onRequestForget(membership.channelId, membership.title)
                              }
                              disabled={busy}
                              aria-label={`Forget ${membership.title} Channel membership`}
                            >
                              Forget…
                            </button>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>

              {state.confirmCode ? (
                <section className="channel-member-sas" aria-labelledby={`${panelId}-sas`}>
                  <span className="channel-member-eyebrow">Out-of-band verification</span>
                  <h3 id={`${panelId}-sas`}>Compare this six-digit code with the host</h3>
                  <output aria-label="Channel security code">{state.confirmCode}</output>
                  <p>
                    Confirm only after you and the host read the same code over a separate trusted
                    channel. TaskWraith will not accept the membership before this human check.
                  </p>
                  <div className="channel-member-inline-actions">
                    <button type="button" onClick={onDisconnect} disabled={busy}>
                      Cancel join
                    </button>
                    <button
                      type="button"
                      className="channel-member-primary-button"
                      onClick={onConfirmJoin}
                      disabled={busy}
                    >
                      {actionLabel(state, 'confirm', 'I verified the code — join')}
                    </button>
                  </div>
                </section>
              ) : (
                <section className="channel-member-join" aria-labelledby={`${panelId}-join`}>
                  <h3 id={`${panelId}-join`}>
                    {state.memberships.length ? 'Join another Channel' : 'Join a Channel'}
                  </h3>
                  <p>
                    Paste the complete one-shot invite from a human host. It is sent directly to
                    main and is not retained in the panel after admission begins.
                  </p>
                  <label htmlFor={`${panelId}-display-name`}>Your human display name</label>
                  <input
                    id={`${panelId}-display-name`}
                    value={displayName}
                    maxLength={120}
                    autoComplete="name"
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      onDisplayNameChange(event.target.value)
                    }
                    placeholder="Your name"
                  />
                  <label htmlFor={`${panelId}-invite`}>TaskWraith Channel invite</label>
                  <textarea
                    id={`${panelId}-invite`}
                    value={inviteText}
                    rows={5}
                    maxLength={16_384}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                      onInviteTextChange(event.target.value)
                    }
                    placeholder="Paste the JSON invite here"
                    aria-label="TaskWraith Channel invite"
                  />
                  <button
                    type="button"
                    className="channel-member-primary-button"
                    onClick={onBeginJoin}
                    disabled={busy || !displayName.trim() || !inviteText.trim()}
                  >
                    {actionLabel(state, 'join', 'Begin secure join')}
                  </button>
                </section>
              )}

              {channel && (
                <section className="channel-member-current" aria-labelledby={`${panelId}-current`}>
                  <div className="channel-member-current-header">
                    <div>
                      <span className="channel-member-eyebrow">Current membership</span>
                      <h3 id={`${panelId}-current`}>{channel.title}</h3>
                    </div>
                    <span className={`channel-member-phase is-${state.phase}`}>
                      {phaseLabel(state)}
                    </span>
                  </div>

                  {!state.connected && channel.status === 'active' && (
                    <p className="channel-member-offline-note">
                      Offline. This Mac’s verified durable history stays readable; reconnect to
                      catch up or post.
                    </p>
                  )}
                  {channel.status === 'revoked' && (
                    <p className="channel-member-offline-note is-warning">
                      The host revoked this membership. Saved history remains read-only.
                    </p>
                  )}
                  {state.phase === 'recovery_blocked' && (
                    <p className="channel-member-offline-note is-warning">
                      Local history failed verification. Repair deletes only this Mac’s record copy,
                      then the pinned host can replay it.
                    </p>
                  )}

                  <div className="channel-member-current-actions">
                    {channel.status === 'active' &&
                      !state.connected &&
                      state.phase !== 'recovery_blocked' && (
                        <button
                          type="button"
                          className="channel-member-primary-button"
                          onClick={() => onReconnect(channel.channelId)}
                          disabled={busy}
                        >
                          {actionLabel(state, 'reconnect', 'Reconnect')}
                        </button>
                      )}
                    {postable && (
                      <>
                        <button type="button" onClick={onResume} disabled={busy}>
                          {actionLabel(state, 'resume', 'Catch up')}
                        </button>
                        <button type="button" onClick={onDisconnect} disabled={busy}>
                          {actionLabel(state, 'disconnect', 'Disconnect')}
                        </button>
                      </>
                    )}
                    {state.phase === 'recovery_blocked' && (
                      <button
                        type="button"
                        onClick={() => onRequestReset(channel.channelId, channel.title)}
                        disabled={busy}
                      >
                        Repair local history…
                      </button>
                    )}
                  </div>

                  <section className="channel-member-section" aria-labelledby={`${panelId}-people`}>
                    <div className="channel-member-section-heading">
                      <h4 id={`${panelId}-people`}>People</h4>
                      <span>{state.members.length}</span>
                    </div>
                    <div className="channel-member-people">
                      {state.members.map((person) => (
                        <span
                          key={person.memberId}
                          className={person.memberId === channel.memberId ? 'is-self' : ''}
                        >
                          {person.displayName}
                          {person.memberId === channel.memberId ? ' (you)' : ''}
                        </span>
                      ))}
                    </div>
                  </section>

                  <section
                    className="channel-member-section"
                    aria-labelledby={`${panelId}-history`}
                  >
                    <div className="channel-member-section-heading">
                      <h4 id={`${panelId}-history`}>Durable history</h4>
                      <span>
                        {state.records.length} / {state.highWaterSequence}
                      </span>
                    </div>
                    <div className="channel-member-history">
                      {state.records.map((record) => {
                        const author = memberById.get(record.authorMemberId)
                        const own = record.authorMemberId === channel.memberId
                        return (
                          <article
                            key={record.messageId}
                            className={`channel-member-message${own ? ' is-own' : ''}`}
                          >
                            <div className="channel-member-message-meta">
                              <strong>{author?.displayName || 'Former member'}</strong>
                              <span>#{record.sequence}</span>
                              <time dateTime={isoTime(record.acceptedAt)}>
                                {isoTime(record.acceptedAt)}
                              </time>
                            </div>
                            <p>{record.content}</p>
                          </article>
                        )
                      })}
                      {state.records.length === 0 && (
                        <p className="channel-member-muted">No saved Channel messages yet.</p>
                      )}
                    </div>
                  </section>

                  {postable && (
                    <section className="channel-member-compose" aria-label="Post to joined Channel">
                      <textarea
                        value={draft}
                        rows={3}
                        maxLength={8_000}
                        placeholder="Write a human message…"
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                          onDraftChange(event.target.value)
                        }
                        onKeyDown={onDraftKeyDown}
                        disabled={busy}
                        aria-label="Joined Channel message"
                      />
                      <div>
                        <span>Enter to post · Shift+Enter for a new line</span>
                        <button
                          type="button"
                          className="channel-member-primary-button"
                          onClick={submitDraft}
                          disabled={busy || !draft.trim()}
                        >
                          {actionLabel(state, 'append', 'Post')}
                        </button>
                      </div>
                    </section>
                  )}
                </section>
              )}

              {confirmation && (
                <section className="channel-member-confirmation" role="alert">
                  <strong>
                    {confirmation.kind === 'reset'
                      ? `Repair ${confirmation.title} on this Mac?`
                      : `Forget ${confirmation.title} on this Mac?`}
                  </strong>
                  <p>
                    {confirmation.kind === 'reset'
                      ? 'This deletes only the local record copy. Membership, identity, and host pin stay intact for verified replay.'
                      : 'This deletes the saved membership and local history. It does not revoke the member on the host.'}
                  </p>
                  <div className="channel-member-inline-actions">
                    <button type="button" onClick={onCancelConfirmation} disabled={busy}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={onConfirmDestructiveAction}
                      disabled={busy}
                    >
                      {actionLabel(
                        state,
                        confirmation.kind === 'reset' ? 'reset' : 'forget',
                        confirmation.kind === 'reset' ? 'Repair local history' : 'Forget membership'
                      )}
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}

export function ChannelMemberPanel({
  api,
  defaultDisplayName = '',
  createClientMessageId
}: ChannelMemberPanelProps) {
  const panelId = `channel-member-panel-${useId().replace(/:/g, '')}`
  const resolvedApi = api || resolveRendererApi()
  const controller = useMemo(
    () =>
      resolvedApi
        ? new ChannelMemberPanelController({
            api: resolvedApi,
            ...(createClientMessageId ? { createClientMessageId } : {})
          })
        : null,
    [createClientMessageId, resolvedApi]
  )
  const [state, setState] = useState<ChannelMemberPanelState>(() =>
    controller
      ? controller.snapshot()
      : {
          ...createChannelMemberPanelInitialState(),
          loading: false,
          error: 'Joined Channels are unavailable in this window.'
        }
  )
  const [open, setOpen] = useState(false)
  const [inviteText, setInviteText] = useState('')
  const [displayName, setDisplayName] = useState(defaultDisplayName)
  const [draft, setDraft] = useState('')
  const [confirmation, setConfirmation] = useState<ChannelMemberConfirmation>(null)

  useEffect(() => {
    if (!controller) return
    const unsubscribe = controller.subscribe(setState)
    void controller.start()
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        setConfirmation(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <ChannelMemberPanelView
      panelId={panelId}
      open={open}
      inviteText={inviteText}
      displayName={displayName}
      draft={draft}
      confirmation={confirmation}
      state={state}
      onToggleOpen={() => setOpen((current) => !current)}
      onClosePanel={() => {
        setOpen(false)
        setConfirmation(null)
      }}
      onInviteTextChange={setInviteText}
      onDisplayNameChange={setDisplayName}
      onDraftChange={setDraft}
      onBeginJoin={() => {
        void controller?.beginJoin(inviteText, displayName).then((started) => {
          if (started) setInviteText('')
        })
      }}
      onConfirmJoin={() => void controller?.confirmJoin()}
      onReconnect={(channelId) => void controller?.reconnect(channelId)}
      onResume={() => void controller?.resume()}
      onDisconnect={() => void controller?.disconnect()}
      onAppend={() => {
        void controller?.append(draft).then((posted) => {
          if (posted) setDraft('')
        })
      }}
      onRefresh={() => void controller?.refresh()}
      onRequestReset={(channelId, title) => setConfirmation({ kind: 'reset', channelId, title })}
      onRequestForget={(channelId, title) => setConfirmation({ kind: 'forget', channelId, title })}
      onCancelConfirmation={() => setConfirmation(null)}
      onConfirmDestructiveAction={() => {
        const pending = confirmation
        if (!pending) return
        const action =
          pending.kind === 'reset'
            ? controller?.resetLocalHistory(pending.channelId)
            : controller?.forget(pending.channelId)
        void action?.then((completed) => {
          if (completed) setConfirmation(null)
        })
      }}
    />
  )
}

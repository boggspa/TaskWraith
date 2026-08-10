import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import type { ChannelAgentIpcApi } from '../../../shared/collaboration/ChannelAgentIpc'
import type { ChannelIpcApi, ChannelIpcMember } from '../../../shared/collaboration/ChannelIpc'
import { ChannelAgentManagement } from './ChannelAgentManagement'
import {
  ChannelHostPanelController,
  createChannelHostPanelInitialState,
  type ChannelHostPanelControllerOptions,
  type ChannelHostPanelState
} from '../lib/channelHostPanelModel'

export interface ChannelHostPanelProps {
  chatId: string
  chatTitle: string
  api?: ChannelIpcApi
  agentApi?: ChannelAgentIpcApi
  defaultOwnerDisplayName?: string
  createClientMessageId?: ChannelHostPanelControllerOptions['createClientMessageId']
  createAgentRequestId?: () => string
  copyText?: ChannelHostPanelControllerOptions['copyText']
}

export interface ChannelHostPanelViewProps {
  chatTitle: string
  panelId: string
  open: boolean
  ownerDisplayName: string
  draft: string
  closeConfirmation: boolean
  state: ChannelHostPanelState
  agentManagement?: ReactNode
  onToggleOpen: () => void
  onClosePanel: () => void
  onOwnerDisplayNameChange: (value: string) => void
  onDraftChange: (value: string) => void
  onCreate: () => void
  onIssueInvite: () => void
  onCopyInvite: () => void
  onClearInvite: () => void
  onAppend: () => void
  onLoadMore: () => void
  onRevokeMember: (memberId: string) => void
  onRetry: () => void
  onRequestClose: () => void
  onCancelClose: () => void
  onConfirmClose: () => void
}

function resolveRendererApi(): ChannelIpcApi | null {
  if (typeof window === 'undefined') return null
  return window.api?.channels || null
}

function memberStatusLabel(status: ChannelIpcMember['status']): string {
  if (status === 'active') return 'Active'
  if (status === 'pending') return 'Joining'
  return 'Removed'
}

function isoTime(timestamp: number): string {
  try {
    return new Date(timestamp).toISOString()
  } catch {
    return ''
  }
}

function actionLabel(state: ChannelHostPanelState, action: ChannelHostPanelState['busy']): string {
  return state.busy === action ? 'Working…' : ''
}

export function ChannelHostPanelView({
  chatTitle,
  panelId,
  open,
  ownerDisplayName,
  draft,
  closeConfirmation,
  state,
  agentManagement,
  onToggleOpen,
  onClosePanel,
  onOwnerDisplayNameChange,
  onDraftChange,
  onCreate,
  onIssueInvite,
  onCopyInvite,
  onClearInvite,
  onAppend,
  onLoadMore,
  onRevokeMember,
  onRetry,
  onRequestClose,
  onCancelClose,
  onConfirmClose
}: ChannelHostPanelViewProps) {
  const channel = state.channel
  const active = channel?.status === 'active'
  const ready = channel?.availability === 'ready'
  const busy = state.busy !== null
  const memberById = new Map(state.members.map((member) => [member.memberId, member]))
  const lastSequence = state.records.at(-1)?.sequence || 0
  const hasMore = lastSequence < state.highWaterSequence

  const submitDraft = (): void => {
    if (!busy && active && ready && draft.trim()) onAppend()
  }

  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submitDraft()
  }

  return (
    <div className="channel-host-control">
      <button
        type="button"
        className="human-collaboration-people-btn channel-host-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggleOpen}
        title="Open this chat’s durable Channel"
      >
        Channel
        {active && ready && <span className="channel-host-live-dot" aria-label="Channel active" />}
        {channel && (
          <span
            className="channel-host-trigger-count"
            aria-label={`${channel.display.memberCount} members`}
          >
            {channel.display.memberCount}
          </span>
        )}
      </button>

      {open && (
        <section
          id={panelId}
          className="channel-host-panel"
          role="dialog"
          aria-label={`Channel for ${chatTitle}`}
        >
          <header className="channel-host-panel-header">
            <div>
              <span className="channel-host-eyebrow">Channel</span>
              <h2>{channel?.display.title || chatTitle}</h2>
            </div>
            <button
              type="button"
              className="channel-host-icon-button"
              onClick={onClosePanel}
              aria-label="Close Channel panel"
            >
              ×
            </button>
          </header>

          <p className="channel-host-safety-note">
            Human posts stay manual. Signed agent participants and replies are labelled; automatic
            mention dispatch remains disabled pending security review.
          </p>

          {state.error && (
            <div className="channel-host-feedback is-error" role="alert">
              <span>{state.error}</span>
              <button type="button" onClick={onRetry} disabled={busy}>
                Retry
              </button>
            </div>
          )}
          {state.notice && (
            <div className="channel-host-feedback is-success" role="status">
              {state.notice}
            </div>
          )}

          {state.loading && !channel ? (
            <div className="channel-host-empty" role="status">
              Loading Channel…
            </div>
          ) : !channel ? (
            <div className="channel-host-create">
              <p>
                Create a durable room for the people working in this chat. The existing People share
                stays available alongside it while Channels rolls out.
              </p>
              <label htmlFor={`${panelId}-owner`}>Your Channel name</label>
              <input
                id={`${panelId}-owner`}
                value={ownerDisplayName}
                maxLength={120}
                autoComplete="name"
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onOwnerDisplayNameChange(event.target.value)
                }
                placeholder="Host"
              />
              <button
                type="button"
                className="channel-host-primary-button"
                onClick={onCreate}
                disabled={busy || !ownerDisplayName.trim()}
              >
                {actionLabel(state, 'create') || 'Create Channel'}
              </button>
            </div>
          ) : (
            <>
              <div className="channel-host-summary">
                <span
                  className={`channel-host-status is-${channel.availability === 'recovery_blocked' ? 'blocked' : channel.status}`}
                >
                  {channel.availability === 'recovery_blocked'
                    ? 'Recovery needed'
                    : channel.status === 'active'
                      ? 'Active'
                      : 'Closed'}
                </span>
                <span>{channel.display.memberCount} members</span>
                <span>{channel.display.messageCount} messages</span>
              </div>

              {active && ready && state.pendingAdmissions.length > 0 && (
                <section
                  className="channel-host-admissions"
                  aria-labelledby={`${panelId}-admissions`}
                >
                  <div className="channel-host-section-heading">
                    <div>
                      <h3 id={`${panelId}-admissions`}>Confirm joins</h3>
                      <span>Compare each code out of band before the member confirms.</span>
                    </div>
                  </div>
                  <div className="channel-host-admission-list">
                    {state.pendingAdmissions.map((admission) => (
                      <div key={admission.memberId} className="channel-host-admission">
                        <div>
                          <strong>{admission.displayName}</strong>
                          <span>Security code</span>
                        </div>
                        <output
                          className="channel-host-admission-code"
                          aria-label={`Security code ${admission.confirmCode}`}
                        >
                          {admission.confirmCode}
                        </output>
                        <button
                          type="button"
                          onClick={() => onRevokeMember(admission.memberId)}
                          disabled={busy}
                          aria-label={`Reject ${admission.displayName}'s Channel join`}
                        >
                          Codes differ — remove
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="channel-host-section" aria-labelledby={`${panelId}-members`}>
                <div className="channel-host-section-heading">
                  <h3 id={`${panelId}-members`}>Members</h3>
                  {active && ready && (
                    <button type="button" onClick={onIssueInvite} disabled={busy}>
                      {actionLabel(state, 'invite') || 'Copy fresh invite'}
                    </button>
                  )}
                </div>
                <div className="channel-host-members">
                  {state.members.map((member) => {
                    const owner = member.memberId === channel.ownerMemberId
                    return (
                      <div
                        key={member.memberId}
                        className={`channel-host-member is-${member.status}`}
                      >
                        <div>
                          <strong>{member.displayName}</strong>
                          <span>
                            {owner ? 'Owner' : member.kind === 'agent' ? 'Agent' : 'Human'} ·{' '}
                            {memberStatusLabel(member.status)}
                          </span>
                        </div>
                        {!owner &&
                          member.kind === 'human' &&
                          member.status !== 'revoked' &&
                          active &&
                          ready && (
                            <button
                              type="button"
                              onClick={() => onRevokeMember(member.memberId)}
                              disabled={busy}
                              aria-label={`Remove ${member.displayName} from Channel`}
                            >
                              Remove
                            </button>
                          )}
                      </div>
                    )
                  })}
                  {state.members.length === 0 && (
                    <span className="channel-host-muted">Member details are unavailable.</span>
                  )}
                </div>
              </section>

              {active && ready && agentManagement}

              {state.invite && (
                <section className="channel-host-invite" aria-labelledby={`${panelId}-invite`}>
                  <div className="channel-host-section-heading">
                    <div>
                      <h3 id={`${panelId}-invite`}>One-shot invite</h3>
                      <span>Expires {isoTime(state.invite.expiresAt)}</span>
                    </div>
                    <div className="channel-host-inline-actions">
                      <button type="button" onClick={onCopyInvite}>
                        {state.invite.copied ? 'Copied' : 'Copy'}
                      </button>
                      <button type="button" onClick={onClearInvite}>
                        Hide
                      </button>
                    </div>
                  </div>
                  {!state.invite.hostRoomOpened && (
                    <p className="channel-host-invite-warning">
                      The relay room is not open yet. Check Devices before sending this invite.
                    </p>
                  )}
                  <textarea
                    readOnly
                    value={state.invite.payload}
                    rows={4}
                    aria-label="Channel invite payload"
                    spellCheck={false}
                  />
                  <p>Confirm the six-digit security code out of band before admitting anyone.</p>
                </section>
              )}

              <section className="channel-host-section" aria-labelledby={`${panelId}-history`}>
                <div className="channel-host-section-heading">
                  <h3 id={`${panelId}-history`}>History</h3>
                  <span>
                    {lastSequence} / {state.highWaterSequence}
                  </span>
                </div>
                <div className="channel-host-history" aria-live="polite">
                  {state.records.map((record) => {
                    const member = memberById.get(record.authorMemberId)
                    const own = record.authorMemberId === channel.ownerMemberId
                    return (
                      <article
                        key={record.messageId}
                        className={`channel-host-message${own ? ' is-own' : ''}${record.kind === 'agent.text' ? ' is-agent' : ''}`}
                      >
                        <div className="channel-host-message-meta">
                          <strong>
                            {member?.displayName ||
                              (record.kind === 'agent.text' ? 'Former agent' : 'Former member')}
                          </strong>
                          {record.kind === 'agent.text' && <span>Agent</span>}
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
                    <p className="channel-host-muted">No Channel messages yet.</p>
                  )}
                </div>
                {hasMore && (
                  <button
                    type="button"
                    className="channel-host-load-more"
                    onClick={onLoadMore}
                    disabled={busy}
                  >
                    {actionLabel(state, 'history') || 'Load newer messages'}
                  </button>
                )}
              </section>

              {active && ready && (
                <section className="channel-host-compose" aria-label="Post to Channel">
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
                    aria-label="Channel message"
                  />
                  <div>
                    <span>Enter to post · Shift+Enter for a new line</span>
                    <button
                      type="button"
                      className="channel-host-primary-button"
                      onClick={submitDraft}
                      disabled={busy || !draft.trim()}
                    >
                      {actionLabel(state, 'append') || 'Post'}
                    </button>
                  </div>
                </section>
              )}

              {active && ready && (
                <section className="channel-host-danger-zone">
                  {!closeConfirmation ? (
                    <button type="button" onClick={onRequestClose} disabled={busy}>
                      Close Channel…
                    </button>
                  ) : (
                    <div role="alert">
                      <span>
                        Close this Channel? Members will lose access; history is retained.
                      </span>
                      <div className="channel-host-inline-actions">
                        <button type="button" onClick={onCancelClose} disabled={busy}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="is-danger"
                          onClick={onConfirmClose}
                          disabled={busy}
                        >
                          {actionLabel(state, 'close') || 'Close Channel'}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}

function ChannelHostPanelForChat({
  chatId,
  chatTitle,
  api,
  agentApi,
  defaultOwnerDisplayName = 'Host',
  createClientMessageId,
  createAgentRequestId,
  copyText
}: ChannelHostPanelProps) {
  const panelId = `channel-host-panel-${useId().replace(/:/g, '')}`
  const resolvedApi = api || resolveRendererApi()
  const controller = useMemo(
    () =>
      resolvedApi
        ? new ChannelHostPanelController({
            api: resolvedApi,
            chatId,
            ...(createClientMessageId ? { createClientMessageId } : {}),
            ...(copyText ? { copyText } : {})
          })
        : null,
    [chatId, copyText, createClientMessageId, resolvedApi]
  )
  const [state, setState] = useState<ChannelHostPanelState>(() =>
    controller
      ? controller.snapshot()
      : {
          ...createChannelHostPanelInitialState(),
          loading: false,
          error: 'Channels are unavailable in this window.'
        }
  )
  const [open, setOpen] = useState(false)
  const [ownerDisplayName, setOwnerDisplayName] = useState(defaultOwnerDisplayName)
  const [draft, setDraft] = useState('')
  const [closeConfirmation, setCloseConfirmation] = useState(false)

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
        setCloseConfirmation(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <ChannelHostPanelView
      chatTitle={chatTitle}
      panelId={panelId}
      open={open}
      ownerDisplayName={ownerDisplayName}
      draft={draft}
      closeConfirmation={closeConfirmation}
      state={state}
      agentManagement={
        state.channel ? (
          <ChannelAgentManagement
            channelId={state.channel.channelId}
            ownerMemberId={state.channel.ownerMemberId}
            api={agentApi}
            createRequestId={createAgentRequestId}
          />
        ) : null
      }
      onToggleOpen={() => setOpen((current) => !current)}
      onClosePanel={() => {
        setOpen(false)
        setCloseConfirmation(false)
      }}
      onOwnerDisplayNameChange={setOwnerDisplayName}
      onDraftChange={setDraft}
      onCreate={() => void controller?.create(ownerDisplayName)}
      onIssueInvite={() => void controller?.issueInvite()}
      onCopyInvite={() => void controller?.copyCurrentInvite()}
      onClearInvite={() => controller?.clearInvite()}
      onAppend={() => {
        void controller?.append(draft).then((posted) => {
          if (posted) setDraft('')
        })
      }}
      onLoadMore={() => void controller?.loadMoreHistory()}
      onRevokeMember={(memberId) => void controller?.revokeMember(memberId)}
      onRetry={() => void controller?.retry()}
      onRequestClose={() => setCloseConfirmation(true)}
      onCancelClose={() => setCloseConfirmation(false)}
      onConfirmClose={() => {
        void controller?.close().then((closed) => {
          if (closed) setCloseConfirmation(false)
        })
      }}
    />
  )
}

export function ChannelHostPanel(props: ChannelHostPanelProps) {
  // A chat switch must drop draft text, an open invite token, and close
  // confirmation synchronously. A keyed leaf makes that boundary structural
  // instead of relying on an after-render reset effect.
  return <ChannelHostPanelForChat key={props.chatId} {...props} />
}

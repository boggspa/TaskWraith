import { useEffect, useId, useMemo, useState, type ChangeEvent } from 'react'
import type {
  ChannelAgentIpcApi,
  ChannelAgentIpcOverview,
  ChannelAgentIpcOverviewSeat,
  ChannelAgentIpcPermissionPresetId
} from '../../../shared/collaboration/ChannelAgentIpc'
import {
  ChannelAgentManagementController,
  channelAgentGrantDraftError,
  createChannelAgentGrantDraft,
  createChannelAgentManagementInitialState,
  type ChannelAgentGrantDraft,
  type ChannelAgentManagementAction,
  type ChannelAgentManagementControllerOptions,
  type ChannelAgentManagementState
} from '../lib/channelAgentManagementModel'

const PERMISSION_PRESET_LABELS: Record<ChannelAgentIpcPermissionPresetId, string> = {
  read_only: 'Read only',
  plan: 'Plan',
  default: 'Default',
  workspace_write: 'Workspace write',
  full_access: 'Full access'
}

export interface ChannelAgentManagementProps {
  channelId: string
  ownerMemberId: string
  api?: ChannelAgentIpcApi
  createRequestId?: ChannelAgentManagementControllerOptions['createRequestId']
}

export interface ChannelAgentManagementViewProps {
  sectionId: string
  ownerMemberId: string
  state: ChannelAgentManagementState
  onRefresh: () => void
  onEnroll: (agentSeatId: string) => void
  onGrant: (agentSeatId: string, draft: ChannelAgentGrantDraft) => void
  onRevoke: (agentSeatId: string) => void
  onRotate: (agentSeatId: string) => void
}

function resolveRendererApi(): ChannelAgentIpcApi | null {
  if (typeof window === 'undefined') return null
  return window.api?.channelAgents || null
}

function actionLabel(
  state: ChannelAgentManagementState,
  action: ChannelAgentManagementAction,
  agentSeatId?: string
): string {
  if (
    state.busy?.action === action &&
    (agentSeatId === undefined || state.busy.agentSeatId === agentSeatId)
  ) {
    return 'Working…'
  }
  return ''
}

function seatDescriptor(entry: ChannelAgentIpcOverviewSeat): string {
  const details = [entry.seat.provider, entry.seat.model, entry.seat.role].filter(
    (value): value is string => Boolean(value)
  )
  return details.length > 0 ? details.join(' · ') : 'Roster descriptor unavailable'
}

function membershipLabel(entry: ChannelAgentIpcOverviewSeat): string {
  if (!entry.membership) {
    return entry.currentKeyGeneration === null
      ? 'Not enrolled · no stable key yet'
      : `Not enrolled · stable key generation ${entry.currentKeyGeneration}`
  }
  return `${entry.membership.status === 'active' ? 'Active' : 'Removed'} · key generation ${entry.membership.keyGeneration}`
}

function grantLifetimeMinutes(overview: ChannelAgentIpcOverview, ttlMs: number): number {
  const minimum = Math.ceil(overview.grantLimits.minimumTtlMs / 60_000)
  const maximum = Math.floor(overview.grantLimits.maximumTtlMs / 60_000)
  return Math.min(maximum, Math.max(minimum, Math.round(ttlMs / 60_000)))
}

interface ChannelAgentSeatCardProps {
  entry: ChannelAgentIpcOverviewSeat
  overview: ChannelAgentIpcOverview
  ownerMemberId: string
  busy: boolean
  activeAction: ChannelAgentManagementState['busy']
  onEnroll: (agentSeatId: string) => void
  onGrant: (agentSeatId: string, draft: ChannelAgentGrantDraft) => void
  onRevoke: (agentSeatId: string) => void
  onRotate: (agentSeatId: string) => void
}

function ChannelAgentSeatCard({
  entry,
  overview,
  ownerMemberId,
  busy,
  activeAction,
  onEnroll,
  onGrant,
  onRevoke,
  onRotate
}: ChannelAgentSeatCardProps) {
  const [draft, setDraft] = useState<ChannelAgentGrantDraft>(() =>
    createChannelAgentGrantDraft(overview, ownerMemberId)
  )
  const agentSeatId = entry.seat.agentSeatId
  const membershipCurrent =
    entry.membership !== undefined &&
    entry.currentKeyGeneration !== null &&
    entry.membership.keyGeneration === entry.currentKeyGeneration
  const active = entry.membership?.status === 'active' && membershipCurrent
  const revokedCurrent = entry.membership?.status === 'revoked' && membershipCurrent
  const available = entry.seat.provider !== null
  const canEnroll = available && !active && !revokedCurrent
  const canRotate = Boolean(entry.membership && membershipCurrent)
  const grantError = channelAgentGrantDraftError(draft, overview)
  const ttlMinutes = Number.isFinite(draft.ttlMs) ? grantLifetimeMinutes(overview, draft.ttlMs) : ''
  const minimumTtlMinutes = Math.ceil(overview.grantLimits.minimumTtlMs / 60_000)
  const maximumTtlMinutes = Math.floor(overview.grantLimits.maximumTtlMs / 60_000)
  const controlId = `channel-agent-${agentSeatId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const working = (action: ChannelAgentManagementAction): string =>
    activeAction?.agentSeatId === agentSeatId && activeAction.action === action ? 'Working…' : ''

  const updateMentioner = (memberId: string, checked: boolean): void => {
    setDraft((current) => ({
      ...current,
      allowedMentionerMemberIds: checked
        ? [...new Set([...current.allowedMentionerMemberIds, memberId])].sort()
        : current.allowedMentionerMemberIds.filter((candidate) => candidate !== memberId)
    }))
  }

  return (
    <article
      className={`channel-agent-seat${entry.membership?.status === 'revoked' ? ' is-revoked' : ''}`}
      aria-label={`${entry.seat.displayName} Channel agent`}
    >
      <div className="channel-agent-seat-heading">
        <div>
          <strong>{entry.seat.displayName}</strong>
          <span>{seatDescriptor(entry)}</span>
        </div>
        <span>{membershipLabel(entry)}</span>
      </div>

      {canEnroll && (
        <button
          type="button"
          onClick={() => onEnroll(agentSeatId)}
          disabled={busy}
          aria-label={`Review enrollment for ${entry.seat.displayName}`}
        >
          {working('enroll') || 'Review enrollment…'}
        </button>
      )}

      {revokedCurrent && (
        <p className="channel-agent-seat-note">
          This generation is revoked. Rotate the stable key before re-enrolling.
        </p>
      )}

      {active && available && (
        <div className="channel-agent-grant-controls">
          <label htmlFor={`${controlId}-preset`}>Permission preset</label>
          <select
            id={`${controlId}-preset`}
            value={draft.permissionPresetId}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              setDraft((current) => ({
                ...current,
                permissionPresetId: event.target.value as ChannelAgentIpcPermissionPresetId
              }))
            }
            disabled={busy}
          >
            {overview.permissionPresetIds.map((presetId) => (
              <option key={presetId} value={presetId}>
                {PERMISSION_PRESET_LABELS[presetId]}
              </option>
            ))}
          </select>

          <fieldset>
            <legend>Humans allowed to mention this agent</legend>
            {overview.allowedMentioners.map((mentioner) => (
              <label key={mentioner.memberId}>
                <input
                  type="checkbox"
                  checked={draft.allowedMentionerMemberIds.includes(mentioner.memberId)}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    updateMentioner(mentioner.memberId, event.target.checked)
                  }
                  disabled={busy}
                />
                <span>
                  {mentioner.displayName}
                  {mentioner.memberId === ownerMemberId ? ' · Owner' : ''}
                </span>
              </label>
            ))}
          </fieldset>

          <div className="channel-agent-grant-bounds">
            <label htmlFor={`${controlId}-ttl`}>
              Lifetime (minutes)
              <input
                id={`${controlId}-ttl`}
                type="number"
                min={minimumTtlMinutes}
                max={maximumTtlMinutes}
                step={1}
                value={ttlMinutes}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setDraft((current) => ({
                    ...current,
                    ttlMs: event.target.valueAsNumber * 60_000
                  }))
                }
                disabled={busy}
              />
            </label>
            <label htmlFor={`${controlId}-budget`}>
              Dispatch budget
              <input
                id={`${controlId}-budget`}
                type="number"
                min={1}
                max={overview.grantLimits.maximumDispatches}
                step={1}
                value={Number.isFinite(draft.maxDispatches) ? draft.maxDispatches : ''}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setDraft((current) => ({
                    ...current,
                    maxDispatches: event.target.valueAsNumber
                  }))
                }
                disabled={busy}
              />
            </label>
          </div>

          {grantError && <p className="channel-agent-seat-note">{grantError}</p>}
          <button
            type="button"
            className="channel-host-primary-button"
            onClick={() => onGrant(agentSeatId, draft)}
            disabled={busy || Boolean(grantError)}
            aria-label={`Review mention grant for ${entry.seat.displayName}`}
          >
            {working('grant') || 'Review mention grant…'}
          </button>
          <p className="channel-agent-seat-note">
            The native confirmation shows the exact workspace, permissions, mentioners, lifetime,
            and budget before anything is signed.
          </p>
        </div>
      )}

      {entry.membership && (
        <div className="channel-agent-seat-actions">
          {active && (
            <button
              type="button"
              onClick={() => onRevoke(agentSeatId)}
              disabled={busy}
              aria-label={`Remove ${entry.seat.displayName} from Channel`}
            >
              {working('revoke') || 'Remove agent…'}
            </button>
          )}
          {canRotate && (
            <button
              type="button"
              onClick={() => onRotate(agentSeatId)}
              disabled={busy}
              aria-label={`Rotate key and re-enroll ${entry.seat.displayName}`}
            >
              {working('rotate') || 'Rotate key & re-enroll…'}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

export function ChannelAgentManagementView({
  sectionId,
  ownerMemberId,
  state,
  onRefresh,
  onEnroll,
  onGrant,
  onRevoke,
  onRotate
}: ChannelAgentManagementViewProps) {
  const overview = state.overview
  const busy = state.busy !== null
  const grantControlsKey = overview
    ? JSON.stringify({
        mentioners: overview.allowedMentioners.map((mentioner) => mentioner.memberId),
        presets: overview.permissionPresetIds,
        limits: overview.grantLimits
      })
    : ''

  return (
    <section className="channel-agent-management" aria-labelledby={`${sectionId}-heading`}>
      <div className="channel-host-section-heading">
        <h3 id={`${sectionId}-heading`}>Agents</h3>
        <button type="button" onClick={onRefresh} disabled={busy || state.loading}>
          {actionLabel(state, 'refresh') || 'Refresh'}
        </button>
      </div>
      <p className="channel-host-safety-note">
        Grants can be reviewed and signed now. Automatic mention dispatch remains source-disabled
        until the P3 adversarial security review is accepted.
      </p>

      {state.error && (
        <div className="channel-host-feedback is-error" role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={onRefresh} disabled={busy}>
            Retry
          </button>
        </div>
      )}
      {state.notice && (
        <div className="channel-host-feedback is-success" role="status">
          {state.notice}
        </div>
      )}

      {state.loading && <p className="channel-host-muted">Loading signed agent roster…</p>}
      {!state.loading && overview && overview.seats.length === 0 && (
        <p className="channel-host-muted">
          No eligible pooled Agents are attached to this chat yet.
        </p>
      )}
      {overview && overview.seats.length > 0 && (
        <div className="channel-agent-seat-list">
          {overview.seats.map((entry) => (
            <ChannelAgentSeatCard
              key={`${entry.seat.agentSeatId}:${entry.currentKeyGeneration ?? 'none'}:${entry.membership?.memberId || 'none'}:${entry.membership?.status || 'none'}:${grantControlsKey}`}
              entry={entry}
              overview={overview}
              ownerMemberId={ownerMemberId}
              busy={busy}
              activeAction={state.busy}
              onEnroll={onEnroll}
              onGrant={onGrant}
              onRevoke={onRevoke}
              onRotate={onRotate}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ChannelAgentManagementForChannel({
  channelId,
  ownerMemberId,
  api,
  createRequestId
}: ChannelAgentManagementProps) {
  const sectionId = `channel-agent-management-${useId().replace(/:/g, '')}`
  const resolvedApi = api || resolveRendererApi()
  const controller = useMemo(
    () =>
      resolvedApi
        ? new ChannelAgentManagementController({
            api: resolvedApi,
            channelId,
            ...(createRequestId ? { createRequestId } : {})
          })
        : null,
    [channelId, createRequestId, resolvedApi]
  )
  const [state, setState] = useState<ChannelAgentManagementState>(() =>
    controller
      ? controller.snapshot()
      : {
          ...createChannelAgentManagementInitialState(),
          loading: false,
          error: 'Channel agent management is unavailable in this window.'
        }
  )

  useEffect(() => {
    if (!controller) return
    const unsubscribe = controller.subscribe(setState)
    void controller.start()
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller])

  return (
    <ChannelAgentManagementView
      sectionId={sectionId}
      ownerMemberId={ownerMemberId}
      state={state}
      onRefresh={() => void controller?.refresh()}
      onEnroll={(agentSeatId) => void controller?.enroll(agentSeatId)}
      onGrant={(agentSeatId, draft) => void controller?.grant(agentSeatId, draft)}
      onRevoke={(agentSeatId) => void controller?.revoke(agentSeatId)}
      onRotate={(agentSeatId) => void controller?.rotate(agentSeatId)}
    />
  )
}

export function ChannelAgentManagement(props: ChannelAgentManagementProps) {
  return <ChannelAgentManagementForChannel key={props.channelId} {...props} />
}

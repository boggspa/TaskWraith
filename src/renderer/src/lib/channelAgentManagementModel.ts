import type {
  ChannelAgentIpcApi,
  ChannelAgentIpcError,
  ChannelAgentIpcOutcome,
  ChannelAgentIpcOverview,
  ChannelAgentIpcOverviewSeat,
  ChannelAgentIpcPermissionPresetId,
  ChannelAgentIpcResult
} from '../../../shared/collaboration/ChannelAgentIpc'

export type ChannelAgentManagementAction = 'refresh' | 'enroll' | 'grant' | 'revoke' | 'rotate'

export interface ChannelAgentManagementBusyAction {
  action: ChannelAgentManagementAction
  agentSeatId?: string
}

export interface ChannelAgentManagementState {
  loading: boolean
  busy: ChannelAgentManagementBusyAction | null
  overview: ChannelAgentIpcOverview | null
  notice: string | null
  error: string | null
}

export interface ChannelAgentGrantDraft {
  permissionPresetId: ChannelAgentIpcPermissionPresetId
  allowedMentionerMemberIds: string[]
  ttlMs: number
  maxDispatches: number
}

export interface ChannelAgentManagementControllerOptions {
  api: ChannelAgentIpcApi
  channelId: string
  createRequestId?: () => string
}

type StateListener = (state: ChannelAgentManagementState) => void

interface PendingRequest {
  intentKey: string
  requestId: string
}

interface NormalizedGrantIntent {
  permissionPresetId: ChannelAgentIpcPermissionPresetId
  allowedMentionerMemberIds: string[]
  ttlMs: number
  maxDispatches: number
}

export function createChannelAgentManagementInitialState(): ChannelAgentManagementState {
  return {
    loading: true,
    busy: null,
    overview: null,
    notice: null,
    error: null
  }
}

export function createChannelAgentManagementRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') {
    throw new Error('Secure Channel agent request generation is unavailable')
  }
  return `channel-agent:${randomUUID.call(globalThis.crypto)}`
}

export function createChannelAgentGrantDraft(
  overview: ChannelAgentIpcOverview,
  ownerMemberId: string
): ChannelAgentGrantDraft {
  const permissionPresetId = overview.permissionPresetIds.includes('read_only')
    ? 'read_only'
    : overview.permissionPresetIds[0] || 'read_only'
  const ownerAvailable = overview.allowedMentioners.some(
    (mentioner) => mentioner.memberId === ownerMemberId
  )
  return {
    permissionPresetId,
    allowedMentionerMemberIds: ownerAvailable ? [ownerMemberId] : [],
    ttlMs: overview.grantLimits.defaultTtlMs,
    maxDispatches: overview.grantLimits.defaultMaxDispatches
  }
}

export function channelAgentGrantDraftError(
  draft: ChannelAgentGrantDraft,
  overview: ChannelAgentIpcOverview
): string | null {
  if (!overview.permissionPresetIds.includes(draft.permissionPresetId)) {
    return 'Choose an available permission preset.'
  }
  const knownMentioners = new Set(overview.allowedMentioners.map((mentioner) => mentioner.memberId))
  const mentioners = [...new Set(draft.allowedMentionerMemberIds)].sort()
  if (
    mentioners.length === 0 ||
    mentioners.length !== draft.allowedMentionerMemberIds.length ||
    mentioners.some((memberId) => !knownMentioners.has(memberId))
  ) {
    return 'Choose at least one active human who may mention this agent.'
  }
  if (
    !Number.isSafeInteger(draft.ttlMs) ||
    draft.ttlMs < overview.grantLimits.minimumTtlMs ||
    draft.ttlMs > overview.grantLimits.maximumTtlMs
  ) {
    return 'Choose a grant lifetime inside the displayed bounds.'
  }
  if (
    !Number.isSafeInteger(draft.maxDispatches) ||
    draft.maxDispatches < 1 ||
    draft.maxDispatches > overview.grantLimits.maximumDispatches
  ) {
    return 'Choose a dispatch budget inside the displayed bounds.'
  }
  return null
}

function normalizeGrantIntent(
  draft: ChannelAgentGrantDraft,
  overview: ChannelAgentIpcOverview
): { value: NormalizedGrantIntent } | { error: string } {
  const error = channelAgentGrantDraftError(draft, overview)
  if (error) return { error }
  return {
    value: {
      permissionPresetId: draft.permissionPresetId,
      allowedMentionerMemberIds: [...draft.allowedMentionerMemberIds].sort(),
      ttlMs: draft.ttlMs,
      maxDispatches: draft.maxDispatches
    }
  }
}

function describeIpcError(error: ChannelAgentIpcError): string {
  switch (error.code) {
    case 'not_authorized':
      return 'Only the main TaskWraith window may manage Channel agents.'
    case 'recovery_blocked':
    case 'channel_unavailable':
      return 'Agent management is unavailable until this Channel’s durable state is recovered.'
    case 'channel_closed':
      return 'This Channel is closed.'
    case 'host_unavailable':
      return 'Channel agent management is unavailable. Try again from the host Mac.'
    case 'not_enrolled':
    case 'not_member':
      return 'That agent is not currently available for this Channel action.'
    case 'rotation_required':
    case 'identity_mismatch':
      return 'Rotate this agent’s stable key before enrolling it again.'
    case 'authority_expired':
    case 'revoked':
      return 'That agent authority is no longer active.'
    case 'quota_exceeded':
      return 'That action exceeds a Channel agent safety limit.'
    case 'invalid_input':
    case 'protocol_unsupported':
    case 'human_only':
    case 'idempotency_conflict':
    case 'invalid_cursor':
    case 'resync_required':
      return 'The Channel agent request is no longer valid. Refresh and try again.'
    default:
      return 'The Channel agent request could not be completed.'
  }
}

function describeThrown(error: unknown): string {
  if (
    error instanceof Error &&
    error.message === 'Secure Channel agent request generation is unavailable'
  ) {
    return error.message
  }
  return 'The Channel agent request could not be completed. Try again.'
}

function actionNotice(outcome: ChannelAgentIpcOutcome): string {
  if (outcome.status === 'declined') return 'No Channel agent changes were made.'
  if (outcome.status === 'stale') {
    return 'Channel state changed during confirmation. Review the refreshed details and try again.'
  }
  switch (outcome.value.kind) {
    case 'enroll':
      return 'Agent enrolled as a signed Channel participant.'
    case 'grant':
      return `Mention grant issued for ${outcome.value.maxDispatches} dispatch${outcome.value.maxDispatches === 1 ? '' : 'es'}.`
    case 'revoke':
      return outcome.value.alreadyRevoked
        ? 'Agent was already removed from this Channel.'
        : 'Agent removed and its Channel authority revoked.'
    case 'rotate':
      return outcome.value.resumed
        ? `Stable agent key is already at generation ${outcome.value.toKeyGeneration}.`
        : `Stable agent key rotated to generation ${outcome.value.toKeyGeneration}; prior mention grants stay revoked.`
  }
}

/**
 * Renderer-only coordinator for the signed-agent management panel. It retains
 * no authority: every read and action crosses the closed preload API, and main
 * owns native confirmation, canonical state re-resolution, signing, and keys.
 */
export class ChannelAgentManagementController {
  private state = createChannelAgentManagementInitialState()
  private readonly listeners = new Set<StateListener>()
  private readonly createId: () => string
  private pendingRequest: PendingRequest | null = null
  private started = false
  private disposed = false

  constructor(private readonly options: ChannelAgentManagementControllerOptions) {
    if (!options?.api) throw new Error('Channel agent management requires its closed IPC API')
    if (!options.channelId.trim()) throw new Error('Channel agent management requires a Channel id')
    this.createId = options.createRequestId || createChannelAgentManagementRequestId
  }

  snapshot(): ChannelAgentManagementState {
    return this.state
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    await this.sync()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingRequest = null
    this.listeners.clear()
  }

  async refresh(): Promise<boolean> {
    if (!this.beginAction({ action: 'refresh' })) return false
    const refreshed = await this.sync()
    if (this.disposed) return false
    if (refreshed) {
      this.patch({ busy: null, notice: 'Agent roster refreshed.', error: null })
    } else {
      this.patch({ busy: null })
    }
    return refreshed
  }

  async enroll(agentSeatId: string): Promise<boolean> {
    const seat = this.requireSeat(agentSeatId)
    if (!seat) return false
    const currentMembership = seat.membership
    if (
      currentMembership?.status === 'active' ||
      (currentMembership?.status === 'revoked' &&
        currentMembership.keyGeneration === seat.currentKeyGeneration)
    ) {
      this.patch({
        error:
          currentMembership.status === 'active'
            ? 'That agent is already enrolled in this Channel.'
            : 'Rotate this agent’s stable key before enrolling it again.'
      })
      return false
    }
    if (seat.seat.provider === null) {
      this.patch({ error: 'This agent’s roster descriptor is unavailable, so it cannot enroll.' })
      return false
    }
    return this.perform('enroll', agentSeatId, {}, (requestId) =>
      this.options.api.enroll({ requestId, channelId: this.options.channelId, agentSeatId })
    )
  }

  async grant(agentSeatId: string, draft: ChannelAgentGrantDraft): Promise<boolean> {
    const seat = this.requireSeat(agentSeatId)
    const overview = this.state.overview
    if (!seat || !overview) return false
    if (
      seat.membership?.status !== 'active' ||
      seat.membership.keyGeneration !== seat.currentKeyGeneration ||
      seat.seat.provider === null
    ) {
      this.patch({ error: 'Only a current, available agent membership can receive a grant.' })
      return false
    }
    const normalized = normalizeGrantIntent(draft, overview)
    if ('error' in normalized) {
      this.patch({ error: normalized.error })
      return false
    }
    return this.perform('grant', agentSeatId, normalized.value, (requestId) =>
      this.options.api.grant({
        requestId,
        channelId: this.options.channelId,
        agentSeatId,
        ...normalized.value
      })
    )
  }

  async revoke(agentSeatId: string): Promise<boolean> {
    const seat = this.requireSeat(agentSeatId)
    if (!seat) return false
    if (seat.membership?.status !== 'active') {
      this.patch({ error: 'Only an active Channel agent can be removed.' })
      return false
    }
    return this.perform('revoke', agentSeatId, {}, (requestId) =>
      this.options.api.revoke({ requestId, channelId: this.options.channelId, agentSeatId })
    )
  }

  async rotate(agentSeatId: string): Promise<boolean> {
    const seat = this.requireSeat(agentSeatId)
    if (!seat) return false
    if (
      !seat.membership ||
      seat.currentKeyGeneration === null ||
      seat.membership.keyGeneration !== seat.currentKeyGeneration
    ) {
      this.patch({ error: 'That agent has no current Channel identity to rotate.' })
      return false
    }
    const reEnrollChannelIds = [this.options.channelId]
    return this.perform('rotate', agentSeatId, { reEnrollChannelIds }, (requestId) =>
      this.options.api.rotate({
        requestId,
        channelId: this.options.channelId,
        agentSeatId,
        reEnrollChannelIds
      })
    )
  }

  private patch(patch: Partial<ChannelAgentManagementState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private beginAction(busy: ChannelAgentManagementBusyAction): boolean {
    if (this.disposed) return false
    if (this.state.busy) {
      this.patch({ error: 'Finish the current Channel agent action first.' })
      return false
    }
    this.patch({ busy, notice: null, error: null })
    return true
  }

  private requireSeat(agentSeatId: string): ChannelAgentIpcOverviewSeat | null {
    const overview = this.state.overview
    if (!overview) {
      this.patch({ error: 'Refresh the Channel agent roster before making changes.' })
      return null
    }
    const matches = overview.seats.filter((entry) => entry.seat.agentSeatId === agentSeatId)
    if (matches.length !== 1) {
      this.patch({ error: 'That Channel agent is no longer available. Refresh and try again.' })
      return null
    }
    return matches[0]
  }

  private requestId(intentKey: string): string {
    if (this.pendingRequest?.intentKey === intentKey) return this.pendingRequest.requestId
    const requestId = this.createId()
    this.pendingRequest = { intentKey, requestId }
    return requestId
  }

  private async perform(
    action: Exclude<ChannelAgentManagementAction, 'refresh'>,
    agentSeatId: string,
    intent: object,
    invoke: (requestId: string) => Promise<ChannelAgentIpcResult<ChannelAgentIpcOutcome>>
  ): Promise<boolean> {
    if (!this.beginAction({ action, agentSeatId })) return false
    const intentKey = JSON.stringify({
      action,
      channelId: this.options.channelId,
      agentSeatId,
      intent
    })
    let requestId: string
    try {
      requestId = this.requestId(intentKey)
    } catch (error) {
      this.patch({ busy: null, error: describeThrown(error) })
      return false
    }
    try {
      const result = await invoke(requestId)
      if (this.disposed) return false
      this.pendingRequest = null
      if (!result.ok) {
        this.patch({ busy: null, notice: null, error: describeIpcError(result.error) })
        return false
      }
      const outcome = result.value
      if (
        outcome.status === 'applied' &&
        (outcome.value.kind !== action || outcome.value.agentSeatId !== agentSeatId)
      ) {
        this.patch({
          busy: null,
          notice: null,
          error: 'The Channel agent response did not match the confirmed action.'
        })
        return false
      }
      const notice = actionNotice(outcome)
      const applied = outcome.status === 'applied'
      const refreshed = await this.sync()
      if (this.disposed) return false
      this.patch({ busy: null, notice, ...(refreshed ? { error: null } : {}) })
      return applied
    } catch (error) {
      // Main can durably apply before the renderer sees a transport failure.
      // Retain the exact request id so an identical retry stays idempotent.
      this.patch({ busy: null, notice: null, error: describeThrown(error) })
      return false
    }
  }

  private async sync(): Promise<boolean> {
    if (this.disposed) return false
    try {
      const result = await this.options.api.overview({ channelId: this.options.channelId })
      if (this.disposed) return false
      if (!result.ok) {
        this.patch({ loading: false, error: describeIpcError(result.error) })
        return false
      }
      if (result.value.channelId !== this.options.channelId) {
        this.patch({
          loading: false,
          error: 'The Channel agent response did not match the active Channel.'
        })
        return false
      }
      this.patch({ loading: false, overview: result.value, error: null })
      return true
    } catch (error) {
      this.patch({ loading: false, error: describeThrown(error) })
      return false
    }
  }
}

import type {
  ChannelMemberIpcApi,
  ChannelMemberIpcError,
  ChannelMemberIpcInvitePayload,
  ChannelMemberIpcMember,
  ChannelMemberIpcMembershipSummary,
  ChannelMemberIpcMessage,
  ChannelMemberIpcPhase,
  ChannelMemberIpcSnapshot
} from '../../../shared/collaboration/ChannelMemberIpc'

const MAX_INVITE_TEXT_LENGTH = 16_384

export type ChannelMemberPanelAction =
  | 'refresh'
  | 'join'
  | 'confirm'
  | 'reconnect'
  | 'append'
  | 'resume'
  | 'disconnect'
  | 'reset'
  | 'forget'

export interface ChannelMemberPanelState {
  loading: boolean
  busy: ChannelMemberPanelAction | null
  memberships: ChannelMemberIpcMembershipSummary[]
  phase: ChannelMemberIpcPhase
  connected: boolean
  channel: ChannelMemberIpcSnapshot['channel']
  members: ChannelMemberIpcMember[]
  records: ChannelMemberIpcMessage[]
  highWaterSequence: number
  confirmCode: string | null
  notice: string | null
  error: string | null
}

export interface ChannelMemberPanelControllerOptions {
  api: ChannelMemberIpcApi
  createClientMessageId?: () => string
}

type StateListener = (state: ChannelMemberPanelState) => void

export function createChannelMemberPanelInitialState(): ChannelMemberPanelState {
  return {
    loading: true,
    busy: null,
    memberships: [],
    phase: 'idle',
    connected: false,
    channel: null,
    members: [],
    records: [],
    highWaterSequence: 0,
    confirmCode: null,
    notice: null,
    error: null
  }
}

export function createChannelMemberClientMessageId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') {
    throw new Error('Secure message identifier generation is unavailable')
  }
  return `member:${randomUUID.call(globalThis.crypto)}`
}

export function parseChannelInviteText(value: string): ChannelMemberIpcInvitePayload | null {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_INVITE_TEXT_LENGTH) return null
  try {
    const parsed: unknown = JSON.parse(normalized)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ChannelMemberIpcInvitePayload
  } catch {
    return null
  }
}

function describeIpcError(error: ChannelMemberIpcError): string {
  switch (error.code) {
    case 'invalid_invite':
      return 'Paste a complete TaskWraith Channel invite.'
    case 'invite_expired':
      return 'That invite has expired. Ask the host for a fresh one.'
    case 'host_unavailable':
      return 'The Channel host is unavailable. Your saved history remains readable offline.'
    case 'identity_unavailable':
      return 'This Mac’s saved Channel identity is unavailable. Do not join again with a replacement identity.'
    case 'not_joined':
      return 'Choose a saved Channel membership first.'
    case 'not_connected':
      return 'Reconnect to the Channel before posting or syncing.'
    case 'revoked':
      return 'This membership was revoked. Its saved history remains read-only.'
    case 'recovery_blocked':
      return 'This Mac’s Channel history needs local repair before it can reconnect.'
    case 'not_authorized':
      return 'Joined Channels are available only in the main window.'
    case 'protocol_error':
      return 'The Channel request did not match the human-member protocol.'
    default:
      return 'The Channel member request could not be completed.'
  }
}

function describeThrown(error: unknown): string {
  if (
    error instanceof Error &&
    error.message === 'Secure message identifier generation is unavailable'
  ) {
    return error.message
  }
  return 'The Channel member request could not be completed. Try again.'
}

function mergeRecord(
  records: readonly ChannelMemberIpcMessage[],
  record: ChannelMemberIpcMessage
): ChannelMemberIpcMessage[] {
  const bySequence = new Map(records.map((candidate) => [candidate.sequence, candidate]))
  bySequence.set(record.sequence, record)
  return Array.from(bySequence.values()).sort((left, right) => left.sequence - right.sequence)
}

/**
 * Renderer-only state coordinator for a human joining someone else's Channel.
 * It retains no invite payload or transport authority: every action crosses
 * the closed preload API, and the durable main-process snapshot is canonical.
 */
export class ChannelMemberPanelController {
  private state = createChannelMemberPanelInitialState()
  private readonly listeners = new Set<StateListener>()
  private readonly createId: () => string
  private removeChangeListener: (() => void) | null = null
  private syncTail: Promise<boolean> = Promise.resolve(true)
  private pendingAppend: { content: string; clientMessageId: string } | null = null
  private started = false
  private disposed = false

  constructor(private readonly options: ChannelMemberPanelControllerOptions) {
    if (!options?.api) throw new Error('Channel member panel requires its closed IPC API')
    this.createId = options.createClientMessageId || createChannelMemberClientMessageId
  }

  snapshot(): ChannelMemberPanelState {
    return this.state
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    try {
      this.removeChangeListener = this.options.api.onChanged(() => {
        void this.enqueueSync(false)
      })
    } catch (error) {
      this.patch({ error: describeThrown(error) })
    }
    await this.enqueueSync(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeChangeListener?.()
    this.removeChangeListener = null
    this.listeners.clear()
  }

  async refresh(): Promise<boolean> {
    if (!this.beginAction('refresh')) return false
    const synced = await this.enqueueSync(false)
    if (synced) this.finishAction('Joined Channels refreshed.')
    else this.patch({ busy: null })
    return synced
  }

  async beginJoin(inviteText: string, displayName: string): Promise<boolean> {
    const invite = parseChannelInviteText(inviteText)
    if (!invite) {
      this.patch({ error: 'Paste a complete TaskWraith Channel invite.' })
      return false
    }
    const normalizedName = displayName.trim()
    if (!normalizedName || normalizedName.length > 120) {
      this.patch({ error: 'Enter the human name the Channel should display.' })
      return false
    }
    if (!this.beginAction('join')) return false
    try {
      const result = await this.options.api.beginJoin({ invite, displayName: normalizedName })
      if (!result.ok) return this.failAction(result.error)
      if (!/^\d{6}$/.test(result.value.confirmCode)) {
        this.patch({ busy: null, error: 'The host returned an invalid SAS confirmation code.' })
        return false
      }
      this.patch({ confirmCode: result.value.confirmCode })
      await this.enqueueSync(false)
      this.finishSynchronizedAction(
        'Compare this code with the host out of band before confirming the membership.'
      )
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async confirmJoin(): Promise<boolean> {
    if (!this.state.confirmCode) {
      this.patch({ error: 'Start a Channel join before confirming its security code.' })
      return false
    }
    if (!this.beginAction('confirm')) return false
    try {
      const result = await this.options.api.confirmJoin()
      if (!result.ok) return this.failAction(result.error)
      this.applySnapshot(result.value, { confirmCode: null })
      await this.enqueueSync(false)
      this.finishSynchronizedAction('Channel membership confirmed and saved on this Mac.')
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async reconnect(channelId?: string): Promise<boolean> {
    if (!this.beginAction('reconnect')) return false
    try {
      const result = await this.options.api.reconnect(channelId ? { channelId } : {})
      if (!result.ok) return this.failAction(result.error)
      const openedReadOnly =
        result.value.phase === 'revoked' || result.value.channel?.status === 'revoked'
      this.applySnapshot(result.value)
      await this.enqueueSync(false)
      this.finishSynchronizedAction(
        openedReadOnly
          ? 'Opened the retained read-only history for this revoked membership.'
          : 'Channel reconnected and caught up from durable history.'
      )
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async append(content: string): Promise<boolean> {
    const normalized = content.trim()
    if (!this.requirePostableChannel()) return false
    if (!normalized) {
      this.patch({ error: 'Write a human message before posting.' })
      return false
    }
    if (!this.beginAction('append')) return false

    let attempt = this.pendingAppend
    if (!attempt || attempt.content !== normalized) {
      try {
        attempt = { content: normalized, clientMessageId: this.createId() }
      } catch (error) {
        return this.failThrown(error)
      }
      this.pendingAppend = attempt
    }

    try {
      const result = await this.options.api.append(attempt)
      if (!result.ok) {
        this.pendingAppend = null
        return this.failAction(result.error)
      }
      this.pendingAppend = null
      this.patch({ records: mergeRecord(this.state.records, result.value.record) })
      await this.enqueueSync(false)
      this.finishSynchronizedAction(
        result.value.deduplicated ? 'Message already posted.' : 'Human message posted.'
      )
      return true
    } catch (error) {
      // Main may have committed before the local response was interrupted.
      // Retain this exact id for a same-content retry.
      return this.failThrown(error)
    }
  }

  async resume(): Promise<boolean> {
    if (!this.requirePostableChannel() || !this.beginAction('resume')) return false
    try {
      const result = await this.options.api.resume()
      if (!result.ok) return this.failAction(result.error)
      this.applySnapshot(result.value)
      this.finishAction('Channel history is caught up.')
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async disconnect(): Promise<boolean> {
    if (!this.beginAction('disconnect')) return false
    try {
      const result = await this.options.api.disconnect()
      if (!result.ok) return this.failAction(result.error)
      this.applySnapshot(result.value, { confirmCode: null })
      this.finishSynchronizedAction(
        'Channel disconnected. Saved history remains available offline.'
      )
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async resetLocalHistory(channelId: string): Promise<boolean> {
    if (!this.beginAction('reset')) return false
    try {
      const result = await this.options.api.resetLocalHistory({ channelId, confirmed: true })
      if (!result.ok) return this.failAction(result.error)
      this.applySnapshot(result.value, { confirmCode: null })
      await this.enqueueSync(false)
      this.finishSynchronizedAction(
        'Local Channel history was reset. Reconnect to replay it from the pinned host.'
      )
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async forget(channelId: string): Promise<boolean> {
    if (!this.beginAction('forget')) return false
    try {
      const result = await this.options.api.forget({ channelId, confirmed: true })
      if (!result.ok) return this.failAction(result.error)
      this.applySnapshot(result.value, { confirmCode: null })
      await this.enqueueSync(true)
      this.finishSynchronizedAction('Saved Channel membership and its local replica were removed.')
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  private patch(patch: Partial<ChannelMemberPanelState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private applySnapshot(
    snapshot: ChannelMemberIpcSnapshot,
    extra: Partial<ChannelMemberPanelState> = {}
  ): void {
    this.patch({
      loading: false,
      phase: snapshot.phase,
      connected: snapshot.connected,
      channel: snapshot.channel,
      members: snapshot.members,
      records: snapshot.records,
      highWaterSequence: snapshot.highWaterSequence,
      ...(snapshot.phase === 'awaiting_sas' ? {} : { confirmCode: null }),
      error: snapshot.error ? describeIpcError(snapshot.error) : null,
      ...extra
    })
  }

  private beginAction(action: ChannelMemberPanelAction): boolean {
    if (this.disposed) return false
    if (this.state.busy) {
      this.patch({ error: 'Finish the current Channel action first.' })
      return false
    }
    this.patch({ busy: action, error: null, notice: null })
    return true
  }

  private finishAction(notice: string): void {
    this.patch({ busy: null, notice, error: null })
  }

  private finishSynchronizedAction(notice: string): void {
    this.patch({ busy: null, notice, ...(this.state.error ? {} : { error: null }) })
  }

  private failAction(error: ChannelMemberIpcError): false {
    this.patch({ busy: null, notice: null, error: describeIpcError(error) })
    return false
  }

  private failThrown(error: unknown): false {
    this.patch({ busy: null, notice: null, error: describeThrown(error) })
    return false
  }

  private requirePostableChannel(): boolean {
    if (!this.state.channel) {
      this.patch({ error: 'Choose and reconnect a saved Channel membership first.' })
      return false
    }
    if (this.state.channel.status === 'revoked' || this.state.phase === 'revoked') {
      this.patch({ error: 'This membership was revoked. Its saved history remains read-only.' })
      return false
    }
    if (this.state.phase === 'recovery_blocked') {
      this.patch({ error: 'Repair this Mac’s local Channel history before reconnecting.' })
      return false
    }
    if (!this.state.connected || this.state.phase !== 'connected') {
      this.patch({ error: 'Reconnect to the Channel before posting or syncing.' })
      return false
    }
    return true
  }

  private enqueueSync(reset: boolean): Promise<boolean> {
    const next = this.syncTail.then(() => this.sync(reset))
    this.syncTail = next.catch(() => false)
    return next
  }

  private async sync(reset: boolean): Promise<boolean> {
    if (this.disposed) return false
    try {
      const [listed, current] = await Promise.all([
        this.options.api.list(),
        this.options.api.snapshot()
      ])
      if (this.disposed) return false

      const patch: Partial<ChannelMemberPanelState> = { loading: false }
      let error: string | null = null
      if (listed.ok) patch.memberships = listed.value
      else error = describeIpcError(listed.error)

      if (current.ok) {
        const snapshot = current.value
        patch.phase = snapshot.phase
        patch.connected = snapshot.connected
        patch.channel = snapshot.channel
        patch.members = snapshot.members
        patch.records = snapshot.records
        patch.highWaterSequence = snapshot.highWaterSequence
        if (snapshot.phase !== 'awaiting_sas') patch.confirmCode = null
        if (snapshot.error) error = describeIpcError(snapshot.error)
      } else {
        error ||= describeIpcError(current.error)
      }
      patch.error = error
      if (reset && current.ok && !current.value.channel) patch.notice = null
      this.patch(patch)
      return listed.ok && current.ok
    } catch (error) {
      this.patch({ loading: false, error: describeThrown(error) })
      return false
    }
  }
}

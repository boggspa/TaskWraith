import type { AgenticServiceId, ProviderId } from './store/types'

export type RunSessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'
export type TerminalRunSessionStatus = Extract<
  RunSessionStatus,
  'completed' | 'failed' | 'cancelled'
>

export interface KillableProcess {
  pid?: number
  kill(signal?: unknown): unknown
}

export interface AbortableController {
  abort(reason?: unknown): unknown
}

export interface LiveSteerTransport {
  sendSteer(text: string, hooks?: LiveSteerDeliveryHooks): boolean
  cancel(): void
  /** Optional consume seam for broker transports. Draining is delivery evidence. */
  drain?(): string | null
}

export interface LiveSteerDeliveryHooks {
  /** Registry identity of the exact durable transcript entry being delivered. */
  entryId: string
  /** The provider transport accepted the steering text into its live context. */
  onDelivered: () => void
}

export interface RunSession<TState = unknown> {
  runId: string
  provider: ProviderId
  appChatId?: string
  workspacePath?: string
  providerSessionId?: string
  providerRunId?: string
  sender?: unknown
  process?: KillableProcess
  abortController?: AbortableController
  state?: TState
  status: RunSessionStatus
  startedAt: number
  updatedAt: number
  approvalIds: Set<string>
  sessionGrants: Set<string>
  /** Strategy B: pending steering text for broker-injection at next tool boundary. */
  pendingSteerText?: string | null
  /** Live steering transport (Pi frame, broker injection). */
  liveSteerTransport?: LiveSteerTransport
  /** Strategy A/C: cooperative interrupt requested at. */
  interruptRequestedAt?: number
  /** Strategy C: kill after next tool_result boundary. */
  killAfterToolResult?: boolean
}

export interface CreateRunSessionInput<TState = unknown> {
  runId: string
  provider: ProviderId
  appChatId?: string
  workspacePath?: string
  providerSessionId?: string
  providerRunId?: string
  sender?: unknown
  process?: KillableProcess
  abortController?: AbortableController
  state?: TState
  status?: RunSessionStatus
}

export interface RunSessionChangeEvent<TState = unknown> {
  type: 'created' | 'updated' | 'removed'
  session: RunSession<TState>
}

export interface RunRoute {
  appRunId?: string
  appChatId?: string
}

export interface RunTerminalJoinState {
  readonly required: boolean
  readonly requiredAt?: number
  readonly firstSignalAt?: number
  readonly lifecycleStatus?: TerminalRunSessionStatus
  readonly providerStatus?: TerminalRunSessionStatus
  readonly conflict: boolean
}

function providerSessionKey(provider: ProviderId, providerSessionId: string): string {
  return `${provider}:${providerSessionId}`
}

function sessionGrantKey(
  provider: ProviderId,
  workspacePath: string | undefined,
  service: AgenticServiceId,
  surfaceId?: string
): string {
  const base = `${provider}:${service}:${workspacePath || 'global'}`
  // Surface-scoped services (canvasInteraction) bind the grant to the exact
  // surface the user approved. PermissionService decides which services those
  // are and refuses to mint an unscoped one; this only has to key it. NB the
  // run-attached grant is the path that actually fires while a run is live —
  // PermissionService.addSessionGrant delegates here and returns, so scoping the
  // process-global key alone would have left the common case wide open.
  return surfaceId ? `${base}:${surfaceId}` : base
}

export function isTerminalRunSessionStatus(
  status: RunSessionStatus | undefined
): status is TerminalRunSessionStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function isActiveRunSessionStatus(status: RunSessionStatus): boolean {
  return status === 'starting' || status === 'running'
}

export function canStartRunTransport(
  status: RunSessionStatus | undefined,
  requireExistingRun = false
): boolean {
  if (status === undefined) return !requireExistingRun
  return isActiveRunSessionStatus(status)
}

export class RunManager<TState = unknown> {
  private sessionsByRunId = new Map<string, RunSession<TState>>()
  private runIdsByProvider = new Map<ProviderId, Set<string>>()
  private runIdByProviderSession = new Map<string, string>()
  private approvalIdToRunId = new Map<string, string>()
  private terminalStatusClaims = new Map<
    string,
    Extract<RunSessionStatus, 'failed' | 'cancelled'>
  >()
  private terminalStatusConfirmationsRequired = new Set<string>()
  private pendingTerminalStatuses = new Map<string, TerminalRunSessionStatus>()
  private confirmedTerminalStatuses = new Map<string, TerminalRunSessionStatus>()
  private terminalStatusConfirmationRequiredAt = new Map<string, number>()
  private terminalStatusFirstSignalAt = new Map<string, number>()
  private terminalStatusConflicts = new Set<string>()
  private listeners = new Set<(event: RunSessionChangeEvent<TState>) => void>()

  onChange(listener: (event: RunSessionChangeEvent<TState>) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  create(input: CreateRunSessionInput<TState>): RunSession<TState> {
    const existing = this.sessionsByRunId.get(input.runId)
    if (existing) {
      throw new Error(`Run session already exists: ${input.runId}`)
    }

    const now = Date.now()
    const session: RunSession<TState> = {
      runId: input.runId,
      provider: input.provider,
      appChatId: input.appChatId,
      workspacePath: input.workspacePath,
      providerSessionId: input.providerSessionId,
      providerRunId: input.providerRunId,
      sender: input.sender,
      process: input.process,
      abortController: input.abortController,
      state: input.state,
      status: input.status || 'starting',
      startedAt: now,
      updatedAt: now,
      approvalIds: new Set(),
      sessionGrants: new Set()
    }

    this.sessionsByRunId.set(session.runId, session)
    this.indexProviderRun(session.provider, session.runId)
    this.indexProviderSession(session)
    this.emit({ type: 'created', session })
    return session
  }

  get(runId?: string | null): RunSession<TState> | undefined {
    return runId ? this.sessionsByRunId.get(runId) : undefined
  }

  /**
   * Final launch fence for an exact run identity. Active status alone is not
   * sufficient: execution-graph cancellation records a terminal claim while
   * retaining the starting/running session until provider close evidence
   * joins. No new transport may cross that claimed-terminal boundary.
   */
  canAdmitTransport(runId: string | undefined, requireExistingRun = false): boolean {
    if (runId && this.terminalStatusClaims.has(runId)) return false
    return canStartRunTransport(this.get(runId)?.status, requireExistingRun)
  }

  getByProvider(provider: ProviderId): RunSession<TState>[] {
    return [...(this.runIdsByProvider.get(provider) || [])]
      .map((runId) => this.sessionsByRunId.get(runId))
      .filter((session): session is RunSession<TState> => Boolean(session))
  }

  getActiveByProvider(provider: ProviderId): RunSession<TState>[] {
    return this.getByProvider(provider).filter((session) => isActiveRunSessionStatus(session.status))
  }

  getLatestByProvider(provider: ProviderId): RunSession<TState> | undefined {
    const sessions = this.getActiveByProvider(provider)
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  getByProviderSession(
    provider: ProviderId,
    providerSessionId?: string | null
  ): RunSession<TState> | undefined {
    if (!providerSessionId) return undefined
    return this.get(
      this.runIdByProviderSession.get(providerSessionKey(provider, providerSessionId))
    )
  }

  getActiveByProviderSession(
    provider: ProviderId,
    providerSessionId?: string | null
  ): RunSession<TState> | undefined {
    const session = this.getByProviderSession(provider, providerSessionId)
    return session && isActiveRunSessionStatus(session.status) ? session : undefined
  }

  resolve(provider: ProviderId, route?: RunRoute | null): RunSession<TState> | undefined {
    const byRunId = this.get(route?.appRunId)
    if (byRunId && byRunId.provider === provider) return byRunId
    if (route?.appRunId) return undefined

    if (route?.appChatId) {
      const activeChatSessions = this.getActiveByProvider(provider)
        .filter((session) => session.appChatId === route.appChatId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      if (activeChatSessions[0]) return activeChatSessions[0]
      return undefined
    }

    const activeProviderSessions = this.getActiveByProvider(provider)
    if (activeProviderSessions.length === 0) return undefined
    if (activeProviderSessions.length === 1) return activeProviderSessions[0]
    return undefined
  }

  update(
    runId: string,
    partial: Partial<Omit<RunSession<TState>, 'runId' | 'approvalIds' | 'sessionGrants'>>
  ): RunSession<TState> | undefined {
    const session = this.sessionsByRunId.get(runId)
    if (!session) return undefined
    // An app-run id represents one lifecycle. Provider fallbacks are transport
    // attempts within that lifecycle; once the app run is terminal, late
    // callbacks must not revive it or replace its ownership metadata.
    if (isTerminalRunSessionStatus(session.status)) return session

    const previousProviderSessionId = session.providerSessionId
    Object.assign(session, partial, { updatedAt: Date.now() })
    if (
      partial.providerSessionId !== undefined &&
      partial.providerSessionId !== previousProviderSessionId
    ) {
      if (previousProviderSessionId) {
        this.runIdByProviderSession.delete(
          providerSessionKey(session.provider, previousProviderSessionId)
        )
      }
      this.indexProviderSession(session)
    }
    this.emit({ type: 'updated', session })
    return session
  }

  setState(runId: string, state: TState): RunSession<TState> | undefined {
    return this.update(runId, { state })
  }

  attachProcess(runId: string, process: KillableProcess): RunSession<TState> | undefined {
    const session = this.sessionsByRunId.get(runId)
    if (
      session &&
      (isTerminalRunSessionStatus(session.status) || this.terminalStatusClaims.has(runId))
    ) {
      try {
        process.kill()
      } catch {
        // The terminal claim remains authoritative even if the late process
        // already exited.
      }
      return session
    }
    return this.update(runId, { process, status: 'running' })
  }

  attachAbortController(
    runId: string,
    abortController: AbortableController
  ): RunSession<TState> | undefined {
    const session = this.sessionsByRunId.get(runId)
    if (
      session &&
      (isTerminalRunSessionStatus(session.status) || this.terminalStatusClaims.has(runId))
    ) {
      try {
        abortController.abort()
      } catch {
        // The terminal claim remains authoritative even if the controller was
        // already disposed.
      }
      return session
    }
    return this.update(runId, { abortController, status: 'running' })
  }

  registerProviderSession(
    runId: string,
    providerSessionId: string
  ): RunSession<TState> | undefined {
    return this.update(runId, { providerSessionId })
  }

  registerProviderRun(runId: string, providerRunId: string): RunSession<TState> | undefined {
    return this.update(runId, { providerRunId })
  }

  registerApproval(runId: string | undefined, approvalId: string): void {
    if (!runId || !approvalId) return
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return
    session.approvalIds.add(approvalId)
    this.approvalIdToRunId.set(approvalId, runId)
  }

  resolveApproval(approvalId: string): RunSession<TState> | undefined {
    return this.get(this.approvalIdToRunId.get(approvalId))
  }

  clearApproval(approvalId: string): void {
    const runId = this.approvalIdToRunId.get(approvalId)
    if (runId) {
      this.sessionsByRunId.get(runId)?.approvalIds.delete(approvalId)
    }
    this.approvalIdToRunId.delete(approvalId)
  }

  addSessionGrant(
    runId: string | undefined,
    service: AgenticServiceId,
    surfaceId?: string
  ): void {
    if (!runId) return
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return
    session.sessionGrants.add(
      sessionGrantKey(session.provider, session.workspacePath, service, surfaceId)
    )
  }

  hasSessionGrant(
    runId: string | undefined,
    service: AgenticServiceId,
    surfaceId?: string
  ): boolean {
    const session = this.get(runId)
    if (!session) return false
    return session.sessionGrants.has(
      sessionGrantKey(session.provider, session.workspacePath, service, surfaceId)
    )
  }

  /**
   * Reserve the first terminal meaning before abort/kill can synchronously emit
   * a competing provider exit. The session keeps its transport handles until
   * `finish`, so callers can still stop the exact process/controller.
   */
  claimTerminalStatus(
    runId: string,
    status: Extract<RunSessionStatus, 'failed' | 'cancelled'>,
    options: { requireConfirmation?: boolean } = {}
  ): RunSession<TState> | undefined {
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return undefined
    const existing = this.terminalStatusClaims.get(runId)
    if (existing && existing !== status) return undefined
    this.terminalStatusClaims.set(runId, status)
    if (options.requireConfirmation) this.markTerminalConfirmationRequired(runId)
    return session
  }

  getClaimedTerminalStatus(
    runId: string | undefined
  ): Extract<RunSessionStatus, 'failed' | 'cancelled'> | undefined {
    return runId ? this.terminalStatusClaims.get(runId) : undefined
  }

  requireTerminalConfirmation(runId: string): RunSession<TState> | undefined {
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return undefined
    this.markTerminalConfirmationRequired(runId)
    return session
  }

  getTerminalJoinState(runId: string | undefined): RunTerminalJoinState {
    if (!runId) return { required: false, conflict: false }
    const required = this.terminalStatusConfirmationsRequired.has(runId)
    const lifecycleStatus = this.pendingTerminalStatuses.get(runId)
    const providerStatus = this.confirmedTerminalStatuses.get(runId)
    const firstSignalAt = this.terminalStatusFirstSignalAt.get(runId)
    return {
      required,
      ...(required ? { requiredAt: this.terminalStatusConfirmationRequiredAt.get(runId) } : {}),
      ...(firstSignalAt !== undefined ? { firstSignalAt } : {}),
      ...(isTerminalRunSessionStatus(lifecycleStatus) ? { lifecycleStatus } : {}),
      ...(isTerminalRunSessionStatus(providerStatus) ? { providerStatus } : {}),
      conflict: this.terminalStatusConflicts.has(runId)
    }
  }

  confirmTerminalStatus(
    runId: string | undefined,
    status: Extract<RunSessionStatus, 'completed' | 'failed' | 'cancelled'>
  ): RunSession<TState> | undefined {
    if (!runId || !this.terminalStatusConfirmationsRequired.has(runId)) return undefined
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return undefined
    this.markTerminalJoinSignal(runId)
    const effectiveStatus = this.terminalStatusClaims.get(runId) ?? status
    const existing = this.confirmedTerminalStatuses.get(runId)
    if (existing && existing !== effectiveStatus) {
      this.terminalStatusConflicts.add(runId)
      return session
    }
    if (!existing) this.confirmedTerminalStatuses.set(runId, effectiveStatus)
    const pending = this.pendingTerminalStatuses.get(runId)
    if (!pending) return session
    if (pending !== effectiveStatus) {
      this.terminalStatusConflicts.add(runId)
      return session
    }
    this.clearTerminalJoin(runId)
    return this.finish(runId, pending)
  }

  confirmClaimedTerminalStatus(runId: string | undefined): RunSession<TState> | undefined {
    if (!runId) return undefined
    const claim = this.terminalStatusClaims.get(runId)
    return claim ? this.confirmTerminalStatus(runId, claim) : undefined
  }

  finish(runId: string | undefined, status: RunSessionStatus): RunSession<TState> | undefined {
    if (!runId) return undefined
    const session = this.sessionsByRunId.get(runId)
    const claimedTerminalStatus = this.terminalStatusClaims.get(runId)
    const effectiveStatus =
      isTerminalRunSessionStatus(status) && claimedTerminalStatus
        ? claimedTerminalStatus
        : status
    if (
      session &&
      isTerminalRunSessionStatus(effectiveStatus) &&
      this.terminalStatusConfirmationsRequired.has(runId)
    ) {
      this.markTerminalJoinSignal(runId)
      const pending = this.pendingTerminalStatuses.get(runId)
      if (!pending) {
        this.pendingTerminalStatuses.set(runId, effectiveStatus)
      } else if (pending !== effectiveStatus) {
        this.terminalStatusConflicts.add(runId)
      }
      const firstPending = this.pendingTerminalStatuses.get(runId)!
      const confirmed = this.confirmedTerminalStatuses.get(runId)
      if (confirmed && confirmed !== firstPending) {
        this.terminalStatusConflicts.add(runId)
      }
      if (this.terminalStatusConflicts.has(runId) || confirmed !== firstPending) return session
      this.clearTerminalJoin(runId)
      return this.finish(runId, firstPending)
    }
    if (
      session &&
      isTerminalRunSessionStatus(session.status) &&
      isTerminalRunSessionStatus(effectiveStatus)
    ) {
      return session
    }
    if (session && isTerminalRunSessionStatus(effectiveStatus)) {
      for (const approvalId of session.approvalIds) {
        this.approvalIdToRunId.delete(approvalId)
      }
      session.approvalIds.clear()
      session.sessionGrants.clear()
      // Clear steering state — never leak pendingSteer or interrupt flags past terminalization.
      if (session.liveSteerTransport?.cancel) {
        try {
          session.liveSteerTransport.cancel()
        } catch {
          // Transport cleanup is best-effort during terminalization.
        }
      }
      session.liveSteerTransport = undefined
      session.pendingSteerText = undefined
      session.interruptRequestedAt = undefined
      session.killAfterToolResult = undefined
      this.terminalStatusClaims.delete(runId)
      this.clearTerminalJoin(runId)
    }
    return this.update(runId, {
      status: effectiveStatus,
      process: undefined,
      abortController: undefined
    })
  }

  /**
   * Fail closed after the owner has durably recorded why a required terminal
   * join conflicted or timed out. This deliberately discards any cancellation
   * claim: containment is an infrastructure failure, not provider
   * acknowledgement that cancellation completed.
   */
  containTerminalJoin(
    runId: string | undefined,
    status: Extract<RunSessionStatus, 'failed' | 'cancelled'> = 'failed'
  ): RunSession<TState> | undefined {
    if (!runId || !this.terminalStatusConfirmationsRequired.has(runId)) return undefined
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return undefined
    this.terminalStatusClaims.delete(runId)
    this.clearTerminalJoin(runId)
    return this.finish(runId, status)
  }

  remove(runId: string): void {
    const session = this.sessionsByRunId.get(runId)
    if (!session) return

    this.sessionsByRunId.delete(runId)
    this.terminalStatusClaims.delete(runId)
    this.clearTerminalJoin(runId)
    if (session.liveSteerTransport?.cancel) {
      try {
        session.liveSteerTransport.cancel()
      } catch {
        // Transport cleanup is best-effort during removal.
      }
    }
    this.runIdsByProvider.get(session.provider)?.delete(runId)
    if (session.providerSessionId) {
      this.runIdByProviderSession.delete(
        providerSessionKey(session.provider, session.providerSessionId)
      )
    }
    for (const approvalId of session.approvalIds) {
      this.approvalIdToRunId.delete(approvalId)
    }
    this.emit({ type: 'removed', session })
  }

  cancel(runId: string): boolean {
    const session = this.sessionsByRunId.get(runId)
    if (!session) return false
    session.abortController?.abort()
    session.process?.kill()
    if (session.liveSteerTransport?.cancel) {
      try {
        session.liveSteerTransport.cancel()
      } catch {
        // Transport cleanup is best-effort during cancellation.
      }
    }
    session.liveSteerTransport = undefined
    session.pendingSteerText = undefined
    session.interruptRequestedAt = undefined
    session.killAfterToolResult = undefined
    this.finish(runId, 'cancelled')
    return true
  }

  // ----- Steering interrupt hooks (SteeringOrchestrator) -----

  requestInterrupt(runId: string): boolean {
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return false
    session.interruptRequestedAt = Date.now()
    session.updatedAt = Date.now()
    this.emit({ type: 'updated', session })
    return true
  }

  armKillAfterToolResult(runId: string): boolean {
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return false
    session.killAfterToolResult = true
    session.interruptRequestedAt = Date.now()
    session.updatedAt = Date.now()
    this.emit({ type: 'updated', session })
    return true
  }

  getInterruptState(runId: string): { interruptRequestedAt?: number; killAfterToolResult?: boolean } {
    const session = this.sessionsByRunId.get(runId)
    if (!session) return {}
    return {
      interruptRequestedAt: session.interruptRequestedAt,
      killAfterToolResult: session.killAfterToolResult
    }
  }

  /**
   * Register a transport-specific live-steer handle (ACP `steer()`, broker
   * injection) against an active session. The orchestrator owns the routing
   * decision; RunManager only stores the handle and cancels/clears it on
   * finish/remove/cancel. Registering over an existing handle cancels the old
   * one so two transports can never race the same run.
   */
  registerLiveSteerTransport(runId: string, transport: LiveSteerTransport): boolean {
    const session = this.sessionsByRunId.get(runId)
    if (!session || !isActiveRunSessionStatus(session.status)) return false
    if (session.liveSteerTransport && session.liveSteerTransport !== transport) {
      try {
        session.liveSteerTransport.cancel()
      } catch {
        // Replacing an obsolete transport remains best-effort.
      }
    }
    session.liveSteerTransport = transport
    session.updatedAt = Date.now()
    this.emit({ type: 'updated', session })
    return true
  }

  unregisterLiveSteerTransport(runId: string): void {
    const session = this.sessionsByRunId.get(runId)
    if (!session) return
    if (session.liveSteerTransport?.cancel) {
      try {
        session.liveSteerTransport.cancel()
      } catch {
        // Transport cleanup is best-effort during unregister.
      }
    }
    session.liveSteerTransport = undefined
    session.pendingSteerText = undefined
    session.interruptRequestedAt = undefined
    session.killAfterToolResult = undefined
    session.updatedAt = Date.now()
    this.emit({ type: 'updated', session })
  }

  clear(): void {
    this.sessionsByRunId.clear()
    this.runIdsByProvider.clear()
    this.runIdByProviderSession.clear()
    this.approvalIdToRunId.clear()
    this.terminalStatusClaims.clear()
    this.terminalStatusConfirmationsRequired.clear()
    this.pendingTerminalStatuses.clear()
    this.confirmedTerminalStatuses.clear()
    this.terminalStatusConfirmationRequiredAt.clear()
    this.terminalStatusFirstSignalAt.clear()
    this.terminalStatusConflicts.clear()
  }

  private emit(event: RunSessionChangeEvent<TState>): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private markTerminalConfirmationRequired(runId: string): void {
    this.terminalStatusConfirmationsRequired.add(runId)
    if (!this.terminalStatusConfirmationRequiredAt.has(runId)) {
      this.terminalStatusConfirmationRequiredAt.set(runId, Date.now())
    }
  }

  private markTerminalJoinSignal(runId: string): void {
    if (!this.terminalStatusFirstSignalAt.has(runId)) {
      this.terminalStatusFirstSignalAt.set(runId, Date.now())
    }
  }

  private clearTerminalJoin(runId: string): void {
    this.terminalStatusConfirmationsRequired.delete(runId)
    this.pendingTerminalStatuses.delete(runId)
    this.confirmedTerminalStatuses.delete(runId)
    this.terminalStatusConfirmationRequiredAt.delete(runId)
    this.terminalStatusFirstSignalAt.delete(runId)
    this.terminalStatusConflicts.delete(runId)
  }

  private indexProviderRun(provider: ProviderId, runId: string): void {
    const runIds = this.runIdsByProvider.get(provider) || new Set<string>()
    runIds.add(runId)
    this.runIdsByProvider.set(provider, runIds)
  }

  private indexProviderSession(session: RunSession<TState>): void {
    if (session.providerSessionId) {
      this.runIdByProviderSession.set(
        providerSessionKey(session.provider, session.providerSessionId),
        session.runId
      )
    }
  }
}

import type { AgenticServiceId, ProviderId } from './store/types'

export type RunSessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface KillableProcess {
  kill(signal?: unknown): unknown
}

export interface AbortableController {
  abort(reason?: unknown): unknown
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

function providerSessionKey(provider: ProviderId, providerSessionId: string): string {
  return `${provider}:${providerSessionId}`
}

function sessionGrantKey(
  provider: ProviderId,
  workspacePath: string | undefined,
  service: AgenticServiceId
): string {
  return `${provider}:${service}:${workspacePath || 'global'}`
}

export function isTerminalRunSessionStatus(status: RunSessionStatus): boolean {
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
  private terminalStatusClaims = new Map<string, RunSessionStatus>()
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
    if (session && isTerminalRunSessionStatus(session.status)) {
      try {
        process.kill()
      } catch {
        // The run remains terminal even if the late process already exited.
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
    if (session && isTerminalRunSessionStatus(session.status)) {
      try {
        abortController.abort()
      } catch {
        // The run remains terminal even if the controller was already disposed.
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

  addSessionGrant(runId: string | undefined, service: AgenticServiceId): void {
    if (!runId) return
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return
    session.sessionGrants.add(sessionGrantKey(session.provider, session.workspacePath, service))
  }

  hasSessionGrant(runId: string | undefined, service: AgenticServiceId): boolean {
    const session = this.get(runId)
    if (!session) return false
    return session.sessionGrants.has(
      sessionGrantKey(session.provider, session.workspacePath, service)
    )
  }

  /**
   * Reserve the first terminal meaning before abort/kill can synchronously emit
   * a competing provider exit. The session keeps its transport handles until
   * `finish`, so callers can still stop the exact process/controller.
   */
  claimTerminalStatus(
    runId: string,
    status: Extract<RunSessionStatus, 'failed' | 'cancelled'>
  ): RunSession<TState> | undefined {
    const session = this.sessionsByRunId.get(runId)
    if (!session || isTerminalRunSessionStatus(session.status)) return undefined
    const existing = this.terminalStatusClaims.get(runId)
    if (existing && existing !== status) return undefined
    this.terminalStatusClaims.set(runId, status)
    return session
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
      this.terminalStatusClaims.delete(runId)
    }
    return this.update(runId, {
      status: effectiveStatus,
      process: undefined,
      abortController: undefined
    })
  }

  remove(runId: string): void {
    const session = this.sessionsByRunId.get(runId)
    if (!session) return

    this.sessionsByRunId.delete(runId)
    this.terminalStatusClaims.delete(runId)
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
    this.finish(runId, 'cancelled')
    return true
  }

  clear(): void {
    this.sessionsByRunId.clear()
    this.runIdsByProvider.clear()
    this.runIdByProviderSession.clear()
    this.approvalIdToRunId.clear()
    this.terminalStatusClaims.clear()
  }

  private emit(event: RunSessionChangeEvent<TState>): void {
    for (const listener of this.listeners) {
      listener(event)
    }
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

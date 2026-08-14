import { resolve as resolvePath } from 'path'

export const DEFAULT_HOST_COMMAND_KILL_GRACE_MS = 4_000

export interface HostCommandOperationIdentityInput {
  operationId: string
  appRunId: string | null | undefined
  appChatId: string | null | undefined
  workspaceId: string | null | undefined
  workspacePath: string | null | undefined
}

export interface HostCommandOperationIdentity {
  readonly operationId: string
  readonly appRunId?: string
  readonly appChatId?: string
  readonly workspaceId?: string
  readonly workspacePath?: string
}

/**
 * Minimal child surface used by host-command lifecycle tracking. Callers may
 * wrap `kill` to signal a detached process group rather than only its leader.
 */
export interface HostCommandChildHandle {
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean
  /** Exact process-tree death join, invoked only after the root emits close. */
  joinProcessTreeAfterClose?: () => Promise<void>
}

export type HostCommandTransportState = 'awaiting-child' | 'attached' | 'closed' | 'no-child'

export interface HostCommandOperationController {
  readonly identity: HostCommandOperationIdentity
  readonly operationId: string
  readonly completion: Promise<void>
  readonly transportState: HostCommandTransportState
  readonly terminalProjectionComplete: boolean
  readonly processTreeQuiescenceProven: boolean
  readonly settled: boolean
  readonly cancelled: boolean
  readonly cancellationReason?: string

  /**
   * Attach the one exact spawned child. The close listener is installed before
   * a previously-requested cancellation is delivered. Returns false when the
   * operation had already been cancelled, so admission remains fail closed.
   */
  attachChild(child: HostCommandChildHandle): boolean

  /** Exact close evidence; normally invoked by the listener installed above. */
  markTransportClosed(): void

  /** Explicit proof that the admission path returned without spawning. */
  markNoChild(): void

  /** Mark every caller-owned result/transcript projection complete. */
  markTerminalProjectionComplete(): void

  /** Request TERM followed by a bounded KILL backstop. Idempotent. */
  cancel(reason?: string): void
}

/**
 * Opaque route adapter used by provider/audit runtimes that own the terminal
 * result projection outside the command executor itself.
 */
export interface HostCommandProjectionHandle {
  run<T>(operation: () => Promise<T>): Promise<T>
  complete(): void
}

export type HostCommandOperationScope =
  | Readonly<{ kind: 'run'; appRunId: string }>
  | Readonly<{ kind: 'chat'; chatIds: readonly string[] }>
  | Readonly<{
      kind: 'workspace'
      workspaceId?: string | null
      /** Resolve()-normalized on both sides; symlinked twins still miss. */
      workspacePath?: string | null
      /** Frozen deletion preview used when older operations lack workspace metadata. */
      chatIds?: readonly string[]
    }>
  | Readonly<{ kind: 'global' }>

/**
 * Exact process-local history join. The operation ids are audit/debug metadata;
 * `completion` retains the selected controller objects themselves so map
 * removal cannot turn a settled-then-reused identity into false close evidence.
 */
export interface HostCommandOperationCancellation {
  readonly scope: HostCommandOperationScope
  readonly operationIds: readonly string[]
  readonly completion: Promise<void>
  readonly processTreeStopped: Promise<boolean>
}

export interface HostCommandOperationOptions {
  killGraceMs?: number
}

function exactId(value: string | null | undefined, label: string): string | undefined {
  if (value == null) return undefined
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must be an exact non-empty value when provided.`)
  return normalized
}

function exactPath(value: string | null | undefined): string | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Host command workspace path must be an exact non-empty value when provided.')
  }
  // Normalize both registration identities and cancellation scopes through the
  // same deterministic resolver so a stored raw workspace path (trailing
  // slash, `.`/`..` segments) still matches its resolve()'d identity twin.
  // Symlinks are deliberately not chased — no fs access here.
  return resolvePath(trimmed)
}

function normalizeIdentity(input: HostCommandOperationIdentityInput): HostCommandOperationIdentity {
  const operationId = exactId(input.operationId, 'Host command operation id')
  if (!operationId) throw new Error('Host command operation requires an exact operation id.')
  const appRunId = exactId(input.appRunId, 'Host command app run id')
  const appChatId = exactId(input.appChatId, 'Host command app chat id')
  const workspaceId = exactId(input.workspaceId, 'Host command workspace id')
  const workspacePath = exactPath(input.workspacePath)
  return Object.freeze({
    operationId,
    ...(appRunId ? { appRunId } : {}),
    ...(appChatId ? { appChatId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspacePath ? { workspacePath } : {})
  })
}

function normalizeChatIds(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    [...new Set((values || []).map((value) => exactId(value, 'Host command chat id')!))].sort()
  )
}

function normalizeScope(scope: HostCommandOperationScope): HostCommandOperationScope {
  if (scope.kind === 'global') return Object.freeze({ kind: 'global' })
  if (scope.kind === 'run') {
    const appRunId = exactId(scope.appRunId, 'Host command run scope id')
    if (!appRunId) throw new Error('Host command run scope requires an exact run id.')
    return Object.freeze({ kind: 'run', appRunId })
  }
  const chatIds = normalizeChatIds(scope.chatIds)
  if (scope.kind === 'chat') return Object.freeze({ kind: 'chat', chatIds })

  const workspaceId = exactId(scope.workspaceId, 'Host command workspace scope id')
  const workspacePath = exactPath(scope.workspacePath)
  if (!workspaceId && !workspacePath && chatIds.length === 0) {
    throw new Error(
      'Host command workspace scope requires a workspace id, workspace path, or frozen chat ids.'
    )
  }
  return Object.freeze({
    kind: 'workspace',
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(chatIds.length > 0 ? { chatIds } : {})
  })
}

function scopeMatches(
  scope: HostCommandOperationScope,
  identity: HostCommandOperationIdentity
): boolean {
  if (scope.kind === 'global') return true
  if (scope.kind === 'run') return identity.appRunId === scope.appRunId
  if (scope.kind === 'chat') {
    return Boolean(identity.appChatId && scope.chatIds.includes(identity.appChatId))
  }
  if (scope.workspaceId && identity.workspaceId) {
    if (identity.workspaceId === scope.workspaceId) return true
    // Two persisted workspace identities may point at the same checkout. An
    // exact id mismatch outranks raw path equality; only the frozen chat
    // deletion preview below may prove this operation still belongs in scope.
    return Boolean(identity.appChatId && scope.chatIds?.includes(identity.appChatId))
  }
  if (scope.workspacePath && identity.workspacePath === scope.workspacePath) return true
  return Boolean(identity.appChatId && scope.chatIds?.includes(identity.appChatId))
}

function normalizedKillGraceMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HOST_COMMAND_KILL_GRACE_MS
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Host command kill grace must be a finite non-negative duration.')
  }
  return Math.floor(value)
}

class HostCommandOperationControllerImpl implements HostCommandOperationController {
  readonly identity: HostCommandOperationIdentity
  readonly operationId: string
  readonly completion: Promise<void>

  private readonly killGraceMs: number
  private resolveCompletion!: () => void
  private child: HostCommandChildHandle | undefined
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private _transportState: HostCommandTransportState = 'awaiting-child'
  private _terminalProjectionComplete = false
  private _processTreeQuiescenceProven = false
  private _settled = false
  private _cancelled = false
  private _cancellationReason: string | undefined
  private terminationRequested = false

  constructor(identity: HostCommandOperationIdentity, options: HostCommandOperationOptions) {
    this.identity = identity
    this.operationId = identity.operationId
    this.killGraceMs = normalizedKillGraceMs(options.killGraceMs)
    this.completion = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve
    })
  }

  get transportState(): HostCommandTransportState {
    return this._transportState
  }

  get terminalProjectionComplete(): boolean {
    return this._terminalProjectionComplete
  }

  get processTreeQuiescenceProven(): boolean {
    return this._processTreeQuiescenceProven
  }

  get settled(): boolean {
    return this._settled
  }

  get cancelled(): boolean {
    return this._cancelled
  }

  get cancellationReason(): string | undefined {
    return this._cancellationReason
  }

  attachChild(child: HostCommandChildHandle): boolean {
    if (this._transportState !== 'awaiting-child') {
      throw new Error(
        `Host command operation ${this.operationId} cannot attach a child from ${this._transportState}.`
      )
    }
    this.child = child
    this._transportState = 'attached'
    try {
      child.once('close', () => {
        if (!child.joinProcessTreeAfterClose) {
          this.markTransportClosed()
          return
        }
        void Promise.resolve()
          .then(() => child.joinProcessTreeAfterClose?.())
          .then(() => {
            this._processTreeQuiescenceProven = true
            this.markTransportClosed()
          })
          .catch(() => {
            // Missing process-tree death evidence retains the operation. The
            // workspace-lock watchdog will keep mutation admission fail closed.
          })
      })
    } catch (error) {
      // A broken adapter cannot become an untracked admitted child. Preserve
      // the attached/pending state and still honor a cancellation request; the
      // caller may provide explicit actual-close evidence through the public
      // marker, but no error/exit/kill acknowledgement settles this operation.
      if (this._cancelled) this.requestTermination()
      throw error
    }
    if (this._cancelled) this.requestTermination()
    return !this._cancelled
  }

  markTransportClosed(): void {
    if (this._transportState === 'closed') return
    if (this._transportState !== 'attached') {
      throw new Error(
        `Host command operation ${this.operationId} has no attached child to mark closed.`
      )
    }
    this.clearKillTimer()
    this._transportState = 'closed'
    this.maybeSettle()
  }

  markNoChild(): void {
    if (this._transportState === 'no-child') return
    if (this._transportState !== 'awaiting-child') {
      throw new Error(
        `Host command operation ${this.operationId} cannot prove no child from ${this._transportState}.`
      )
    }
    this._processTreeQuiescenceProven = true
    this._transportState = 'no-child'
    this.maybeSettle()
  }

  markTerminalProjectionComplete(): void {
    if (this._terminalProjectionComplete) return
    this._terminalProjectionComplete = true
    this.maybeSettle()
  }

  cancel(reason = 'history-deletion'): void {
    if (!this._cancelled) {
      const cancellationReason = exactId(reason, 'Host command cancellation reason')
      if (!cancellationReason) {
        throw new Error('Host command cancellation requires an exact reason.')
      }
      this._cancelled = true
      this._cancellationReason = cancellationReason
    }
    if (this._transportState === 'attached') this.requestTermination()
  }

  private requestTermination(): void {
    if (!this.child || this._transportState !== 'attached' || this.terminationRequested) {
      return
    }
    this.terminationRequested = true
    try {
      this.child.kill('SIGTERM')
    } catch {
      // A signal exception is not close evidence. Preserve the exact join and
      // still arm the force-kill backstop.
    }
    if (this._transportState !== 'attached') return
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined
      if (!this.child || this._transportState !== 'attached') return
      try {
        this.child.kill('SIGKILL')
      } catch {
        // SIGKILL acknowledgement or failure is not close evidence either.
      }
    }, this.killGraceMs)
    this.killTimer.unref?.()
  }

  private clearKillTimer(): void {
    if (!this.killTimer) return
    clearTimeout(this.killTimer)
    this.killTimer = undefined
  }

  private maybeSettle(): void {
    if (
      this._settled ||
      !this._terminalProjectionComplete ||
      (this._transportState !== 'closed' && this._transportState !== 'no-child')
    ) {
      return
    }
    this._settled = true
    this.resolveCompletion()
  }
}

/**
 * Process-local exact lifecycle registry for TaskWraith-owned host commands.
 * It deliberately does not consult RunManager, whose run may already be
 * terminal while a child close or caller-owned result projection remains live.
 *
 * Destructive-history callers must raise their ordinary persistence/admission
 * fence before `beginCancellation`: this method freezes and joins everything
 * already registered in scope, while that outer fence prevents later matching
 * registrations from crossing admission.
 */
export class HostCommandOperationRegistry {
  private readonly operations = new Map<string, HostCommandOperationControllerImpl>()

  register(
    input: HostCommandOperationIdentityInput,
    options: HostCommandOperationOptions = {}
  ): HostCommandOperationController {
    const identity = normalizeIdentity(input)
    if (this.operations.has(identity.operationId)) {
      throw new Error(`Host command operation identity ${identity.operationId} is already active.`)
    }
    const controller = new HostCommandOperationControllerImpl(identity, options)
    // Identity is reserved in the registry before this call returns; the caller
    // may only begin child spawn/admission after receiving the controller.
    this.operations.set(identity.operationId, controller)
    void controller.completion.then(() => {
      if (this.operations.get(identity.operationId) === controller) {
        this.operations.delete(identity.operationId)
      }
    })
    return controller
  }

  get(operationId: string): HostCommandOperationController | undefined {
    const id = exactId(operationId, 'Host command operation id')
    return id ? this.operations.get(id) : undefined
  }

  hasRun(appRunId: string): boolean {
    const id = exactId(appRunId, 'Host command app run id')
    return Boolean(
      id && [...this.operations.values()].some((operation) => operation.identity.appRunId === id)
    )
  }

  beginCancellation(
    requestedScope: HostCommandOperationScope,
    reason = 'history-deletion'
  ): HostCommandOperationCancellation {
    const scope = normalizeScope(requestedScope)
    const selected = [...this.operations.values()].filter((operation) =>
      scopeMatches(scope, operation.identity)
    )
    // Cancellation is delivered synchronously to the exact frozen selection.
    // This catches operations registered before spawn as well as live children.
    for (const operation of selected) operation.cancel(reason)
    const operationIds = Object.freeze(selected.map((operation) => operation.operationId).sort())
    const completion = Promise.all(selected.map((operation) => operation.completion)).then(
      () => undefined
    )
    const processTreeStopped = completion.then(() =>
      selected.every((operation) => operation.processTreeQuiescenceProven)
    )
    return Object.freeze({ scope, operationIds, completion, processTreeStopped })
  }

  beginRunCancellation(
    appRunId: string,
    reason = 'run-terminal'
  ): HostCommandOperationCancellation {
    return this.beginCancellation({ kind: 'run', appRunId }, reason)
  }

  cancelAndJoin(scope: HostCommandOperationScope, reason = 'history-deletion'): Promise<void> {
    return this.beginCancellation(scope, reason).completion
  }

  get size(): number {
    return this.operations.size
  }
}

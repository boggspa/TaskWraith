import type {
  HostAuthorityDecision,
  HostCommand,
  HostHealthProjection,
  HostProviderModelProjection
} from '../shared/hostProtocol'
import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import { validateHostCommandArguments } from '../host-runtime/HostCommandArguments'
import type { HostCommandExecutionResult } from '../host-runtime/HostCommandExecutionResult'
import {
  hostAuthorityCommandActorMatchesContext,
  isExactHostActorIdentity,
  type HostAuthorityCallContext
} from '../host-runtime/HostAuthority'
import { projectHostProfileDomainSnapshot } from '../host-runtime/HostProfileDomainProjection'
import { HostProfileDomainStore } from '../host-runtime/HostProfileDomainStore'
import { HostSetupCommandExecutor } from '../host-runtime/HostSetupCommandExecutor'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'
import {
  HostNodeMuseProvider,
  type HostNodeMuseProviderOptions,
  type HostNodeMuseResourcePort
} from './HostNodeMuseProvider'
import { HostNodeProfileRunPort, type HostNodeRunEventSink } from './HostNodeProfileRunPort'

const MUSE_PROVIDER_ID = 'muse'
const LOCAL_CLIENT_CLASSES = new Set(['desktop', 'tui', 'test'])

export interface HostNodeManualAuthHandoff {
  begin(input: { readonly providerId: string; readonly operationId: string }): void | Promise<void>
  cancel?(input: {
    readonly providerId: string
    readonly operationId: string
  }): boolean | Promise<boolean>
}

export interface HostNodeDomainPortsOptions {
  readonly store: HostProfileDomainStore
  readonly events: HostNodeRunEventSink
  /** Pass a fully constructed provider, or resources from which this class constructs one. */
  readonly museProvider?: HostNodeMuseProvider
  readonly museResources?: HostNodeMuseResourcePort
  readonly museProviderOptions?: Omit<HostNodeMuseProviderOptions, 'runPort' | 'resources'>
  readonly museOffers: HostProviderOffersProjection
  readonly health: () => HostHealthProjection
  readonly providerInventory: () => readonly HostProviderModelProjection[]
  readonly manualAuthHandoff?: HostNodeManualAuthHandoff
  readonly now?: () => number
  /** Lease release must not proceed while a provider child may still be alive. */
  readonly shutdownTimeoutMs?: number
}

type AuthOperation = {
  readonly providerId: string
  readonly operationId: string
  readonly startedAt: string
  cancelled: boolean
}

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- Host identifiers reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function failed(errorCode: string): HostCommandExecutionResult {
  return { status: 'failed', errorCode }
}

function localContext(context: HostAuthorityCallContext, command: HostCommand): boolean {
  return (
    isExactHostActorIdentity(context.actor) &&
    LOCAL_CLIENT_CLASSES.has(context.client.clientClass) &&
    context.actor.clientId === context.client.clientId &&
    context.actor.clientClass === context.client.clientClass &&
    hostAuthorityCommandActorMatchesContext(context, command)
  )
}

function isSetupMutationName(name: HostCommand['name']): boolean {
  return (
    name === 'workspace.register' ||
    name === 'thread.create' ||
    name === 'thread.configure' ||
    name === 'thread.archive' ||
    name === 'provider.auth.begin' ||
    name === 'provider.auth.cancel'
  )
}

/**
 * Standalone Node Host domain ports. No Electron/Bridge/desktop-store imports:
 * profile state, delivery, provider resources, inventory, and auth handoff are
 * all injected at composition time.
 */
export class HostNodeDomainPorts {
  readonly runPort: HostNodeProfileRunPort
  readonly museProvider: HostNodeMuseProvider
  readonly setupExecutor: HostSetupCommandExecutor
  private readonly authOperations = new Map<string, AuthOperation>()
  private readonly runCompletions = new Map<string, Promise<void>>()
  private readonly now: () => number
  private shutdownPromise: Promise<{
    readonly stopped: true
    readonly alreadyStopped: boolean
    readonly cancelledRuns: number
  }> | null = null

  constructor(private readonly options: HostNodeDomainPortsOptions) {
    this.now = options.now ?? (() => Date.now())
    this.assertMuseOffers(options.museOffers)
    this.runPort = new HostNodeProfileRunPort({ store: options.store, events: options.events })
    if (options.museProvider) {
      this.museProvider = options.museProvider
    } else if (options.museResources) {
      this.museProvider = new HostNodeMuseProvider({
        runPort: this.runPort,
        resources: options.museResources,
        ...(options.museProviderOptions ?? {})
      })
    } else {
      throw new Error('HostNodeDomainPorts requires a Muse provider or Node Muse resources')
    }
    this.recoverInterruptedMuseRuns()
    this.setupExecutor = new HostSetupCommandExecutor({
      workspace: {
        register: (input) => ({ workspaceId: options.store.registerWorkspace(input).id })
      },
      thread: {
        create: (input) => {
          if (input.scope !== 'workspace')
            throw new Error('Standalone Muse threads require a workspace')
          return { threadId: options.store.createThread(input).appChatId }
        },
        configure: (input) => this.configureThread(input),
        archive: (input) => ({
          threadId: options.store.archiveThread(input.threadId, input.archived).appChatId
        })
      },
      providerAuth: {
        begin: (input) => this.beginManualAuth(input),
        cancel: (input) => this.cancelManualAuth(input)
      },
      currentOffers: { read: (providerId) => this.providerOffers(providerId) },
      currentAuthFlows: { read: (providerId) => this.providerAuthFlows(providerId) }
    })
  }

  snapshotDonor() {
    return projectHostProfileDomainSnapshot({
      store: this.options.store,
      health: this.options.health(),
      providers: [...this.options.providerInventory()]
    })
  }

  providerOffers(providerId: string): HostProviderOffersProjection {
    if (providerId !== MUSE_PROVIDER_ID) throw new Error('Unknown standalone provider')
    return this.options.museOffers
  }

  async providerStatuses(): Promise<readonly HostProviderStatusProjection[]> {
    const status = await this.museProvider.getStatus()
    const state = status.configured
      ? 'ready'
      : status.binaryAvailable
        ? 'auth_required'
        : 'unavailable'
    return [
      {
        providerId: MUSE_PROVIDER_ID,
        status: state,
        label: 'Muse',
        ...(status.setupRequired ? { detail: 'Muse requires local setup.' } : {})
      }
    ]
  }

  async providerAuthStatus(providerId: string): Promise<HostProviderAuthStatusProjection> {
    if (providerId !== MUSE_PROVIDER_ID) throw new Error('Unknown standalone provider')
    const status = await this.museProvider.getStatus()
    return {
      providerId: MUSE_PROVIDER_ID,
      state: status.authState === 'authenticated' ? 'authenticated' : 'unauthenticated'
    }
  }

  async providerAuthFlows(providerId: string): Promise<readonly HostProviderAuthFlowProjection[]> {
    if (providerId !== MUSE_PROVIDER_ID || !this.options.manualAuthHandoff) return []
    const status = await this.museProvider.getStatus()
    if (status.authState === 'authenticated') return []
    return [
      {
        flowId: 'muse.manual-login',
        kind: 'manual',
        label: 'Complete Muse login in your terminal',
        available: true
      }
    ]
  }

  threadHistory(request: HostThreadHistoryRequest): HostThreadHistoryPage {
    return this.options.store.threadHistory(request)
  }

  historySince(request: HostHistorySinceRequest): HostHistorySinceResult {
    return this.options.store.historySince(request)
  }

  /** Cancels and awaits active provider children before profile-lease release. */
  shutdown(): Promise<{
    readonly stopped: true
    readonly alreadyStopped: boolean
    readonly cancelledRuns: number
  }> {
    if (this.shutdownPromise) {
      return this.shutdownPromise.then((result) => ({
        ...result,
        alreadyStopped: true,
        cancelledRuns: 0
      }))
    }
    this.shutdownPromise = this.awaitShutdown()
    return this.shutdownPromise
  }

  /** Never returns ask/deferred: unsupported authority is an explicit deny. */
  evaluateAuthority(
    context: HostAuthorityCallContext,
    command: HostCommand
  ): HostAuthorityDecision {
    if (!localContext(context, command))
      return { decision: 'deny', reason: 'standalone_local_actor_required' }
    if (isSetupMutationName(command.name)) return { decision: 'allow' }
    const decoded = validateHostCommandArguments(command)
    if (!decoded.ok) return { decision: 'deny', reason: 'invalid_command' }
    if (command.name !== 'composer.send' && command.name !== 'run.cancel') {
      return { decision: 'deny', reason: 'standalone_command_unsupported' }
    }
    if (!this.runPort.getThread(command.target.threadId)) {
      return { decision: 'deny', reason: 'standalone_muse_thread_required' }
    }
    if (command.name === 'composer.send') {
      const thread = this.runPort.getThread(command.target.threadId)
      if (
        !thread ||
        (typeof command.arguments.model === 'string' &&
          command.arguments.model !== thread.modelId) ||
        (typeof command.arguments.reasoningEffort === 'string' &&
          command.arguments.reasoningEffort !== thread.reasoningId)
      ) {
        return { decision: 'deny', reason: 'standalone_muse_configuration_mismatch' }
      }
    }
    return { decision: 'allow' }
  }

  async executeCommand(
    context: HostAuthorityCallContext,
    command: HostCommand,
    target: HostRunEventTarget
  ): Promise<HostCommandExecutionResult> {
    const authority = this.evaluateAuthority(context, command)
    if (authority.decision !== 'allow') return failed('authority_denied')
    if (isSetupMutationName(command.name)) return this.setupExecutor.execute(command, context)
    const decoded = validateHostCommandArguments(command)
    if (!decoded.ok) return failed('command_invalid')
    if (command.name === 'run.cancel') {
      const outcome = this.runPort.cancelThread(command.target.threadId)
      return outcome === 'cancelled'
        ? { status: 'succeeded', resultSummary: 'muse_run_cancellation_requested' }
        : failed(outcome === 'not_found' ? 'run_not_found' : 'run_not_cancellable')
    }
    if (command.name !== 'composer.send') return failed('command_unsupported')

    const completion = this.museProvider.run({
      runId: command.commandId,
      threadId: command.target.threadId,
      prompt: command.arguments.text as string,
      target
    })
    const tracked = completion
      .catch(() => {
        this.terminalizeRejectedStart(command.commandId, command.target.threadId)
      })
      .then(() => undefined)
    this.runCompletions.set(command.commandId, tracked)
    void tracked.finally(() => this.runCompletions.delete(command.commandId))
    // `run()` persists begin + user/system transcript before its first await.
    // Yield once, then prove the durable start exists before acknowledging.
    await Promise.resolve()
    if (
      !this.hasPersistedStart(command.commandId, command.target.threadId, command.arguments.text)
    ) {
      // The durable start proof failed while the provider promise may still
      // own a child process. Signal its exact cancel before clearing the
      // profile registration; tracked completion still holds shutdown open.
      try {
        this.museProvider.cancel(command.commandId)
      } catch {
        // Completion tracking/lease retention remains authoritative if cancel
        // signalling itself cannot be observed here.
      }
      this.terminalizeRejectedStart(command.commandId, command.target.threadId)
      return failed('muse_run_not_started')
    }
    return { status: 'succeeded', resultSummary: 'muse_run_started' }
  }

  private configureThread(input: {
    readonly threadId: string
    readonly providerId?: string
    readonly modelId?: string
    readonly reasoningId?: string
    readonly postureId?: string
    readonly postureConsent?: true
    readonly title?: string
  }): { readonly threadId: string } {
    if (input.providerId !== undefined && input.providerId !== MUSE_PROVIDER_ID) {
      throw new Error('Standalone Host supports Muse only')
    }
    const postureId = input.postureId
    if (
      postureId !== undefined &&
      postureId !== 'read_only' &&
      postureId !== 'plan' &&
      postureId !== 'default' &&
      postureId !== 'workspace_write'
    ) {
      throw new Error('Unknown Muse posture')
    }
    const thread = this.options.store.configureThread({
      threadId: input.threadId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.reasoningId ? { reasoningId: input.reasoningId } : {}),
      ...(postureId ? { postureId } : {}),
      ...(input.postureConsent ? { postureConsent: true as const } : {}),
      ...(input.title ? { title: input.title } : {})
    })
    return { threadId: thread.appChatId }
  }

  private async beginManualAuth(input: {
    readonly providerId: string
    readonly flowId: string
    readonly operationId: string
  }): Promise<{ readonly providerId: string; readonly operationId: string }> {
    if (
      input.providerId !== MUSE_PROVIDER_ID ||
      input.flowId !== 'muse.manual-login' ||
      !isCanonicalId(input.operationId) ||
      !this.options.manualAuthHandoff ||
      this.authOperations.has(input.operationId)
    ) {
      throw new Error('Muse manual auth cannot begin')
    }
    await this.options.manualAuthHandoff.begin({
      providerId: MUSE_PROVIDER_ID,
      operationId: input.operationId
    })
    this.authOperations.set(input.operationId, {
      providerId: MUSE_PROVIDER_ID,
      operationId: input.operationId,
      startedAt: new Date(this.now()).toISOString(),
      cancelled: false
    })
    return { providerId: MUSE_PROVIDER_ID, operationId: input.operationId }
  }

  private async cancelManualAuth(input: {
    readonly providerId: string
    readonly operationId: string
  }): Promise<{
    readonly providerId: string
    readonly operationId: string
    readonly outcome: 'cancelled' | 'not_found' | 'not_cancellable'
  }> {
    const operation = this.authOperations.get(input.operationId)
    if (!operation || operation.providerId !== input.providerId) {
      return { ...input, outcome: 'not_found' }
    }
    if (operation.cancelled || !this.options.manualAuthHandoff?.cancel) {
      return { ...input, outcome: 'not_cancellable' }
    }
    const cancelled = await this.options.manualAuthHandoff.cancel(input)
    if (!cancelled) return { ...input, outcome: 'not_cancellable' }
    operation.cancelled = true
    return { ...input, outcome: 'cancelled' }
  }

  private hasPersistedStart(runId: string, threadId: string, prompt: unknown): boolean {
    if (typeof prompt !== 'string') return false
    const thread = this.options.store.getThread(threadId)
    return Boolean(
      this.runPort.hasBegun(runId, threadId) &&
      thread?.runs?.some((run) => run.runId === runId && run.status === 'running') &&
      thread.messages.some(
        (message) =>
          message.runId === runId && message.role === 'user' && message.content === prompt
      )
    )
  }

  /** A fresh profile lease cannot prove an inherited running Muse child still exists. */
  private recoverInterruptedMuseRuns(): void {
    const endedAt = new Date(this.now()).toISOString()
    for (const thread of this.options.store.listThreads()) {
      if (thread.provider !== MUSE_PROVIDER_ID) continue
      for (const run of thread.runs ?? []) {
        if (run.provider !== MUSE_PROVIDER_ID || run.status !== 'running') continue
        this.options.store.updateRun({
          threadId: thread.appChatId,
          runId: run.runId,
          status: 'failed',
          endedAt,
          warningSummaries: ['Muse running state recovered after Host restart.'],
          errorCode: 'provider_failed'
        })
      }
    }
  }

  private terminalizeRejectedStart(runId: string, threadId: string): void {
    try {
      const thread = this.options.store.getThread(threadId)
      const run = thread?.runs?.find(
        (candidate) => candidate.runId === runId && candidate.provider === MUSE_PROVIDER_ID
      )
      if (run?.status !== 'running') return
      this.options.store.updateRun({
        threadId,
        runId,
        status: 'failed',
        endedAt: new Date(this.now()).toISOString(),
        warningSummaries: ['Muse run start could not be durably acknowledged.'],
        errorCode: 'provider_failed'
      })
    } catch {
      // This is best effort only; the tracked provider completion remains in
      // shutdown accounting and a fresh lease performs deterministic recovery.
    } finally {
      try {
        this.runPort.clearCancel(runId)
      } catch {
        // A later fresh profile lease still recovers a durable running row.
      }
    }
  }

  private async awaitShutdown(): Promise<{
    readonly stopped: true
    readonly alreadyStopped: boolean
    readonly cancelledRuns: number
  }> {
    const cancelledRuns = this.runPort.cancelAll()
    const completions = [...this.runCompletions.values()]
    if (completions.length) await this.awaitWithinShutdownTimeout(Promise.all(completions))
    return { stopped: true, alreadyStopped: false, cancelledRuns }
  }

  private async awaitWithinShutdownTimeout(completion: Promise<unknown>): Promise<void> {
    const timeoutMs = this.options.shutdownTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Host shutdown timeout must be a positive integer')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Host provider shutdown timed out')), timeoutMs)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private assertMuseOffers(offers: HostProviderOffersProjection): void {
    if (!offers || offers.providerId !== MUSE_PROVIDER_ID || !isCanonicalId(offers.offerRevision)) {
      throw new Error('HostNodeDomainPorts requires canonical Muse offers')
    }
  }
}

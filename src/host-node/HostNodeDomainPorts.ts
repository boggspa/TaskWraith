/**
 * Standalone Node Host domain ports. No Electron/Bridge/desktop-store imports:
 * profile state, delivery, provider registry, inventory, and auth handoff are
 * all injected at composition time.
 */

import type {
  HostApprovalDecideDecision,
  HostAuthorityDecision,
  HostCommand,
  HostHealthProjection,
  HostQuestionAnswerDecision
} from '../shared/hostProtocol'
import {
  HOST_APPROVAL_DECIDE_DECISIONS,
  HOST_QUESTION_ANSWER_DECISIONS
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
  HostNodeInteractionRegistry,
  type HostNodeInteractionActor
} from './HostNodeInteractionRegistry'
import type { HostNodeProvider } from './HostNodeProvider'
import { HostNodeProviderRegistry } from './HostNodeProviderRegistry'
import { HostNodeProfileRunPort, type HostNodeRunEventSink } from './HostNodeProfileRunPort'

const LOCAL_CLIENT_CLASSES = new Set(['desktop', 'tui', 'test'])

export interface HostNodeDomainPortsOptions {
  readonly store: HostProfileDomainStore
  readonly events: HostNodeRunEventSink
  /** Live provider factories; the domain constructs one registry from them. */
  readonly providers: readonly HostNodeProvider[]
  readonly health: () => HostHealthProjection
  readonly now?: () => number
  /** Lease release must not proceed while a provider child may still be alive. */
  readonly shutdownTimeoutMs?: number
  /** Per-interaction timeout in milliseconds; pending cards reject after this. */
  readonly interactionTimeoutMs?: number
  /** Real reconciliation callback; the server plumbs its projector here. */
  readonly onProjectionDirty?: () => void
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

export class HostNodeDomainPorts {
  readonly runPort: HostNodeProfileRunPort
  readonly registry: HostNodeProviderRegistry
  readonly interactions: HostNodeInteractionRegistry
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
    this.runPort = new HostNodeProfileRunPort({ store: options.store, events: options.events })
    this.interactions = new HostNodeInteractionRegistry({
      timeoutMs: options.interactionTimeoutMs,
      onRegistered: () => this.notifyProjectionDirty(),
      onSettled: () => this.notifyProjectionDirty(),
      onCancelled: () => this.notifyProjectionDirty()
    })
    this.registry = new HostNodeProviderRegistry({
      providers: options.providers,
      runPort: this.runPort,
      interactions: this.interactions
    })
    this.recoverInterruptedRuns()
    this.setupExecutor = new HostSetupCommandExecutor({
      workspace: {
        register: (input) => ({ workspaceId: options.store.registerWorkspace(input).id })
      },
      thread: {
        create: (input) => {
          if (input.scope !== 'workspace')
            throw new Error('Standalone Host threads require a workspace')
          return { threadId: options.store.createThread(input).appChatId }
        },
        configure: (input) => this.configureThread(input),
        archive: (input) => {
          this.interactions.cancelByThreadId(
            input.threadId,
            'HostNodeInteractionRegistry: thread archived'
          )
          return {
            threadId: options.store.archiveThread(input.threadId, input.archived).appChatId
          }
        }
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
    const base = projectHostProfileDomainSnapshot({
      store: this.options.store,
      health: this.options.health(),
      providers: [...this.registry.providerInventory()]
    })
    const pending = this.interactions.listPending()
    return {
      ...base,
      approvals: pending
        .filter((entry) => entry.kind === 'approval')
        .map((entry) => ({
          approvalId: entry.id,
          commandId: entry.id,
          threadId: entry.threadId,
          status: 'pending' as const,
          actionKind: 'tool_execution',
          createdAt: new Date(entry.createdAt).getTime(),
          summary: entry.summary
        })),
      questions: pending
        .filter((entry) => entry.kind === 'question')
        .map((entry) => ({
          questionId: entry.id,
          threadId: entry.threadId,
          status: 'open' as const,
          promptPreview: entry.summary.slice(0, 200),
          askedAt: new Date(entry.createdAt).getTime()
        }))
    }
  }

  providerOffers(providerId: string): HostProviderOffersProjection {
    const offers = this.registry.getOffers(providerId)
    if (!offers) throw new Error('Unknown standalone provider')
    return offers
  }

  providerStatuses(): Promise<readonly HostProviderStatusProjection[]> {
    return this.registry.providerStatuses()
  }

  async providerAuthStatus(providerId: string): Promise<HostProviderAuthStatusProjection> {
    const status = await this.registry.providerAuthStatus(providerId)
    if (!status) throw new Error('Unknown standalone provider')
    return status
  }

  async providerAuthFlows(providerId: string): Promise<readonly HostProviderAuthFlowProjection[]> {
    const flows = await this.registry.providerAuthFlows(providerId)
    if (!flows) throw new Error('Unknown standalone provider')
    return flows
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

    if (command.name === 'approval.decide') {
      if (!this.registry.supportsApprovals) {
        return { decision: 'deny', reason: 'standalone_command_unsupported' }
      }
      const id = command.target.approvalId
      if (!isCanonicalId(id)) return { decision: 'deny', reason: 'invalid_command' }
      const decision = command.arguments.decision as HostApprovalDecideDecision
      if (!HOST_APPROVAL_DECIDE_DECISIONS.includes(decision)) {
        return { decision: 'deny', reason: 'invalid_command' }
      }
      const pending = this.interactions.listPending()
      const entry = pending.find(
        (candidate) => candidate.id === id && candidate.kind === 'approval'
      )
      if (!entry) return { decision: 'deny', reason: 'standalone_approval_not_found' }
      // Ownership: the pending card must belong to a live run/thread with a matching provider.
      const liveThread = this.runPort.getThread(entry.threadId)
      if (
        !liveThread ||
        liveThread.providerId !== entry.providerId ||
        !this.runPort.hasBegun(entry.runId, entry.threadId)
      ) {
        return { decision: 'deny', reason: 'standalone_approval_not_found' }
      }
      return { decision: 'allow' }
    }

    if (command.name === 'question.answer') {
      if (!this.registry.supportsQuestions) {
        return { decision: 'deny', reason: 'standalone_command_unsupported' }
      }
      const id = command.target.questionId
      if (!isCanonicalId(id)) return { decision: 'deny', reason: 'invalid_command' }
      const decision = command.arguments.decision as HostQuestionAnswerDecision
      if (!HOST_QUESTION_ANSWER_DECISIONS.includes(decision)) {
        return { decision: 'deny', reason: 'invalid_command' }
      }
      const pending = this.interactions.listPending()
      const entry = pending.find(
        (candidate) => candidate.id === id && candidate.kind === 'question'
      )
      if (!entry) return { decision: 'deny', reason: 'standalone_question_not_found' }
      const liveThread = this.runPort.getThread(entry.threadId)
      if (
        !liveThread ||
        liveThread.providerId !== entry.providerId ||
        !this.runPort.hasBegun(entry.runId, entry.threadId)
      ) {
        return { decision: 'deny', reason: 'standalone_question_not_found' }
      }
      return { decision: 'allow' }
    }

    if (command.name !== 'composer.send' && command.name !== 'run.cancel') {
      return { decision: 'deny', reason: 'standalone_command_unsupported' }
    }
    const thread = this.runPort.getThread(command.target.threadId)
    if (!thread) {
      return { decision: 'deny', reason: 'standalone_thread_required' }
    }
    if (command.name === 'composer.send') {
      if (!this.registry.hasProvider(thread.providerId)) {
        return { decision: 'deny', reason: 'standalone_provider_not_composed' }
      }
      const offers = this.registry.getOffers(thread.providerId)
      if (!offers || !this.sendSelectionIsCurrent(thread, command.arguments, offers)) {
        return { decision: 'deny', reason: 'standalone_configuration_mismatch' }
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
        ? { status: 'succeeded', resultSummary: 'run_cancellation_requested' }
        : failed(outcome === 'not_found' ? 'run_not_found' : 'run_not_cancellable')
    }

    if (command.name === 'approval.decide') {
      const id = command.target.approvalId
      const decision = command.arguments.decision as HostApprovalDecideDecision
      const result = this.interactions.decide({ id, decision, actor: actorFromContext(context) })
      return result.settled
        ? { status: 'succeeded', resultSummary: 'approval_decided' }
        : failed('approval_not_found')
    }

    if (command.name === 'question.answer') {
      const id = command.target.questionId
      const decision = command.arguments.decision as HostQuestionAnswerDecision
      const answer = command.arguments.answer as string | undefined
      const result = this.interactions.answer({
        id,
        decision,
        answer,
        actor: actorFromContext(context)
      })
      return result.settled
        ? { status: 'succeeded', resultSummary: 'question_answered' }
        : failed('question_not_found')
    }

    if (command.name !== 'composer.send') return failed('command_unsupported')

    const thread = this.runPort.getThread(command.target.threadId)
    if (!thread) return failed('thread_not_found')
    const provider = this.registry.getInstance(thread.providerId)
    if (!provider) return failed('provider_not_composed')

    const effectiveThread = this.effectiveThread(thread, command.arguments)
    if (!effectiveThread) return failed('standalone_configuration_mismatch')

    const completion = provider.run({
      runId: command.commandId,
      threadId: command.target.threadId,
      prompt: command.arguments.text as string,
      target
    })
    const tracked = completion
      .catch(() => {
        this.terminalizeRejectedStart(command.commandId, command.target.threadId)
      })
      .then(() => {
        this.interactions.cancelByRunId(
          command.commandId,
          'HostNodeInteractionRegistry: provider run completed'
        )
      })
    this.runCompletions.set(command.commandId, tracked)
    void tracked.finally(() => this.runCompletions.delete(command.commandId))
    await Promise.resolve()
    if (
      !this.hasPersistedStart(command.commandId, command.target.threadId, command.arguments.text)
    ) {
      try {
        provider.cancel(command.commandId)
      } catch {
        // Completion tracking/lease retention remains authoritative if cancel
        // signalling itself cannot be observed here.
      }
      this.terminalizeRejectedStart(command.commandId, command.target.threadId)
      return failed('run_not_started')
    }
    return { status: 'succeeded', resultSummary: 'run_started' }
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
    if (input.providerId !== undefined && !this.registry.hasProvider(input.providerId)) {
      throw new Error('Standalone Host does not compose that provider')
    }
    const postureId = input.postureId
    if (postureId !== undefined) {
      const offers = input.providerId ? this.registry.getOffers(input.providerId) : undefined
      const posture = offers?.postures.find((p) => p.postureId === postureId && p.available)
      if (!posture) throw new Error('Unknown posture')
    }
    const thread = this.options.store.configureThread({
      threadId: input.threadId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.reasoningId ? { reasoningId: input.reasoningId } : {}),
      ...(postureId
        ? { postureId: postureId as 'read_only' | 'plan' | 'default' | 'workspace_write' }
        : {}),
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
    if (!isCanonicalId(input.providerId) || !isCanonicalId(input.operationId)) {
      throw new Error('Manual auth input is invalid')
    }
    const flows = await this.registry.providerAuthFlows(input.providerId)
    if (!flows || !flows.some((flow) => flow.flowId === input.flowId && flow.available)) {
      throw new Error('Manual auth flow is not current')
    }
    const provider = this.registry.getInstance(input.providerId)
    if (!provider) throw new Error('Manual auth provider is not composed')
    await provider.beginAuth(input.operationId)
    this.authOperations.set(input.operationId, {
      providerId: input.providerId,
      operationId: input.operationId,
      startedAt: new Date(this.now()).toISOString(),
      cancelled: false
    })
    return { providerId: input.providerId, operationId: input.operationId }
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
    if (operation.cancelled) return { ...input, outcome: 'not_cancellable' }
    const provider = this.registry.getInstance(input.providerId)
    if (!provider) return { ...input, outcome: 'not_cancellable' }
    const cancelled = await provider.cancelAuth(input.operationId)
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

  /** A fresh profile lease cannot prove an inherited running provider child still exists. */
  private recoverInterruptedRuns(): void {
    const composedProviderIds = new Set(this.registry.providerIds)
    const endedAt = new Date(this.now()).toISOString()
    for (const thread of this.options.store.listThreads()) {
      if (!thread.provider || !composedProviderIds.has(thread.provider)) continue
      for (const run of thread.runs ?? []) {
        if (run.provider !== thread.provider || run.status !== 'running') continue
        this.options.store.updateRun({
          threadId: thread.appChatId,
          runId: run.runId,
          status: 'failed',
          endedAt,
          warningSummaries: ['Provider running state recovered after Host restart.'],
          errorCode: 'provider_failed'
        })
      }
    }
  }

  private terminalizeRejectedStart(runId: string, threadId: string): void {
    try {
      const thread = this.options.store.getThread(threadId)
      const run = thread?.runs?.find(
        (candidate) => candidate.runId === runId && candidate.provider === thread.provider
      )
      if (run?.status !== 'running') return
      this.options.store.updateRun({
        threadId,
        runId,
        status: 'failed',
        endedAt: new Date(this.now()).toISOString(),
        warningSummaries: ['Provider run start could not be durably acknowledged.'],
        errorCode: 'provider_failed'
      })
      this.interactions.cancelByRunId(runId, 'HostNodeInteractionRegistry: provider run failed')
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

  private sendSelectionIsCurrent(
    thread: {
      readonly providerId: string
      readonly modelId: string
      readonly reasoningId?: string
    },
    args: Record<string, unknown>,
    offers: HostProviderOffersProjection
  ): boolean {
    if (typeof args.offerRevision === 'string' && offers.offerRevision !== args.offerRevision) {
      return false
    }
    const modelId = args.model
    const reasoningId = args.reasoningEffort
    const model =
      typeof modelId === 'string'
        ? offers.models.find((m) => m.modelId === modelId && m.available)
        : undefined
    if (typeof modelId === 'string' && !model) return false
    const effectiveModelId = typeof modelId === 'string' ? modelId : thread.modelId
    if (effectiveModelId !== thread.modelId) return false
    if (typeof reasoningId === 'string') {
      const reasoning = model?.reasoning.find((r) => r.reasoningId === reasoningId && r.available)
      if (!reasoning) return false
    }
    return true
  }

  private effectiveThread(
    thread: {
      readonly threadId: string
      readonly workspace: { readonly workspaceId: string; readonly canonicalPath: string }
      readonly providerId: string
      readonly modelId: string
      readonly reasoningId?: string
      readonly providerSessionId?: string
      readonly posture: { readonly postureId: string; readonly approvalMode: string }
    },
    args: Record<string, unknown>
  ): {
    readonly threadId: string
    readonly workspace: { readonly workspaceId: string; readonly canonicalPath: string }
    readonly providerId: string
    readonly modelId: string
    readonly reasoningId?: string
    readonly providerSessionId?: string
    readonly posture: { readonly postureId: string; readonly approvalMode: string }
  } | null {
    const offers = this.registry.getOffers(thread.providerId)
    if (!offers) return null
    if (!this.sendSelectionIsCurrent(thread, args, offers)) return null
    const modelId = typeof args.model === 'string' ? (args.model as string) : thread.modelId
    const reasoningId =
      typeof args.reasoningEffort === 'string'
        ? (args.reasoningEffort as string)
        : thread.reasoningId
    return {
      threadId: thread.threadId,
      workspace: thread.workspace,
      providerId: thread.providerId,
      modelId,
      ...(reasoningId !== undefined ? { reasoningId } : {}),
      ...(thread.providerSessionId ? { providerSessionId: thread.providerSessionId } : {}),
      posture: thread.posture
    }
  }

  private async awaitShutdown(): Promise<{
    readonly stopped: true
    readonly alreadyStopped: boolean
    readonly cancelledRuns: number
  }> {
    const cancelledRuns = this.runPort.cancelAll()
    const completions = [...this.runCompletions.values()]
    await Promise.all([this.registry.shutdown(), this.interactions.shutdown()])
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

  private notifyProjectionDirty(): void {
    this.options.onProjectionDirty?.()
  }
}

function actorFromContext(context: HostAuthorityCallContext): HostNodeInteractionActor {
  return {
    clientId: context.client.clientId,
    clientClass: context.client.clientClass,
    actorId: context.actor.actorId
  }
}

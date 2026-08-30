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
  HOST_QUESTION_ANSWER_DECISIONS,
  TASKWRAITH_DESKTOP_HOST_ACTOR
} from '../shared/hostProtocol'
import {
  decodeHostWorkspaceGitReadResult,
  HOST_WORKSPACE_GIT_RESULT_MAX_BYTES,
  type HostWorkspaceGitFileKind,
  type HostWorkspaceGitReadParams,
  type HostWorkspaceGitReadResult,
  type HostWorkspaceGitStatusFile
} from '../shared/hostProtocolTransport'
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
import type { TaskWraithControlThreadOffers } from '../shared/taskWraithControlProtocol'
import { resolveTaskWraithProviderPresentation } from '../shared/taskWraithProviderPresentation'
import { projectHostProviderOfferCapabilities } from '../host-shared/HostProviderCatalog'
import { buildAgentWorkState, type AgentWorkGoalFacts } from '../host-shared/AgentWorkContract'
import type { HostGitFileStatus } from '../host-shared/git/HostGitStatusParse'
import type { HostGitReadResult, HostGitReadService } from '../host-shared/git/HostGitReadService'
import { validateHostCommandArguments } from '../host-runtime/HostCommandArguments'
import type { HostCommandExecutionResult } from '../host-runtime/HostCommandExecutionResult'
import {
  hostAuthorityCommandActorMatchesContext,
  isExactHostActorIdentity,
  type HostAuthorityCallContext
} from '../host-runtime/HostAuthority'
import { projectHostProfileDomainSnapshot } from '../host-runtime/HostProfileDomainProjection'
import {
  HostProfileDomainStore,
  type HostProfileThread
} from '../host-runtime/HostProfileDomainStore'
import {
  HostProfileRecordCommandExecutor,
  isHostProfileRecordMutationName
} from '../host-runtime/HostProfileRecordCommandExecutor'
import { HostSetupCommandExecutor } from '../host-runtime/HostSetupCommandExecutor'
import type {
  HostPermissionConsentAuthorityPort,
  HostPermissionConsentEnvelope,
  HostPermissionConsentRequest
} from '../host-runtime/HostPermissionConsent'
import { HostFullAccessGrantRegistry } from '../host-runtime/HostPermissionConsent'
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
  /** Canonical profile directory used only for owner-bound large-record transfer artifacts. */
  readonly profilePath?: string
  readonly store: HostProfileDomainStore
  readonly events: HostNodeRunEventSink
  /** Live provider factories; the domain constructs one registry from them. */
  readonly providers: readonly HostNodeProvider[]
  /** Optional hardened read service; absence means workspace-git is not offered. */
  readonly gitReadService?: Pick<HostGitReadService, 'read'>
  readonly health: () => HostHealthProjection
  readonly now?: () => number
  /** Lease release must not proceed while a provider child may still be alive. */
  readonly shutdownTimeoutMs?: number
  /** Per-interaction timeout in milliseconds; pending cards reject after this. */
  readonly interactionTimeoutMs?: number
  /** Real reconciliation callback; the server plumbs its projector here. */
  readonly onProjectionDirty?: () => void
  /** Required for standalone Full Access; lower postures remain compatible without it. */
  readonly permissionConsentAuthority?: HostPermissionConsentAuthorityPort
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

function exactDesktopRecordMutationContext(
  context: HostAuthorityCallContext,
  command: HostCommand
): boolean {
  const expected = TASKWRAITH_DESKTOP_HOST_ACTOR
  return (
    localContext(context, command) &&
    context.client.clientClass === expected.clientClass &&
    context.client.clientId === expected.clientId &&
    context.actor.clientClass === expected.clientClass &&
    context.actor.clientId === expected.clientId &&
    context.actor.actorId === expected.actorId
  )
}

function localReadContext(context: HostAuthorityCallContext): boolean {
  return (
    isExactHostActorIdentity(context.actor) &&
    LOCAL_CLIENT_CLASSES.has(context.client.clientClass) &&
    context.actor.clientId === context.client.clientId &&
    context.actor.clientClass === context.client.clientClass
  )
}

function wireGitFileKind(kind: HostGitFileStatus['kind']): HostWorkspaceGitFileKind {
  switch (kind) {
    case 'added':
    case 'copied':
      return 'created'
    case 'modified':
    case 'deleted':
    case 'renamed':
    case 'untracked':
    case 'ignored':
    case 'conflicted':
      return kind
    case 'unknown':
      throw new Error('Standalone Host git returned an unknown file status')
  }
}

function wireGitFile(file: HostGitFileStatus): HostWorkspaceGitStatusFile {
  return {
    path: file.path,
    ...(file.originalPath === undefined ? {} : { originalPath: file.originalPath }),
    index: file.index,
    workingTree: file.workingTree,
    kind: wireGitFileKind(file.kind),
    staged: file.staged,
    unstaged: file.unstaged
  }
}

function serializedGitResultFits(result: HostWorkspaceGitReadResult): boolean {
  return (
    Buffer.byteLength(JSON.stringify({ kind: 'workspace.git.read', result }), 'utf8') <=
    HOST_WORKSPACE_GIT_RESULT_MAX_BYTES
  )
}

function validateWireGitResult(result: HostWorkspaceGitReadResult): HostWorkspaceGitReadResult {
  const decoded = decodeHostWorkspaceGitReadResult(result)
  if (!decoded.ok || !serializedGitResultFits(decoded.value)) {
    throw new Error('Standalone Host git result is not wire-safe')
  }
  return decoded.value
}

function projectHostGitResult(result: HostGitReadResult): HostWorkspaceGitReadResult {
  const base = { branch: result.branch, head: result.head }
  if (result.scope === 'status') {
    if (!Array.isArray(result.files)) throw new Error('Standalone Host git status is unavailable')
    const files = result.files.map(wireGitFile)
    let low = 0
    let high = files.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate: HostWorkspaceGitReadResult = {
        scope: 'status',
        ...base,
        files: files.slice(0, middle),
        truncated: middle < files.length
      }
      if (serializedGitResultFits(candidate)) low = middle
      else high = middle - 1
    }
    return validateWireGitResult({
      scope: 'status',
      ...base,
      files: files.slice(0, low),
      truncated: low < files.length
    })
  }

  if (!result.text) throw new Error('Standalone Host git text is unavailable')
  const characters = Array.from(result.text.text)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate: HostWorkspaceGitReadResult = {
      scope: result.scope,
      ...base,
      text: characters.slice(0, middle).join(''),
      truncated: result.text.truncated || middle < characters.length
    }
    if (serializedGitResultFits(candidate)) low = middle
    else high = middle - 1
  }
  return validateWireGitResult({
    scope: result.scope,
    ...base,
    text: characters.slice(0, low).join(''),
    truncated: result.text.truncated || low < characters.length
  })
}

interface HostNodeEnsembleParticipant extends Record<string, unknown> {
  readonly id: string
  readonly provider: string
  readonly enabled: boolean
  readonly order: number
}

interface HostNodeEnsembleRecord extends Record<string, unknown> {
  readonly participants: readonly HostNodeEnsembleParticipant[]
  readonly activeRound?: unknown
}

function ensembleForSeatControl(thread: HostProfileThread): HostNodeEnsembleRecord | null {
  if (thread.chatKind !== 'ensemble') return null
  const raw = thread.ensemble
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const participants = (raw as Record<string, unknown>).participants
  if (!Array.isArray(participants) || participants.length === 0) return null
  const seen = new Set<string>()
  const decoded: HostNodeEnsembleParticipant[] = []
  for (const participant of participants) {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) return null
    const record = participant as Record<string, unknown>
    if (
      !isCanonicalId(record.id) ||
      !isCanonicalId(record.provider) ||
      typeof record.enabled !== 'boolean' ||
      !Number.isInteger(record.order) ||
      (record.order as number) < 0 ||
      seen.has(record.id)
    ) {
      return null
    }
    seen.add(record.id)
    decoded.push(record as HostNodeEnsembleParticipant)
  }
  return {
    ...(raw as Record<string, unknown>),
    participants: decoded
  } as HostNodeEnsembleRecord
}

function ensembleRoundIsActive(ensemble: HostNodeEnsembleRecord): boolean {
  const round = ensemble.activeRound
  return (
    Boolean(round) &&
    typeof round === 'object' &&
    !Array.isArray(round) &&
    (round as Record<string, unknown>).status === 'running'
  )
}

/**
 * Narrow an untrusted stored goal to the facts the work contract reads. Only a
 * LIVE goal qualifies: a completed or paused goal must not reach a prompt, and
 * a run on a thread with no live goal stays byte-identical to before.
 */
function liveAgentWorkGoal(value: unknown): AgentWorkGoalFacts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.objective !== 'string' ||
    typeof record.status !== 'string' ||
    typeof record.mode !== 'string'
  ) {
    return undefined
  }
  if (record.status !== 'active' && record.status !== 'blocked') return undefined
  return record as unknown as AgentWorkGoalFacts
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
  private readonly fullAccessGrants = new HostFullAccessGrantRegistry()
  private readonly profileRecordExecutor: HostProfileRecordCommandExecutor
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
    this.profileRecordExecutor = new HostProfileRecordCommandExecutor({
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      store: options.store
    })
    this.runPort = new HostNodeProfileRunPort({
      store: options.store,
      events: options.events,
      ...(options.permissionConsentAuthority
        ? { permissionConsentAuthority: options.permissionConsentAuthority }
        : {}),
      fullAccessGrants: this.fullAccessGrants
    })
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
          this.fullAccessGrants.revokeThread(input.threadId)
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

  async providerOffers(providerId: string): Promise<HostProviderOffersProjection> {
    const base = await this.registry.refreshOffers(providerId)
    const offers = base ? this.effectiveProviderOffers(base) : null
    if (!offers) throw new Error('Unknown standalone provider')
    return offers
  }

  private cachedProviderOffers(providerId: string): HostProviderOffersProjection | null {
    const base = this.registry.getOffers(providerId)
    return base ? this.effectiveProviderOffers(base) : null
  }

  private effectiveProviderOffers(
    base: HostProviderOffersProjection
  ): HostProviderOffersProjection {
    return projectHostProviderOfferCapabilities(base, {
      fullAccessConsentAuthority: Boolean(this.options.permissionConsentAuthority)
    })
  }

  /**
   * Curated model offers for one thread, projected from the SAME catalogue the
   * composer.send gate validates against, so the tune lens can never stage a
   * selection this Host would then reject as a configuration mismatch.
   *
   * `current` is derived from the stored thread record, never from anything a
   * client sends — a client may name a selection, it may not assert the one in
   * force. A thread with no provider, or one naming a provider this Host does
   * not compose, returns an empty catalogue with `locked` set: an honest
   * refusal, never an invented list of models that could not actually run.
   */
  async threadOffers(threadId: string): Promise<TaskWraithControlThreadOffers> {
    const thread = this.options.store.getThread(threadId)
    if (!thread) throw new Error('Unknown standalone thread')
    const providerId = typeof thread.provider === 'string' ? thread.provider : undefined
    const metadata = (thread.providerMetadata ?? {}) as Record<string, unknown>
    const currentModel =
      typeof metadata.selectedModelType === 'string' ? metadata.selectedModelType : undefined
    const currentReasoning =
      typeof metadata.reasoningEffort === 'string' ? metadata.reasoningEffort : undefined
    const currentPosture =
      thread.workflowMode === 'plan' && metadata.permissionPresetId === 'read_only'
        ? 'plan'
        : typeof metadata.permissionPresetId === 'string'
          ? metadata.permissionPresetId
          : undefined
    const refreshed = providerId ? await this.registry.refreshOffers(providerId) : null
    const offers = refreshed ? this.effectiveProviderOffers(refreshed) : undefined
    const catalogue = offers?.models ?? []
    const currentLabel = catalogue.find((model) => model.modelId === currentModel)?.label
    const unavailable = 'Not available on this Host'
    const locked = !providerId
      ? 'This chat has no provider yet - use /new to choose one.'
      : !offers
        ? `This Host does not compose ${providerId}, so it offers no models for it.`
        : undefined
    return {
      threadId,
      provider: resolveTaskWraithProviderPresentation(providerId, currentModel, currentLabel),
      ...(currentModel ? { currentModel } : {}),
      ...(currentReasoning ? { currentReasoningEffort: currentReasoning } : {}),
      ...(currentPosture ? { currentPostureId: currentPosture } : {}),
      ...(offers
        ? {
            postures: offers.postures.map((posture) => ({
              id: posture.postureId,
              label: posture.label,
              ...(posture.available
                ? {}
                : { disabled: true, disabledReason: posture.detail || unavailable }),
              requiresExplicitConsent: posture.requiresExplicitConsent
            }))
          }
        : {}),
      models: catalogue.map((model) => ({
        id: model.modelId,
        ...(model.label ? { label: model.label } : {}),
        ...(model.default === true ? { isDefault: true } : {}),
        ...(currentModel && model.modelId === currentModel ? { current: true } : {}),
        ...(model.available ? {} : { disabled: true, disabledReason: unavailable }),
        reasoningEfforts: model.reasoning.map((effort) => ({
          id: effort.reasoningId,
          ...(effort.available ? {} : { disabled: true, disabledReason: unavailable })
        }))
      })),
      source: 'curated',
      ...(locked ? { locked } : {})
    }
  }

  /**
   * Prepend the App's work-state block when the thread carries a live goal.
   *
   * The App writes goals onto chat records that this Host also reads, but the
   * Host previously passed the raw prompt through — so a goal set in the App was
   * stored, shown, and then silently ignored by every run the Host started. The
   * block is built by the same host-shared builder PromptComposition uses, and
   * placed before the request exactly as injectBeforeCurrentRequest does, so a
   * Host run reads identically to an App run.
   *
   * Threads with no live goal are untouched: their prompt is byte-identical.
   */
  private promptWithActiveGoal(threadId: string, text: string): string {
    const goal = liveAgentWorkGoal(this.options.store.getThread(threadId)?.activeGoal)
    if (!goal) return text
    // Native provider goal engines retain the objective themselves; arming a
    // second steering copy is exactly what PromptComposition avoids here.
    const providerOwnsGoalSteering =
      goal.mode === 'codex_native' || goal.mode === 'claude_native' || goal.mode === 'grok_native'
    const workState = buildAgentWorkState({
      activeGoal: goal,
      providerOwnsGoalSteering,
      completionAuthority: 'root'
    })
    return `${workState}\n\n${text}`
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

  get supportsWorkspaceGit(): boolean {
    return this.options.gitReadService !== undefined
  }

  get supportsEnsembleSeatControl(): boolean {
    return true
  }

  async gitRead(
    context: HostAuthorityCallContext,
    request: HostWorkspaceGitReadParams
  ): Promise<HostWorkspaceGitReadResult> {
    if (!this.options.gitReadService || !localReadContext(context)) {
      throw new Error('Standalone Host git workspace is unavailable')
    }

    let workspaceId: string
    try {
      if ('workspaceId' in request && request.workspaceId !== undefined) {
        workspaceId = request.workspaceId
      } else if ('threadId' in request && request.threadId !== undefined) {
        const thread = this.options.store.getThread(request.threadId)
        if (!thread || thread.scope !== 'workspace' || !thread.workspaceId) {
          throw new Error('thread workspace unavailable')
        }
        workspaceId = thread.workspaceId
      } else {
        throw new Error('workspace target unavailable')
      }
      const workspace = this.options.store
        .listWorkspaces()
        .find((candidate) => candidate.id === workspaceId)
      if (!workspace) throw new Error('registered workspace unavailable')
      const result = await this.options.gitReadService.read({
        workspaceRealPath: workspace.realPath,
        scope: request.scope,
        ...(request.path === undefined ? {} : { path: request.path })
      })
      return projectHostGitResult(result)
    } catch (error) {
      throw new Error('Standalone Host git workspace is unavailable', { cause: error })
    }
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

    if (isHostProfileRecordMutationName(command.name)) {
      if (!exactDesktopRecordMutationContext(context, command)) {
        return { decision: 'deny', reason: 'standalone_desktop_actor_required' }
      }
      if (command.name === 'thread.record.persist' && !this.options.profilePath) {
        return { decision: 'deny', reason: 'standalone_thread_record_persist_unavailable' }
      }
      return { decision: 'allow' }
    }

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

    if (
      command.name !== 'composer.send' &&
      command.name !== 'run.cancel' &&
      command.name !== 'ensemble.seat.toggle' &&
      command.name !== 'thread.select'
    ) {
      return { decision: 'deny', reason: 'standalone_command_unsupported' }
    }
    const profileThread = this.options.store.getThread(command.target.threadId)
    if (!profileThread || profileThread.archived || profileThread.scope !== 'workspace') {
      return { decision: 'deny', reason: 'standalone_thread_required' }
    }

    // Selecting a thread is a view acknowledgement, not a run, so it stops at the
    // profile gate above. It must NOT fall through to the runPort check below:
    // that port only knows configured threads, and the TUI opens a chat the moment
    // thread.create returns — before any provider is bound. Requiring a run-capable
    // thread here would make every freshly created chat unopenable.
    if (command.name === 'thread.select') return { decision: 'allow' }

    if (command.name === 'ensemble.seat.toggle') {
      const ensemble = ensembleForSeatControl(profileThread)
      if (!ensemble) {
        return { decision: 'deny', reason: 'standalone_ensemble_thread_required' }
      }
      if (ensembleRoundIsActive(ensemble)) {
        return { decision: 'deny', reason: 'standalone_ensemble_round_active' }
      }
      const participantId = command.arguments.participantId as string
      const participant = ensemble.participants.find((candidate) => candidate.id === participantId)
      if (!participant) {
        return { decision: 'deny', reason: 'standalone_ensemble_participant_not_found' }
      }
      if (
        participant.enabled &&
        command.arguments.enabled === false &&
        ensemble.participants.filter((candidate) => candidate.enabled).length <= 1
      ) {
        return { decision: 'deny', reason: 'standalone_ensemble_last_seat_required' }
      }
      return { decision: 'allow' }
    }

    if (command.name === 'composer.send' && profileThread.chatKind === 'ensemble') {
      return { decision: 'deny', reason: 'standalone_ensemble_round_unavailable' }
    }

    const thread = this.runPort.getThread(command.target.threadId)
    if (!thread) {
      return { decision: 'deny', reason: 'standalone_thread_required' }
    }
    if (command.name === 'composer.send') {
      if (!this.registry.hasProvider(thread.providerId)) {
        return { decision: 'deny', reason: 'standalone_provider_not_composed' }
      }
      const offers = this.cachedProviderOffers(thread.providerId)
      const metadata = (profileThread.providerMetadata ?? {}) as Record<string, unknown>
      const fullAccessOfferIsCurrent =
        metadata.permissionPresetId !== 'full_access' ||
        metadata.hostOfferRevision === offers?.offerRevision
      if (!fullAccessOfferIsCurrent) {
        this.fullAccessGrants.revokeThread(profileThread.appChatId)
      }
      if (
        !offers ||
        !fullAccessOfferIsCurrent ||
        !this.sendSelectionIsCurrent(thread, command.arguments, offers)
      ) {
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
    if (!(await this.prepareAuthorityEvaluation(context, command))) {
      return failed('provider_offers_unavailable')
    }
    const authority = this.evaluateAuthority(context, command)
    if (authority.decision !== 'allow') return failed('authority_denied')
    if (isSetupMutationName(command.name)) return this.setupExecutor.execute(command, context)
    const decoded = validateHostCommandArguments(command)
    if (!decoded.ok) return failed('command_invalid')

    if (isHostProfileRecordMutationName(command.name)) {
      if (isCanonicalId(command.target.threadId)) {
        this.fullAccessGrants.revokeThread(command.target.threadId)
      }
      return this.profileRecordExecutor.execute(decoded.value)
    }

    if (command.name === 'run.cancel') {
      const expectedWorkId = decoded.value.arguments.expectedWorkId
      const outcome = this.runPort.cancelThread(
        command.target.threadId,
        typeof expectedWorkId === 'string' ? expectedWorkId : undefined
      )
      return outcome === 'cancelled'
        ? { status: 'succeeded', resultSummary: 'run_cancellation_requested' }
        : failed(
            outcome === 'identity_mismatch'
              ? 'run_identity_mismatch'
              : outcome === 'not_found'
                ? 'run_not_found'
                : 'run_not_cancellable'
          )
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

    if (command.name === 'ensemble.seat.toggle') {
      return this.toggleEnsembleSeat(decoded.value)
    }

    // thread.select acknowledges a client-side thread switch. Unlike the desktop
    // Host — where it maps to setWatchedThread — this Host holds no watched-thread
    // state: its projection is whole-profile and history is fetched by explicit
    // threadId. Authority above already proved the thread is live, unarchived and
    // workspace-scoped, so there is nothing left to mutate. It must stay a no-op:
    // adopting a selection here would let one client move every other client's view.
    if (command.name === 'thread.select') {
      return { status: 'succeeded', resultSummary: 'thread_selected' }
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
      prompt: this.promptWithActiveGoal(command.target.threadId, command.arguments.text as string),
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

  /** Refresh dynamic provider offers before any composer-send authority decision. */
  async prepareAuthorityEvaluation(
    context: HostAuthorityCallContext,
    command: HostCommand
  ): Promise<boolean> {
    if (command.name !== 'composer.send' || !localContext(context, command)) return true
    const providerId = this.options.store.getThread(command.target.threadId)?.provider
    if (!isCanonicalId(providerId)) return true
    try {
      return Boolean(await this.registry.refreshOffers(providerId))
    } catch {
      return false
    }
  }

  private toggleEnsembleSeat(command: HostCommand): HostCommandExecutionResult {
    try {
      const current = this.options.store.getThread(command.target.threadId)
      if (!current || current.archived || current.scope !== 'workspace') {
        return failed('ensemble_thread_not_found')
      }
      const ensemble = ensembleForSeatControl(current)
      if (!ensemble) return failed('ensemble_thread_required')
      if (ensembleRoundIsActive(ensemble)) {
        return failed('ensemble_round_active')
      }
      const participantId = command.arguments.participantId as string
      const enabled = command.arguments.enabled as boolean
      const participant = ensemble.participants.find((candidate) => candidate.id === participantId)
      if (!participant) return failed('ensemble_participant_not_found')
      if (
        participant.enabled &&
        enabled === false &&
        ensemble.participants.filter((candidate) => candidate.enabled).length <= 1
      ) {
        return failed('ensemble_last_seat_required')
      }
      if (participant.enabled === enabled) {
        return { status: 'succeeded', resultSummary: 'ensemble_seat_unchanged' }
      }

      const participants = ensemble.participants.map((candidate) =>
        candidate.id === participantId ? { ...candidate, enabled } : candidate
      )
      this.options.store.persistThreadRecord({
        threadId: current.appChatId,
        expectedRevision: current.persistenceRevision ?? 0,
        record: {
          ...current,
          ensemble: {
            ...ensemble,
            participants,
            updatedAt: new Date(this.now()).toISOString()
          }
        }
      })
      return {
        status: 'succeeded',
        resultSummary: enabled ? 'ensemble_seat_enabled' : 'ensemble_seat_disabled'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'Thread persistence revision mismatch') {
        return failed('ensemble_seat_revision_conflict')
      }
      return failed('ensemble_seat_toggle_failed')
    }
  }

  private configureThread(input: {
    readonly threadId: string
    readonly chatKind?: 'single' | 'ensemble'
    readonly canonicalProviderId?: string
    readonly providerId?: string
    readonly modelId?: string
    readonly reasoningId?: string
    readonly postureId?: string
    readonly offerRevision?: string
    readonly postureConsent?: true
    readonly postureConsentProof?: string
    readonly postureConsentProvenance?: HostPermissionConsentRequest
    readonly title?: string
  }): { readonly threadId: string } {
    // An authority-bearing reconfiguration first revokes any active elevation.
    // A failed write stays revoked; profile bytes alone can never revive a grant.
    // Title-only edits do not change the exact run selection and retain it.
    if (
      input.chatKind !== undefined ||
      input.providerId !== undefined ||
      input.modelId !== undefined ||
      input.postureId !== undefined
    ) {
      this.fullAccessGrants.revokeThread(input.threadId)
    }
    if (input.chatKind !== undefined) {
      const thread = this.options.store.setThreadKind({
        threadId: input.threadId,
        targetKind: input.chatKind,
        ...(input.canonicalProviderId ? { canonicalProviderId: input.canonicalProviderId } : {})
      })
      return { threadId: thread.appChatId }
    }
    if (input.providerId !== undefined && !this.registry.hasProvider(input.providerId)) {
      throw new Error('Standalone Host does not compose that provider')
    }
    const postureId = input.postureId
    if (postureId !== undefined) {
      const offers = input.providerId ? this.cachedProviderOffers(input.providerId) : undefined
      const posture = offers?.postures.find((p) => p.postureId === postureId && p.available)
      if (!posture) throw new Error('Unknown posture')
    }
    let storedConsent: true | HostPermissionConsentEnvelope | undefined
    let verifiedFullAccess:
      | {
          readonly envelope: HostPermissionConsentEnvelope
          readonly provenance: NonNullable<ReturnType<HostPermissionConsentAuthorityPort['verify']>>
        }
      | undefined
    if (postureId === 'workspace_write' || postureId === 'full_access') {
      if (input.postureConsent !== true) throw new Error('Elevated posture requires consent')
      const request = input.postureConsentProvenance
      const authority = this.options.permissionConsentAuthority
      const current = this.options.store.getThread(input.threadId)
      const workspace = current?.workspaceId
        ? this.options.store
            .listWorkspaces()
            .find(
              (candidate) =>
                candidate.id === current.workspaceId &&
                (candidate.path === current.workspacePath ||
                  candidate.realPath === current.workspacePath)
            )
        : undefined
      const exactRequest = Boolean(
        request &&
        request.threadId === input.threadId &&
        request.providerId === input.providerId &&
        request.modelId === input.modelId &&
        request.postureId === postureId &&
        request.offerRevision === input.offerRevision
      )
      if (authority && request && current?.scope === 'workspace' && workspace && exactRequest) {
        const { commandFingerprint: _commandFingerprint, ...proofRequest } = request
        if (
          postureId === 'full_access' &&
          !authority.verifyRequestProof(proofRequest, input.postureConsentProof)
        ) {
          throw new Error('Full-access posture requires live user-presence proof')
        }
        storedConsent = authority.issue({
          ...request,
          workspaceId: workspace.id,
          workspacePath: workspace.realPath
        })
        if (postureId === 'full_access') {
          const provenance = authority.verify(storedConsent, {
            threadId: input.threadId,
            providerId: request.providerId,
            workspaceId: workspace.id,
            workspacePath: workspace.realPath,
            modelId: request.modelId,
            postureId,
            offerRevision: request.offerRevision
          })
          if (!provenance) throw new Error('Full-access consent verification failed')
          verifiedFullAccess = { envelope: storedConsent, provenance }
        }
      } else if (postureId === 'full_access') {
        throw new Error('Full-access posture requires authenticated signed consent')
      } else {
        storedConsent = true
      }
    }
    const thread = this.options.store.configureThread({
      threadId: input.threadId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.reasoningId ? { reasoningId: input.reasoningId } : {}),
      ...(postureId
        ? {
            postureId: postureId as
              | 'read_only'
              | 'plan'
              | 'default'
              | 'workspace_write'
              | 'full_access'
          }
        : {}),
      ...(input.offerRevision ? { offerRevision: input.offerRevision } : {}),
      ...(storedConsent ? { postureConsent: storedConsent } : {}),
      ...(input.title ? { title: input.title } : {})
    })
    if (verifiedFullAccess) {
      this.fullAccessGrants.activateVerified(
        verifiedFullAccess.envelope,
        verifiedFullAccess.provenance
      )
    }
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
    for (const thread of this.options.store.listThreadSummaries()) {
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
    const offers = this.cachedProviderOffers(thread.providerId)
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
    this.fullAccessGrants.clear()
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

import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentDispatchConsumption,
  type ChannelAgentDispatchConsumptionResult
} from './ChannelAgentAuthorityState'
import type { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import {
  createChannelAgentDispatchConsumptionInput,
  createChannelAgentRunAuthoritySeal,
  type ChannelAgentDispatchPlan,
  type ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalBinding,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type { ChannelAgentDispatchJournalStore } from './ChannelAgentDispatchJournalStore'
import type {
  ChannelAgentRunCollectionBinding,
  ChannelAgentRunCollectionHandle,
  ChannelAgentRunEventCollector,
  ChannelAgentRunTerminalEvidence
} from './ChannelAgentRunEventCollector'
import type {
  AgentRunPayload,
  RunAdapterInvocationReceipt,
  RunDispatchObserver
} from '../run/AgentRunTypes'

export type ChannelAgentRunLaunchRegistryErrorCode =
  | 'authorization_failed'
  | 'consumption_intent_unknown'
  | 'consumption_unknown'
  | 'duplicate_run'
  | 'invalid_registration'
  | 'launch_already_attempted'
  | 'launch_confirmation_unknown'
  | 'launch_intent_unknown'
  | 'launch_not_confirmed'
  | 'release_forbidden'
  | 'run_unavailable'

export class ChannelAgentRunLaunchRegistryError extends Error {
  constructor(
    readonly code: ChannelAgentRunLaunchRegistryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentRunLaunchRegistryError'
  }
}

export type ChannelAgentRunLaunchStatus =
  | 'registered'
  | 'authorization_failed'
  | 'consumption_intent_unknown'
  | 'consumption_unknown'
  | 'launch_intent_unknown'
  | 'launching'
  | 'launch_confirmation_unknown'
  | 'confirmed'
  | 'released'

export interface ChannelAgentRunLaunchRegistrationInput {
  readonly dispatchId: string
  readonly plan: ChannelAgentDispatchPlan
  /** Exact main-owned payload returned by the isolated Channel composer. */
  readonly expectedPayload: AgentRunPayload
}

export interface ChannelAgentRunLaunchRegistration {
  readonly runId: string
  readonly terminal: Promise<ChannelAgentRunTerminalEvidence>
  /**
   * Bound hook for the last main-owned barrier immediately before adapter.run.
   * It rechecks time/payload authority and durably spends the grant here.
   */
  authorizeBeforeAdapterRun(payload: AgentRunPayload): ChannelAgentRunAuthoritySeal
  /** Bound acknowledgement passed to RunCoordinator for this exact dispatch. */
  readonly observer: RunDispatchObserver
  status(): ChannelAgentRunLaunchStatus
  requireLaunchConfirmed(): ChannelAgentRunAuthoritySeal
  /** Use only after dispatch returns without reaching the adapter barrier. */
  releaseBeforeLaunch(): void
  /** Use after the terminal promise resolves and its evidence is durably handled. */
  releaseAfterTerminal(): void
  /** Drop process-local tracking while preserving an ambiguous durable journal. */
  releaseForRecovery(): void
}

type AuthorityPort = Pick<ChannelAgentAuthorityStore, 'consumeDispatch'>

type JournalPort = Pick<
  ChannelAgentDispatchJournalStore,
  'snapshot' | 'beginConsumption' | 'commitConsumption' | 'beginLaunch' | 'confirmLaunch'
>

type CollectorPort = Pick<ChannelAgentRunEventCollector, 'track' | 'confirmAdapterInvocation'>

export interface ChannelAgentRunLaunchRegistryOptions {
  readonly authority: AuthorityPort
  readonly journal: JournalPort
  readonly collector: CollectorPort
  readonly now?: () => number
}

interface PreparedRegistration {
  readonly dispatchId: string
  readonly plan: ChannelAgentDispatchPlan
  readonly expectedPayload: AgentRunPayload
  readonly journalBinding: ChannelAgentDispatchJournalBinding
  readonly collectionBinding: ChannelAgentRunCollectionBinding
}

interface LaunchEntry extends PreparedRegistration {
  status: ChannelAgentRunLaunchStatus
  seal: ChannelAgentRunAuthoritySeal | null
  terminalSettled: boolean
  readonly collection: ChannelAgentRunCollectionHandle
}

function registryError(
  code: ChannelAgentRunLaunchRegistryErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentRunLaunchRegistryError {
  // Journal/provider errors can contain paths or payload bytes. Public errors
  // remain bounded to static registry-owned copy.
  return new ChannelAgentRunLaunchRegistryError(code, message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function normalizedWorkspacePath(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function expectedConsumption(
  plan: ChannelAgentDispatchPlan,
  at: number
): ChannelAgentDispatchConsumption {
  return {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    recordedRevision: plan.authorityRevision + 1,
    channelId: plan.channelId,
    grantId: plan.dispatchGrant.grant.grantId,
    triggerMessageId: plan.triggerMessageId,
    mentionerMemberId: plan.mentionerMemberId,
    workspaceIdentityHash: plan.workspaceIdentityHash,
    permissionPostureHash: plan.permissionPostureHash,
    dispatchOrdinal: plan.expectedDispatchOrdinal,
    consumedAt: at
  }
}

function restoredState(
  snapshot: ChannelAgentDispatchJournalSnapshot,
  code: ChannelAgentRunLaunchRegistryErrorCode,
  message: string
): ChannelAgentDispatchJournalState {
  try {
    return ChannelAgentDispatchJournalState.restore(snapshot)
  } catch (error) {
    throw registryError(code, message, error)
  }
}

/**
 * Process-local bridge between one reserved Channel dispatch and the generic
 * provider lifecycle. The grant is not spent during composition or preflight:
 * the bound final barrier journals consumption intent, atomically consumes the
 * current authority, commits that evidence, and writes launch intent before an
 * adapter can run. The later observer never throws (RunCoordinator deliberately
 * swallows observer errors); requireLaunchConfirmed() therefore makes any
 * ambiguous acknowledgement fail closed before terminal signing.
 */
export class ChannelAgentRunLaunchRegistry {
  private readonly entries = new Map<string, LaunchEntry>()
  private readonly now: () => number

  constructor(private readonly options: ChannelAgentRunLaunchRegistryOptions) {
    if (
      !options ||
      typeof options.authority?.consumeDispatch !== 'function' ||
      typeof options.journal?.snapshot !== 'function' ||
      typeof options.journal?.beginConsumption !== 'function' ||
      typeof options.journal?.commitConsumption !== 'function' ||
      typeof options.journal?.beginLaunch !== 'function' ||
      typeof options.journal?.confirmLaunch !== 'function' ||
      typeof options.collector?.track !== 'function' ||
      typeof options.collector?.confirmAdapterInvocation !== 'function'
    ) {
      throw registryError(
        'invalid_registration',
        'Channel agent launch registry dependencies are unavailable'
      )
    }
    this.now = options.now ?? Date.now
  }

  register(input: ChannelAgentRunLaunchRegistrationInput): ChannelAgentRunLaunchRegistration {
    const prepared = this.prepare(input)
    if (this.entries.has(prepared.collectionBinding.runId)) {
      throw registryError('duplicate_run', 'Channel agent run is already registered for launch')
    }

    let collection: ChannelAgentRunCollectionHandle
    try {
      collection = this.options.collector.track(prepared.collectionBinding)
    } catch (error) {
      throw registryError(
        'invalid_registration',
        'Channel agent terminal collection could not be registered',
        error
      )
    }
    const entry: LaunchEntry = {
      ...prepared,
      status: 'registered',
      seal: null,
      terminalSettled: false,
      collection
    }
    this.entries.set(entry.collectionBinding.runId, entry)
    void collection.terminal.then(() => {
      entry.terminalSettled = true
    })

    const observer: RunDispatchObserver = Object.freeze({
      onAdapterInvoked: (receipt: RunAdapterInvocationReceipt) => {
        this.observeAdapterInvocation(entry, receipt)
      }
    })
    return Object.freeze({
      runId: entry.collectionBinding.runId,
      terminal: collection.terminal,
      authorizeBeforeAdapterRun: (payload: AgentRunPayload) => this.authorize(entry, payload),
      observer,
      status: () => entry.status,
      requireLaunchConfirmed: () => this.requireConfirmed(entry),
      releaseBeforeLaunch: () => this.releaseBeforeLaunch(entry),
      releaseAfterTerminal: () => this.releaseAfterTerminal(entry),
      releaseForRecovery: () => this.releaseForRecovery(entry)
    })
  }

  pendingCount(): number {
    return this.entries.size
  }

  private prepare(input: ChannelAgentRunLaunchRegistrationInput): PreparedRegistration {
    if (
      !input ||
      typeof input.dispatchId !== 'string' ||
      !input.dispatchId ||
      !input.plan ||
      !input.expectedPayload
    ) {
      throw registryError('invalid_registration', 'Channel agent launch registration is invalid')
    }
    let snapshot: ChannelAgentDispatchJournalSnapshot | null
    try {
      snapshot = this.options.journal.snapshot(input.plan.channelId, input.dispatchId)
    } catch (error) {
      throw registryError(
        'invalid_registration',
        'Reserved Channel agent dispatch journal is unavailable',
        error
      )
    }
    if (!snapshot) {
      throw registryError(
        'invalid_registration',
        'Reserved Channel agent dispatch journal is unavailable'
      )
    }
    const state = restoredState(
      snapshot,
      'invalid_registration',
      'Reserved Channel agent dispatch journal is invalid'
    )
    const binding = state.binding()
    let expectedBinding: ChannelAgentDispatchJournalBinding
    try {
      expectedBinding = ChannelAgentDispatchJournalState.reserve(
        input.plan,
        binding.reservedAt
      ).binding()
    } catch (error) {
      throw registryError(
        'invalid_registration',
        'Channel agent plan does not match its durable reservation',
        error
      )
    }
    if (
      binding.dispatchId !== input.dispatchId ||
      state.phase() !== 'reserved' ||
      !sameJson(binding, expectedBinding)
    ) {
      throw registryError(
        'invalid_registration',
        'Channel agent registration does not match its durable reservation'
      )
    }

    // Validate all payload bindings without spending authority. The real time
    // and consumption are recomputed at the final adapter barrier.
    let preliminarySeal: ChannelAgentRunAuthoritySeal
    try {
      const candidate = expectedConsumption(input.plan, binding.reservedAt)
      preliminarySeal = createChannelAgentRunAuthoritySeal({
        plan: input.plan,
        consumption: candidate,
        expectedPayload: input.expectedPayload,
        launchPayload: input.expectedPayload,
        launchedAt: candidate.consumedAt
      })
    } catch (error) {
      throw registryError(
        'invalid_registration',
        'Channel agent expected launch payload is invalid',
        error
      )
    }
    if (preliminarySeal.runId !== binding.runId) {
      throw registryError(
        'invalid_registration',
        'Channel agent expected launch identity changed after reservation'
      )
    }

    return {
      dispatchId: input.dispatchId,
      plan: clone(input.plan),
      expectedPayload: clone(input.expectedPayload),
      journalBinding: binding,
      collectionBinding: {
        runId: binding.runId,
        chatId: binding.chatId,
        provider: preliminarySeal.provider,
        workspacePath: normalizedWorkspacePath(input.expectedPayload.workspace),
        // Collection is reserved before generic preflight so synchronous adapter
        // output cannot race registration. The durable journal below owns the
        // exact later launch-intent timestamp.
        launchIntentAt: binding.reservedAt,
        maxPostBytes: binding.maxPostBytes
      }
    }
  }

  private authorize(entry: LaunchEntry, payload: AgentRunPayload): ChannelAgentRunAuthoritySeal {
    this.requireAvailable(entry)
    if (entry.status !== 'registered') {
      throw registryError(
        'launch_already_attempted',
        'Channel agent adapter launch authority was already attempted'
      )
    }
    const launchedAt = this.now()
    let consumeInput: ReturnType<typeof createChannelAgentDispatchConsumptionInput>
    let predictedConsumption: ChannelAgentDispatchConsumption
    try {
      if (!isTimestamp(launchedAt)) throw new Error('invalid clock')
      consumeInput = createChannelAgentDispatchConsumptionInput(entry.plan, launchedAt)
      predictedConsumption = expectedConsumption(entry.plan, launchedAt)
      createChannelAgentRunAuthoritySeal({
        plan: entry.plan,
        consumption: predictedConsumption,
        expectedPayload: entry.expectedPayload,
        launchPayload: payload,
        launchedAt
      })
    } catch (error) {
      entry.status = 'authorization_failed'
      throw registryError(
        'authorization_failed',
        'Channel agent launch authority is no longer current at the provider barrier',
        error
      )
    }

    // A persistence failure can mean the mutation happened but its result
    // could not be proven. Set every unknown state before its write and never
    // retry inside this process.
    entry.status = 'consumption_intent_unknown'
    try {
      const snapshot = this.options.journal.beginConsumption(
        entry.plan.channelId,
        entry.dispatchId,
        entry.plan,
        launchedAt
      )
      this.assertJournalPhase(snapshot, entry, 'consuming', 'consumption_intent_unknown')
      const intent = snapshot.events.at(-1)
      if (
        intent?.kind !== 'consumption.intent' ||
        intent.at !== launchedAt ||
        intent.authorityRevision !== entry.plan.authorityRevision ||
        intent.expectedDispatchOrdinal !== entry.plan.expectedDispatchOrdinal
      ) {
        throw registryError(
          'consumption_intent_unknown',
          'Channel agent consumption intent could not be proven durable'
        )
      }
    } catch (error) {
      throw this.asRegistryError(
        error,
        'consumption_intent_unknown',
        'Channel agent consumption intent could not be proven durable'
      )
    }

    entry.status = 'consumption_unknown'
    let result: ChannelAgentDispatchConsumptionResult
    try {
      result = this.options.authority.consumeDispatch(entry.plan.channelId, consumeInput)
    } catch (error) {
      throw registryError(
        'consumption_unknown',
        'Channel agent dispatch consumption outcome is unknown',
        error
      )
    }
    if (result.kind !== 'authorized') {
      const message =
        result.kind === 'duplicate'
          ? 'Channel agent trigger consumption requires recovery'
          : 'Channel agent dispatch authority was denied at launch'
      throw registryError(
        result.kind === 'duplicate' ? 'consumption_unknown' : 'authorization_failed',
        message
      )
    }
    if (
      !sameJson(result.delegation, entry.plan.delegation) ||
      !sameJson(result.dispatchGrant, entry.plan.dispatchGrant) ||
      !sameJson(result.consumption, predictedConsumption)
    ) {
      throw registryError(
        'consumption_unknown',
        'Channel agent dispatch consumption changed after planning'
      )
    }

    try {
      const snapshot = this.options.journal.commitConsumption(
        entry.plan.channelId,
        entry.dispatchId,
        result.consumption
      )
      this.assertJournalPhase(snapshot, entry, 'consumed', 'consumption_unknown')
      const consumptionEvent = snapshot.events.at(-1)
      if (
        consumptionEvent?.kind !== 'consumption.committed' ||
        !sameJson(consumptionEvent.consumption, result.consumption)
      ) {
        throw registryError(
          'consumption_unknown',
          'Channel agent dispatch consumption could not be proven durable'
        )
      }
    } catch (error) {
      throw this.asRegistryError(
        error,
        'consumption_unknown',
        'Channel agent dispatch consumption could not be proven durable'
      )
    }

    let seal: ChannelAgentRunAuthoritySeal
    try {
      seal = createChannelAgentRunAuthoritySeal({
        plan: entry.plan,
        consumption: result.consumption,
        expectedPayload: entry.expectedPayload,
        launchPayload: payload,
        launchedAt
      })
    } catch (error) {
      throw registryError(
        'consumption_unknown',
        'Consumed Channel agent launch authority changed before sealing',
        error
      )
    }

    entry.status = 'launch_intent_unknown'
    try {
      const snapshot = this.options.journal.beginLaunch(
        entry.plan.channelId,
        entry.dispatchId,
        seal
      )
      this.assertJournalPhase(snapshot, entry, 'launching', 'launch_intent_unknown')
      const launchEvent = snapshot.events.at(-1)
      if (launchEvent?.kind !== 'launch.intent' || !sameJson(launchEvent.seal, seal)) {
        throw registryError(
          'launch_intent_unknown',
          'Channel agent launch intent could not be proven durable'
        )
      }
    } catch (error) {
      throw this.asRegistryError(
        error,
        'launch_intent_unknown',
        'Channel agent launch intent could not be proven durable'
      )
    }
    entry.seal = clone(seal)
    entry.status = 'launching'
    return clone(seal)
  }

  private observeAdapterInvocation(entry: LaunchEntry, receipt: RunAdapterInvocationReceipt): void {
    try {
      this.confirmAdapterInvocation(entry, receipt)
    } catch {
      if (entry.status !== 'released') entry.status = 'launch_confirmation_unknown'
      // RunDispatchObserver is observational by contract. The caller must invoke
      // requireLaunchConfirmed after dispatch, which surfaces this retained state.
    }
  }

  private confirmAdapterInvocation(entry: LaunchEntry, receipt: RunAdapterInvocationReceipt): void {
    this.requireAvailable(entry)
    if (
      entry.status !== 'launching' ||
      !entry.seal ||
      receipt?.appRunId !== entry.collectionBinding.runId ||
      receipt.provider !== entry.collectionBinding.provider ||
      normalizedWorkspacePath(receipt.effectiveWorkspacePath) !==
        entry.collectionBinding.workspacePath
    ) {
      throw registryError(
        'launch_confirmation_unknown',
        'Channel agent adapter invocation did not match its durable launch intent'
      )
    }
    const confirmedAt = this.now()
    if (!isTimestamp(confirmedAt) || confirmedAt < entry.seal.launchedAt) {
      throw registryError(
        'launch_confirmation_unknown',
        'Channel agent adapter invocation time is invalid'
      )
    }

    entry.status = 'launch_confirmation_unknown'
    let snapshot: ChannelAgentDispatchJournalSnapshot
    try {
      snapshot = this.options.journal.confirmLaunch(
        entry.plan.channelId,
        entry.dispatchId,
        confirmedAt
      )
    } catch (error) {
      throw registryError(
        'launch_confirmation_unknown',
        'Channel agent launch confirmation could not be proven durable',
        error
      )
    }
    this.assertJournalPhase(snapshot, entry, 'launched', 'launch_confirmation_unknown')
    const confirmation = snapshot.events.at(-1)
    if (confirmation?.kind !== 'launch.confirmed' || confirmation.at !== confirmedAt) {
      throw registryError(
        'launch_confirmation_unknown',
        'Channel agent launch confirmation could not be proven durable'
      )
    }
    try {
      this.options.collector.confirmAdapterInvocation(receipt, confirmedAt)
    } catch (error) {
      throw registryError(
        'launch_confirmation_unknown',
        'Channel agent terminal collector did not accept the launch receipt',
        error
      )
    }
    entry.status = 'confirmed'
  }

  private assertJournalPhase(
    snapshot: ChannelAgentDispatchJournalSnapshot,
    entry: LaunchEntry,
    phase: ReturnType<ChannelAgentDispatchJournalState['phase']>,
    code: ChannelAgentRunLaunchRegistryErrorCode
  ): void {
    const state = restoredState(snapshot, code, 'Channel agent dispatch journal is invalid')
    if (
      state.phase() !== phase ||
      state.binding().dispatchId !== entry.dispatchId ||
      state.binding().runId !== entry.collectionBinding.runId ||
      !sameJson(state.binding(), entry.journalBinding)
    ) {
      throw registryError(code, 'Channel agent dispatch journal transition is invalid')
    }
  }

  private asRegistryError(
    error: unknown,
    code: ChannelAgentRunLaunchRegistryErrorCode,
    message: string
  ): ChannelAgentRunLaunchRegistryError {
    return error instanceof ChannelAgentRunLaunchRegistryError && error.code === code
      ? error
      : registryError(code, message, error)
  }

  private requireConfirmed(entry: LaunchEntry): ChannelAgentRunAuthoritySeal {
    this.requireAvailable(entry)
    if (entry.status !== 'confirmed' || !entry.seal) {
      const code: ChannelAgentRunLaunchRegistryErrorCode =
        entry.status === 'consumption_intent_unknown'
          ? 'consumption_intent_unknown'
          : entry.status === 'consumption_unknown'
            ? 'consumption_unknown'
            : entry.status === 'launch_intent_unknown'
              ? 'launch_intent_unknown'
              : entry.status === 'launch_confirmation_unknown'
                ? 'launch_confirmation_unknown'
                : 'launch_not_confirmed'
      throw registryError(code, 'Channel agent provider launch is not exactly confirmed')
    }
    return clone(entry.seal)
  }

  private releaseBeforeLaunch(entry: LaunchEntry): void {
    this.requireAvailable(entry)
    if (entry.status !== 'registered' && entry.status !== 'authorization_failed') {
      throw registryError(
        'release_forbidden',
        'Channel agent launch cannot be released as a preflight decline'
      )
    }
    if (!entry.collection.stop()) {
      throw registryError(
        'release_forbidden',
        'Channel agent terminal collection ended before preflight release'
      )
    }
    this.release(entry)
  }

  private releaseAfterTerminal(entry: LaunchEntry): void {
    this.requireAvailable(entry)
    if (entry.status !== 'confirmed' || !entry.terminalSettled) {
      throw registryError(
        'release_forbidden',
        'Channel agent launch cannot be released before terminal evidence settles'
      )
    }
    entry.collection.stop()
    this.release(entry)
  }

  private releaseForRecovery(entry: LaunchEntry): void {
    this.requireAvailable(entry)
    if (
      entry.status !== 'consumption_intent_unknown' &&
      entry.status !== 'consumption_unknown' &&
      entry.status !== 'launch_intent_unknown' &&
      entry.status !== 'launching' &&
      entry.status !== 'launch_confirmation_unknown' &&
      !(entry.status === 'confirmed' && entry.terminalSettled)
    ) {
      throw registryError(
        'release_forbidden',
        'Channel agent launch has no ambiguous recovery state to release'
      )
    }
    entry.collection.stop()
    this.release(entry)
  }

  private release(entry: LaunchEntry): void {
    if (this.entries.get(entry.collectionBinding.runId) !== entry) {
      throw registryError('run_unavailable', 'Channel agent run registration is unavailable')
    }
    this.entries.delete(entry.collectionBinding.runId)
    entry.status = 'released'
  }

  private requireAvailable(entry: LaunchEntry): void {
    if (entry.status === 'released' || this.entries.get(entry.collectionBinding.runId) !== entry) {
      throw registryError('run_unavailable', 'Channel agent run registration is unavailable')
    }
  }
}

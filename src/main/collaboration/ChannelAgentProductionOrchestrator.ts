import type { RunEventAudienceLease, RunEventSink } from '../RunEventBus'
import type { RunSessionChangeEvent } from '../RunManager'
import type { ComposerService } from '../services/ComposerService'
import type { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import type { ChannelAgentDispatchPlan } from './ChannelAgentDispatchAuthority'
import {
  ChannelAgentDispatchCoordinator,
  type ChannelAgentDispatchCoordinatorOptions,
  type ChannelAgentDispatchCoordinatorResult
} from './ChannelAgentDispatchCoordinator'
import { ChannelAgentDispatchJournalState } from './ChannelAgentDispatchJournalState'
import type { ChannelAgentDispatchJournalStore } from './ChannelAgentDispatchJournalStore'
import type { ChannelAgentIdentityStore } from './ChannelAgentIdentityStore'
import { ChannelAgentRunComposer } from './ChannelAgentRunComposer'
import { ChannelAgentRunEventCollector } from './ChannelAgentRunEventCollector'
import { ChannelAgentRunLaunchRegistry } from './ChannelAgentRunLaunchRegistry'

type JournalPort = Pick<
  ChannelAgentDispatchJournalStore,
  | 'reserve'
  | 'snapshot'
  | 'beginConsumption'
  | 'commitConsumption'
  | 'beginLaunch'
  | 'confirmLaunch'
  | 'recordTerminal'
  | 'recordSignedPost'
  | 'recordPosted'
  | 'abandon'
  | 'complete'
>

type AuthorityPort = Pick<ChannelAgentAuthorityStore, 'consumeDispatch'>
type IdentityPort = Pick<ChannelAgentIdentityStore, 'load'>
type ComposePort = Pick<
  ComposerService,
  'composeMainOwnedChannelAgentRun'
>['composeMainOwnedChannelAgentRun']

export interface ChannelAgentProductionOrchestratorOptions {
  readonly journal: JournalPort
  readonly authority: AuthorityPort
  readonly identities: IdentityPort
  readonly composeMainOwnedChannelAgentRun: ComposePort
  readonly dispatch: ChannelAgentDispatchCoordinatorOptions['dispatch']
  readonly appendSignedPost: ChannelAgentDispatchCoordinatorOptions['appendSignedPost']
  readonly audit: ChannelAgentDispatchCoordinatorOptions['audit']
  readonly subscribeRunEvents: (sink: RunEventSink) => () => void
  readonly subscribeRunSessions: (listener: (event: RunSessionChangeEvent) => void) => () => void
  readonly claimRunAudience: (runId: string, sinkIds: readonly string[]) => RunEventAudienceLease
  readonly now?: () => number
}

export type ChannelAgentProductionOrchestratorState = 'idle' | 'running' | 'stopped'

export interface ChannelAgentProductionOrchestratorStatus {
  readonly state: ChannelAgentProductionOrchestratorState
  readonly pendingDispatches: number
  readonly pendingTerminalCollections: number
  /** Claims remain fail-closed until the process-level run bus is reset. */
  readonly restrictedRunCount: number
}

export type ChannelAgentProductionOrchestratorErrorCode =
  | 'audience_unavailable'
  | 'busy'
  | 'invalid_options'
  | 'not_running'
  | 'subscription_unavailable'

export class ChannelAgentProductionOrchestratorError extends Error {
  constructor(
    readonly code: ChannelAgentProductionOrchestratorErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentProductionOrchestratorError'
  }
}

function orchestratorError(
  code: ChannelAgentProductionOrchestratorErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentProductionOrchestratorError {
  // Subscriber/provider errors may contain prompt, output, or local path bytes.
  return new ChannelAgentProductionOrchestratorError(code, message)
}

function safeUnsubscribe(unsubscribe: (() => void) | null): boolean {
  if (!unsubscribe) return true
  try {
    unsubscribe()
    return true
  } catch {
    return false
  }
}

function exactRunId(plan: ChannelAgentDispatchPlan): string {
  try {
    // The run id is independent of reservation time. Reusing the strict state
    // constructor at the earliest mutually valid instant avoids a second,
    // weaker projection of plan bindings without consuming the runtime clock.
    const bindingProofAt = Math.max(
      plan.delegation.delegation.notBefore,
      plan.dispatchGrant.grant.notBefore
    )
    return ChannelAgentDispatchJournalState.reserve(plan, bindingProofAt).binding().runId
  } catch (error) {
    throw orchestratorError(
      'audience_unavailable',
      'Channel agent run audience could not be derived',
      error
    )
  }
}

/**
 * Root-free production composition for the P3 execution path. The caller owns
 * the immutable review/source gate and may invoke dispatchPlan only after it
 * admits a durable human mention. This class owns no IPC, renderer, settings,
 * relay, or provider-history route.
 */
export class ChannelAgentProductionOrchestrator {
  private readonly collector: ChannelAgentRunEventCollector
  private readonly coordinator: ChannelAgentDispatchCoordinator
  private readonly audienceLeases = new Map<string, RunEventAudienceLease>()
  private stateValue: ChannelAgentProductionOrchestratorState = 'idle'
  private unsubscribeRunEvents: (() => void) | null = null
  private unsubscribeRunSessions: (() => void) | null = null

  constructor(private readonly options: ChannelAgentProductionOrchestratorOptions) {
    if (
      !options ||
      typeof options.subscribeRunEvents !== 'function' ||
      typeof options.subscribeRunSessions !== 'function' ||
      typeof options.claimRunAudience !== 'function'
    ) {
      throw orchestratorError(
        'invalid_options',
        'Channel agent production orchestration ports are unavailable'
      )
    }
    this.collector = new ChannelAgentRunEventCollector(
      options.now ? { now: options.now } : undefined
    )
    const composer = new ChannelAgentRunComposer({
      composeMainOwnedChannelAgentRun: options.composeMainOwnedChannelAgentRun
    })
    const launches = new ChannelAgentRunLaunchRegistry({
      authority: options.authority,
      journal: options.journal,
      collector: this.collector,
      ...(options.now ? { now: options.now } : {})
    })
    this.coordinator = new ChannelAgentDispatchCoordinator({
      journal: options.journal,
      identities: options.identities,
      composer,
      launches,
      dispatch: options.dispatch,
      appendSignedPost: options.appendSignedPost,
      audit: options.audit,
      ...(options.now ? { now: options.now } : {})
    })
  }

  start(): ChannelAgentProductionOrchestratorStatus {
    if (this.stateValue === 'stopped') {
      throw orchestratorError('not_running', 'Channel agent production orchestration has stopped')
    }
    if (this.stateValue === 'running') return this.status()

    let unsubscribeEvents: (() => void) | null = null
    try {
      unsubscribeEvents = this.options.subscribeRunEvents(this.collector)
      if (typeof unsubscribeEvents !== 'function') throw new Error('invalid event subscription')
      const unsubscribeSessions = this.options.subscribeRunSessions((event) => {
        this.collector.handleRunSessionChange(event)
      })
      if (typeof unsubscribeSessions !== 'function') throw new Error('invalid session subscription')
      this.unsubscribeRunEvents = unsubscribeEvents
      this.unsubscribeRunSessions = unsubscribeSessions
      this.stateValue = 'running'
      return this.status()
    } catch (error) {
      safeUnsubscribe(unsubscribeEvents)
      throw orchestratorError(
        'subscription_unavailable',
        'Channel agent run evidence subscriptions are unavailable',
        error
      )
    }
  }

  async dispatchPlan(
    plan: ChannelAgentDispatchPlan
  ): Promise<ChannelAgentDispatchCoordinatorResult> {
    if (this.stateValue !== 'running') {
      throw orchestratorError(
        'not_running',
        'Channel agent production orchestration is not running'
      )
    }
    const runId = exactRunId(plan)
    this.requireAudience(runId)
    return this.coordinator.run(plan)
  }

  status(): ChannelAgentProductionOrchestratorStatus {
    return {
      state: this.stateValue,
      pendingDispatches: this.coordinator.pendingCount(),
      pendingTerminalCollections: this.collector.pendingCount(),
      restrictedRunCount: this.audienceLeases.size
    }
  }

  dispose(): void {
    if (this.stateValue === 'stopped') return
    if (this.coordinator.pendingCount() !== 0 || this.collector.pendingCount() !== 0) {
      throw orchestratorError(
        'busy',
        'Channel agent production orchestration still owns active runs'
      )
    }
    const sessionsReleased = safeUnsubscribe(this.unsubscribeRunSessions)
    const eventsReleased = safeUnsubscribe(this.unsubscribeRunEvents)
    this.unsubscribeRunSessions = null
    this.unsubscribeRunEvents = null
    this.stateValue = 'stopped'
    // Audience leases intentionally outlive this service object. Releasing one
    // while a provider can still emit a late event would reopen renderer/remote
    // fan-out. The process-owned RunEventBus resets them at process teardown.
    if (!sessionsReleased || !eventsReleased) {
      throw orchestratorError(
        'subscription_unavailable',
        'Channel agent run evidence subscriptions could not be released'
      )
    }
  }

  private requireAudience(runId: string): RunEventAudienceLease {
    const existing = this.audienceLeases.get(runId)
    if (existing) return existing
    let lease: RunEventAudienceLease
    try {
      lease = this.options.claimRunAudience(runId, [this.collector.id])
    } catch (error) {
      throw orchestratorError(
        'audience_unavailable',
        'Channel agent run event audience is unavailable',
        error
      )
    }
    if (
      !lease ||
      lease.runId !== runId ||
      lease.sinkIds.length !== 1 ||
      lease.sinkIds[0] !== this.collector.id ||
      typeof lease.release !== 'function'
    ) {
      try {
        lease?.release?.()
      } catch {
        // A malformed audience port remains fail-closed.
      }
      throw orchestratorError(
        'audience_unavailable',
        'Channel agent run event audience could not be confirmed'
      )
    }
    this.audienceLeases.set(runId, lease)
    return lease
  }
}

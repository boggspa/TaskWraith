/**
 * Short-start publication coordinator (Independent Threads Programme M2 / A1.3).
 *
 * Correlates a Host-native `composer.send` with the ORIGINAL pending receipt
 * (commandId + authenticated actor + canonical fingerprint). Admission and
 * persisted-start waits stay OFF the projection queue. Journal appends for
 * start effects MUST run inside `runProjectionOperation` so they cannot land
 * inside an unrelated legacy command's before/after observation window.
 *
 * Success is NOT `onStarted`. `markStarted` fires in `beginRun` before the
 * provider appends the user prompt; the legacy persist poll required BOTH a
 * running row and that user message. The coordinator therefore completes
 * only after DomainPorts reports a settled dispatch that already waited for
 * that persist boundary, then publishes exactly two correlated upserts:
 * the run whose entityId is this commandId, and the thread whose entityId
 * is command.target.threadId. Success requires BOTH (Domain's persist
 * proof is the run row plus the user message, which the thread projection
 * carries as messageCount/updatedAt). Other same-thread runs are not
 * admitted. Command-local scope is still used to READ the donor, but
 * BEFORE is captured before ACK/capacity/persist waits, so a full scoped
 * diff would misattribute concurrent same-thread mutations.
 * Excluded observation keys are listed exhaustively. `channel` is omitted
 * because HostDomainDeltaPublisher.DOMAIN_EFFECT_FAMILIES rejects it
 * (out of this grant). `onStarted` never succeeds a receipt and never
 * mints a second one.
 *
 * Receipt phase is stored/projected by HostCommandReceiptStore and advanced
 * here without changing receipt status. `openHostNodeQueuedStartExecutionClaimStore`
 * still has no production caller; HostMainComposition (in-main desktop) is not wired —
 * standalone HostNodeProductionServer is the production short-start route.
 * Flag default remains OFF.
 */

import type {
  HostCommand,
  HostCursorPosition,
  HostDeltaFamily,
  HostQueuedStartPhase
} from '../shared/hostProtocol'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostDomainDeltaPublishResult, HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type {
  HostCommandReceiptActor,
  HostCommandReceiptCompleteInput,
  HostCommandReceiptLookupResult,
  HostCommandReceiptMarkIndeterminateInput,
  HostCommandReceiptMarkIndeterminateResult,
  HostCommandReceiptPhaseUpdateResult,
  HostCommandReceiptRecord
} from './HostCommandReceiptStore'
import type {
  HostMutationObservationFamilies,
  HostMutationObservationScope
} from './HostMutationObservationScope'
import { scopeHostMutationObservationFamilies } from './HostMutationObservationScope'
import type { HostProjectionOperationRunner } from './HostProjectionSerialQueue'

/** Narrow view accepted from the queued-start lifecycle `onStarted` hook. */
export interface HostQueuedStartStartedView {
  readonly commandId: string
  readonly threadId: string
  readonly fingerprint: string
  readonly phase: 'queued' | 'starting' | 'started'
  readonly startedEvidence: boolean
  readonly terminalOutcome: string | null
}

export interface HostQueuedStartPublicationRegisterInput {
  readonly commandId: string
  readonly actor: HostCommandReceiptActor
  readonly fingerprint: string
  readonly command: HostCommand
  readonly beforeScoped: HostMutationObservationFamilies
  readonly scope: HostMutationObservationScope
}

export interface HostQueuedStartPublicationPorts {
  readonly getReceipt: (
    commandId: string,
    actor: HostCommandReceiptActor
  ) => HostCommandReceiptLookupResult
  readonly completeReceipt: (
    input: HostCommandReceiptCompleteInput
  ) => HostCommandReceiptRecord | null
  readonly markIndeterminate: (
    input: HostCommandReceiptMarkIndeterminateInput
  ) => HostCommandReceiptMarkIndeterminateResult
  readonly updateReceiptPhase: (
    commandId: string,
    phase: HostQueuedStartPhase
  ) => HostCommandReceiptPhaseUpdateResult
  readonly readScopedFamilies: (
    scope: HostMutationObservationScope
  ) => HostMutationObservationFamilies | Promise<HostMutationObservationFamilies>
  readonly publishEffects: (
    effects: readonly HostDomainEffectDto[]
  ) => HostDomainDeltaPublishResult | Promise<HostDomainDeltaPublishResult>
  readonly getPosition: () => HostCursorPosition
  readonly runProjectionOperation?: HostProjectionOperationRunner
  readonly now?: () => string
}

export type HostQueuedStartPublicationOutcome =
  | { readonly kind: 'registered' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'started' }
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'indeterminate'; readonly errorCode: string }
  | { readonly kind: 'ignored'; readonly reason: string }

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'denied', 'cancelled', 'indeterminate'])

/**
 * composer.send start persists a run row and the user prompt on the thread
 * record. The publisher emits only those two rows: run entityId ===
 * commandId and thread entityId === command.target.threadId. Success
 * requires both upserts; a run-only batch is incomplete.
 *
 * Not start effects (concurrent same-thread writes during the off-queue wait
 * must not be attributed here): missions, rounds, participants, providers,
 * questions, approvals, schedules, artifacts, workspaces.
 * Singletons health/routing/usage/warnings are likewise excluded.
 * `channel` is excluded twice: it is not a start write, AND emitting it
 * would be rejected by HostDomainDeltaPublisher.DOMAIN_EFFECT_FAMILIES
 * (adding `channel` there is a separate grant).
 */
export const QUEUED_START_EFFECT_FAMILIES = [
  'run',
  'thread'
] as const satisfies readonly HostDeltaFamily[]

type ObservationKey = keyof HostMutationObservationFamilies
type StartEffectDonorKey = 'runs' | 'threads'

export const QUEUED_START_EXCLUDED_OBSERVATION_KEYS = {
  health: true,
  workspaces: true,
  missions: true,
  rounds: true,
  participants: true,
  providers: true,
  routing: true,
  questions: true,
  approvals: true,
  schedules: true,
  channels: true,
  usage: true,
  artifacts: true,
  warnings: true
} as const satisfies { [K in Exclude<ObservationKey, StartEffectDonorKey>]: true }

type FamilySpec = {
  readonly family: (typeof QUEUED_START_EFFECT_FAMILIES)[number]
  readonly rows: (families: HostMutationObservationFamilies) => readonly object[]
  readonly id: (row: object) => string | null
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function idOf(row: object, key: string): string | null {
  const value = (row as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const START_EFFECT_FAMILY_SPECS: readonly FamilySpec[] = [
  { family: 'run', rows: (families) => families.runs, id: (row) => idOf(row, 'runId') },
  { family: 'thread', rows: (families) => families.threads, id: (row) => idOf(row, 'id') }
]

function upsert(
  family: HostDomainEffectDto['family'],
  entityId: string,
  payload: unknown
): HostDomainEffectDto {
  return { kind: 'upsert', family, entityId, payload: cloneJson(payload) }
}

function tombstone(family: HostDomainEffectDto['family'], entityId: string): HostDomainEffectDto {
  return { kind: 'tombstone', family, entityId }
}

export interface HostQueuedStartEffectIdentity {
  readonly commandId: string
  readonly threadId: string
}

function uniqueRowWithId(
  rows: readonly object[],
  idOfRow: (row: object) => string | null,
  entityId: string
): { kind: 'none' } | { kind: 'one'; row: object } | { kind: 'duplicate' } {
  let found: object | undefined
  for (const row of rows) {
    if (idOfRow(row) !== entityId) continue
    if (found) return { kind: 'duplicate' }
    found = row
  }
  return found ? { kind: 'one', row: found } : { kind: 'none' }
}

export type HostQueuedStartDiffResult =
  | { readonly kind: 'effects'; readonly effects: readonly HostDomainEffectDto[] }
  | { readonly kind: 'incoherent'; readonly reason: 'duplicate_entity_id' }

/**
 * Diff only the command-correlated start rows: this command's run and the
 * target thread. Other same-thread runs are ignored even when they change
 * during the off-queue wait. Duplicate exact-id AFTER (or BEFORE) rows fail
 * closed — success requires one unambiguous donor row per admitted identity.
 * Payloads come from the scoped donor, never from command intent.
 */
export function diffScopedStartEffects(
  before: HostMutationObservationFamilies,
  after: HostMutationObservationFamilies,
  identity: HostQueuedStartEffectIdentity
): HostQueuedStartDiffResult {
  const effects: HostDomainEffectDto[] = []
  for (const spec of START_EFFECT_FAMILY_SPECS) {
    const entityId = spec.family === 'run' ? identity.commandId : identity.threadId
    const left = uniqueRowWithId(spec.rows(before), spec.id, entityId)
    const right = uniqueRowWithId(spec.rows(after), spec.id, entityId)
    if (left.kind === 'duplicate' || right.kind === 'duplicate') {
      return { kind: 'incoherent', reason: 'duplicate_entity_id' }
    }
    const leftRow = left.kind === 'one' ? left.row : undefined
    const rightRow = right.kind === 'one' ? right.row : undefined
    if (!leftRow && rightRow) effects.push(upsert(spec.family, entityId, rightRow))
    else if (leftRow && !rightRow) effects.push(tombstone(spec.family, entityId))
    else if (leftRow && rightRow && JSON.stringify(leftRow) !== JSON.stringify(rightRow)) {
      effects.push(upsert(spec.family, entityId, rightRow))
    }
  }
  return { kind: 'effects', effects }
}

/** Start proof: run upsert for commandId AND thread upsert for target.threadId. */
export function provesQueuedStartEffects(
  effects: readonly HostDomainEffectDto[],
  identity: HostQueuedStartEffectIdentity
): boolean {
  const runUpsert = effects.some(
    (effect) =>
      effect.family === 'run' && effect.kind === 'upsert' && effect.entityId === identity.commandId
  )
  const threadUpsert = effects.some(
    (effect) =>
      effect.family === 'thread' &&
      effect.kind === 'upsert' &&
      effect.entityId === identity.threadId
  )
  return runUpsert && threadUpsert
}

export function createHostQueuedStartStartedSlot(): {
  dispatchStarting(view: HostQueuedStartStartedView): void
  dispatch(view: HostQueuedStartStartedView): void
  dispatchSettled(commandId: string, result: HostCommandExecutionResult): void
  bindStarting(handler: (view: HostQueuedStartStartedView) => void): void
  bind(handler: (view: HostQueuedStartStartedView) => void): void
  bindSettled(handler: (commandId: string, result: HostCommandExecutionResult) => void): void
} {
  let onStarting: ((view: HostQueuedStartStartedView) => void) | null = null
  let onStarted: ((view: HostQueuedStartStartedView) => void) | null = null
  let onSettled: ((commandId: string, result: HostCommandExecutionResult) => void) | null = null
  return {
    dispatchStarting(view) {
      onStarting?.(view)
    },
    dispatch(view) {
      onStarted?.(view)
    },
    dispatchSettled(commandId, result) {
      onSettled?.(commandId, result)
    },
    bindStarting(next) {
      onStarting = next
    },
    bind(next) {
      onStarted = next
    },
    bindSettled(next) {
      onSettled = next
    }
  }
}

export function createHostQueuedStartPublication(ports: HostQueuedStartPublicationPorts): {
  register(input: HostQueuedStartPublicationRegisterInput): HostQueuedStartPublicationOutcome
  markQueued(commandId: string): HostQueuedStartPublicationOutcome
  onStarting(view: HostQueuedStartStartedView): HostQueuedStartPublicationOutcome
  onStarted(view: HostQueuedStartStartedView): void
  completeStart(commandId: string): void
  abort(commandId: string): void
  fail(commandId: string, result: HostCommandExecutionResult): void
  drain(): Promise<void>
  pendingCount(): number
  inFlightCount(): number
} {
  const pending = new Map<string, HostQueuedStartPublicationRegisterInput>()
  const inFlight = new Map<string, Promise<void>>()
  const now = ports.now ?? (() => new Date().toISOString())
  const runQueue: HostProjectionOperationRunner =
    ports.runProjectionOperation ?? ((operation) => operation())

  function ignoreTerminal(record: HostCommandReceiptRecord): boolean {
    return TERMINAL_STATUSES.has(record.status)
  }

  function track(commandId: string, work: Promise<void>): void {
    const wrapped = work
      .catch(() => {
        if (pending.has(commandId)) {
          promote(commandId, 'deferred_effects_unavailable')
        }
      })
      .finally(() => {
        inFlight.delete(commandId)
      })
    inFlight.set(commandId, wrapped)
  }

  function promote(
    commandId: string,
    errorCode: HostCommandReceiptMarkIndeterminateInput['errorCode']
  ): void {
    try {
      const position = ports.getPosition()
      ports.markIndeterminate({ commandId, position, errorCode, updatedAt: now() })
    } catch {
      // Contained: drain/fail must not reject.
    }
    pending.delete(commandId)
  }

  function stillPending(
    commandId: string,
    actor: HostCommandReceiptActor,
    fingerprint: string
  ): boolean {
    const found = ports.getReceipt(commandId, actor)
    if (found.kind !== 'found') {
      pending.delete(commandId)
      return false
    }
    if (ignoreTerminal(found.receipt) || found.receipt.status !== 'pending') {
      pending.delete(commandId)
      return false
    }
    if (found.receipt.commandFingerprint !== fingerprint) {
      promote(commandId, 'deferred_execution_may_have_begun')
      return false
    }
    return true
  }

  function advancePhase(
    input: HostQueuedStartPublicationRegisterInput,
    phase: HostQueuedStartPhase
  ): HostQueuedStartPublicationOutcome {
    if (!stillPending(input.commandId, input.actor, input.fingerprint)) {
      return { kind: 'ignored', reason: 'receipt_not_pending' }
    }
    let result: HostCommandReceiptPhaseUpdateResult
    try {
      result = ports.updateReceiptPhase(input.commandId, phase)
    } catch {
      promote(input.commandId, 'deferred_execution_may_have_begun')
      return { kind: 'indeterminate', errorCode: 'deferred_execution_may_have_begun' }
    }
    if (result.kind === 'updated' || result.kind === 'unchanged') {
      if (phase === 'queued') return { kind: 'queued' }
      if (phase === 'starting') return { kind: 'starting' }
      return { kind: 'started' }
    }
    if (result.kind === 'status_refused') {
      pending.delete(input.commandId)
      return { kind: 'ignored', reason: `receipt_${result.status}` }
    }
    promote(input.commandId, 'deferred_execution_may_have_begun')
    return { kind: 'indeterminate', errorCode: 'deferred_execution_may_have_begun' }
  }

  function phaseViewMatches(
    input: HostQueuedStartPublicationRegisterInput,
    view: HostQueuedStartStartedView,
    phase: HostQueuedStartPhase
  ): boolean {
    return (
      view.commandId === input.commandId &&
      view.threadId === input.command.target.threadId &&
      view.fingerprint === input.fingerprint &&
      view.phase === phase &&
      view.terminalOutcome === null
    )
  }

  async function publishComplete(input: HostQueuedStartPublicationRegisterInput): Promise<void> {
    if (!stillPending(input.commandId, input.actor, input.fingerprint)) return
    await runQueue(async () => {
      if (!stillPending(input.commandId, input.actor, input.fingerprint)) return
      let afterScoped: HostMutationObservationFamilies
      try {
        afterScoped = await ports.readScopedFamilies(input.scope)
      } catch {
        promote(input.commandId, 'observation_after_snapshot_capture_failed')
        return
      }
      const threadId = input.command.target.threadId
      if (typeof threadId !== 'string' || threadId.length === 0) {
        promote(input.commandId, 'observation_diff_incoherent')
        return
      }
      const identity = { commandId: input.commandId, threadId }
      const diffed = diffScopedStartEffects(input.beforeScoped, afterScoped, identity)
      if (diffed.kind !== 'effects' || !provesQueuedStartEffects(diffed.effects, identity)) {
        promote(input.commandId, 'observation_diff_incoherent')
        return
      }
      const effects = diffed.effects
      let published: HostDomainDeltaPublishResult
      try {
        published = await ports.publishEffects(effects)
      } catch {
        promote(input.commandId, 'deferred_effects_partial')
        return
      }
      if (published.kind !== 'published') {
        promote(
          input.commandId,
          published.kind === 'partial' ? 'deferred_effects_partial' : 'deferred_effects_unavailable'
        )
        return
      }
      try {
        const completed = ports.completeReceipt({
          commandId: input.commandId,
          status: 'succeeded',
          resultSummary: 'run_started',
          completedAt: now(),
          position: {
            generation: published.position.generation,
            cursor: published.position.cursor
          }
        })
        pending.delete(input.commandId)
        if (!completed) promote(input.commandId, 'deferred_execution_may_have_begun')
      } catch {
        promote(input.commandId, 'deferred_execution_may_have_begun')
      }
    }, 'queued-start-publication')
  }

  return {
    register(input) {
      pending.set(input.commandId, input)
      return { kind: 'registered' }
    },
    markQueued(commandId) {
      const input = pending.get(commandId)
      if (!input) return { kind: 'ignored', reason: 'unregistered_command' }
      return advancePhase(input, 'queued')
    },
    onStarting(view) {
      const input = pending.get(view.commandId)
      if (!input) return { kind: 'ignored', reason: 'unregistered_command' }
      if (!phaseViewMatches(input, view, 'starting')) {
        promote(input.commandId, 'deferred_execution_may_have_begun')
        return { kind: 'indeterminate', errorCode: 'deferred_execution_may_have_begun' }
      }
      return advancePhase(input, 'starting')
    },
    onStarted(view) {
      // Witness only. Completing or advancing phase here races providers that
      // append the user prompt after beginRun; dispatch-settled after persist
      // is the gate for the started phase and terminal success.
      const input = pending.get(view.commandId)
      if (!input) return
      if (!phaseViewMatches(input, view, 'started')) {
        promote(input.commandId, 'deferred_execution_may_have_begun')
      }
    },
    completeStart(commandId) {
      const input = pending.get(commandId)
      if (!input || inFlight.has(commandId)) return
      const phase = advancePhase(input, 'started')
      if (phase.kind !== 'started') return
      track(commandId, publishComplete(input))
    },
    abort(commandId) {
      if (!pending.has(commandId)) return
      promote(commandId, 'deferred_execution_may_have_begun')
    },
    fail(commandId, result) {
      const input = pending.get(commandId)
      if (!input) return
      if (!stillPending(commandId, input.actor, input.fingerprint)) return
      const status = result.status === 'cancelled' ? 'cancelled' : 'failed'
      try {
        const completed = ports.completeReceipt({
          commandId,
          status,
          completedAt: now(),
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          resultSummary: result.resultSummary
        })
        pending.delete(commandId)
        if (!completed) promote(commandId, 'deferred_execution_may_have_begun')
      } catch {
        promote(commandId, 'deferred_execution_may_have_begun')
      }
    },
    async drain() {
      for (;;) {
        const batch = [...inFlight.values()]
        if (batch.length === 0) return
        await Promise.all(batch)
      }
    },
    pendingCount() {
      return pending.size
    },
    inFlightCount() {
      return inFlight.size
    }
  }
}

export function scopeQueuedStartFamilies(
  families: HostMutationObservationFamilies,
  scope: HostMutationObservationScope
): HostMutationObservationFamilies {
  return scopeHostMutationObservationFamilies(families, scope)
}

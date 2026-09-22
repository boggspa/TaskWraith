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
 * that persist boundary, then publishes the correlated start upserts:
 * the run whose entityId is this commandId — or, when the settled dispatch
 * BINDS one, the run row it actually persisted — and the thread whose
 * entityId is command.target.threadId, plus the round whose entityId is the
 * register input's roundId for ensemble starts — or the round row a settled
 * in-main ensemble dispatch BINDS, which replaces the run family outright. A
 * bound entity is evidence only (see HostQueuedStartEffectIdentity.runEntityId
 * and .roundEntityId), must still sit on the target thread, and binding one of
 * each is refused incoherent. Success requires every
 * admitted upsert (Domain's persist proof is the run row plus the user
 * message, which the thread projection carries as messageCount/updatedAt).
 * Other same-thread runs are not
 * admitted. Command-local scope is still used to READ the donor, but
 * BEFORE is captured before ACK/capacity/persist waits, so a full scoped
 * diff would misattribute concurrent same-thread mutations.
 * Excluded observation keys are listed exhaustively. `channel` is omitted
 * because HostDomainDeltaPublisher.DOMAIN_EFFECT_FAMILIES rejects it
 * (out of this grant). `onStarted` never succeeds a receipt and never
 * mints a second one.
 *
 * Receipt phase is stored/projected by HostCommandReceiptStore and advanced
 * here without changing receipt status. Standalone HostNodeProductionServer
 * opens the file-backed execution-claim journal behind the default-OFF gate
 * and injects it through HostNodeDomainPorts; lifecycle `claim` awaits its
 * fsynced record before provider side effects. The journal still declares no
 * durable absence coverage. Lifecycle recovery, retention/compaction, and the
 * queued-start producer remain separate work; HostMainComposition exposes the
 * port (default OFF) but no producer calls it yet. Flag default remains OFF.
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
  HostCommandReceiptExecutionClaimCursor,
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
  readonly executionClaimCursor?: HostCommandReceiptExecutionClaimCursor
  readonly startedEvidence: boolean
  readonly terminalOutcome: string | null
}

export interface HostQueuedStartPublicationRegisterInput {
  readonly commandId: string
  readonly actor: HostCommandReceiptActor
  readonly fingerprint: string
  /** Ensemble round id. Absent for solo starts. No producer passes it yet. */
  readonly roundId?: string
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
    phase: HostQueuedStartPhase,
    executionClaimCursor?: HostCommandReceiptExecutionClaimCursor
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
 * record. The publisher emits only those rows: run entityId === commandId
 * (or the run entity the settled dispatch bound, which must still belong to
 * the target thread) and thread entityId === command.target.threadId.
 * Success requires both
 * upserts; a run-only batch is incomplete. Ensemble starts additionally
 * persist their round row: when the register input carries a roundId, the
 * publisher emits that third row (round entityId === roundId) and success
 * requires all three upserts.
 *
 * An IN-MAIN ensemble start instead BINDS its round row at the settled
 * boundary (see HostQueuedStartEffectIdentity.roundEntityId). That binding
 * replaces the run family — the batch and the proof are exactly thread +
 * round — because no participant has a runId yet at the round-start persist
 * boundary. Binding a run entity and a round entity together is incoherent.
 *
 * Not start effects (concurrent same-thread writes during the off-queue wait
 * must not be attributed here): missions, participants, providers,
 * questions, approvals, schedules, artifacts, workspaces.
 * Singletons health/routing/usage/warnings are likewise excluded.
 * `channel` is excluded twice: it is not a start write, AND emitting it
 * would be rejected by HostDomainDeltaPublisher.DOMAIN_EFFECT_FAMILIES
 * (adding `channel` there is a separate grant).
 */
export const QUEUED_START_EFFECT_FAMILIES = [
  'run',
  'thread',
  'round'
] as const satisfies readonly HostDeltaFamily[]

type ObservationKey = keyof HostMutationObservationFamilies
// 'rounds' donates only for ensemble identities (register input roundId);
// solo diffs skip the round spec, so no solo batch changes shape.
type StartEffectDonorKey = 'runs' | 'threads' | 'rounds'

export const QUEUED_START_EXCLUDED_OBSERVATION_KEYS = {
  health: true,
  workspaces: true,
  missions: true,
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
  { family: 'thread', rows: (families) => families.threads, id: (row) => idOf(row, 'id') },
  { family: 'round', rows: (families) => families.rounds, id: (row) => idOf(row, 'roundId') }
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
  /** Ensemble starts only. Absent for solo starts, which admit no round row. */
  readonly roundId?: string
  /**
   * The run row this start is proven by, when it is NOT the commandId.
   *
   * EVIDENCE, NEVER IDENTITY. The standalone route runs the provider under
   * `runId === commandId`, so it binds nothing and keeps today's lookup. The
   * in-main Bridge route allocates its own `appRunId` before a Host command
   * exists, and that id is the wire identity every paired device navigates by,
   * so it cannot be re-keyed to the commandId. Instead the settled dispatch
   * BINDS the row it actually persisted.
   *
   * Because it is evidence it never reaches `fingerprintHostCommand`, the
   * receipt, the register input or any phase view, and it is honoured only
   * while the original receipt is still pending here. It can therefore never
   * mint, re-key or resurrect authority.
   */
  readonly runEntityId?: string
  /**
   * The ROUND row this start is proven by, for an in-main ensemble start.
   *
   * EVIDENCE, NEVER IDENTITY, on exactly the same terms as runEntityId. It is
   * bound at the settled boundary because the round id is minted inside
   * beginRound — after the send was resolved — so the register input can never
   * carry it for a start (a register-input roundId can only ever describe an
   * absorb into a LIVE round, which is not a queued start at all).
   *
   * When it is bound the run family is NOT admitted and the proof is exactly
   * thread + round. That is not a weakening: at the round-start persist
   * boundary no participant has a runId yet (participants are minted `idle`),
   * so a participant-run requirement would be vacuous at precisely the moment
   * it is needed. Binding BOTH this and runEntityId is refused incoherent.
   */
  readonly roundEntityId?: string
}

/**
 * The one resolution the diff and the proof must agree on. Keeping it in a
 * single function is what stops the two sides drifting into a state where the
 * batch is emitted for one run row and proven against another.
 */
function resolveRunEntityId(identity: HostQueuedStartEffectIdentity): string {
  return identity.runEntityId ?? identity.commandId
}

/**
 * The round counterpart, with the same single-resolution discipline. A bound
 * round entity overrides the register input's roundId; absent one, the
 * register-input branch is reached byte-identically.
 */
function resolveRoundEntityId(identity: HostQueuedStartEffectIdentity): string | undefined {
  return identity.roundEntityId ?? identity.roundId
}

/**
 * A bound round entity replaces the run family outright — the proof becomes
 * thread + round. Both sides must agree, or the diff would emit a run row the
 * proof never demanded (or demand one the diff never emitted).
 */
function admitsRunFamily(identity: HostQueuedStartEffectIdentity): boolean {
  return identity.roundEntityId === undefined
}

/**
 * A start is a solo run or an ensemble round, never both. Refusing the pair
 * outright is what stops the run requirement being dropped silently from a
 * SOLO start by a stray round binding.
 */
function bindsAmbiguousStart(identity: HostQueuedStartEffectIdentity): boolean {
  return identity.runEntityId !== undefined && identity.roundEntityId !== undefined
}

/**
 * Start evidence a settled dispatch may bind for THIS commandId. Optional and
 * additive: omitting it reproduces the standalone lookup exactly. At most one
 * of the two may be bound.
 */
export interface HostQueuedStartEntities {
  readonly runEntityId?: string
  readonly roundEntityId?: string
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
  | {
      readonly kind: 'incoherent'
      readonly reason: 'duplicate_entity_id' | 'ambiguous_start_entity'
    }

/**
 * Diff only the command-correlated start rows: this command's run, the
 * target thread, and — only when the identity carries a roundId — the
 * ensemble round. Other same-thread runs are ignored even when they change
 * during the off-queue wait. Duplicate exact-id AFTER (or BEFORE) rows fail
 * closed — success requires one unambiguous donor row per admitted identity.
 * Payloads come from the scoped donor, never from command intent.
 */
export function diffScopedStartEffects(
  before: HostMutationObservationFamilies,
  after: HostMutationObservationFamilies,
  identity: HostQueuedStartEffectIdentity
): HostQueuedStartDiffResult {
  // A start is a solo run or an ensemble round. Binding both is incoherent
  // before any row is read: emitting the union would let a solo start pass
  // without its run row.
  if (bindsAmbiguousStart(identity)) {
    return { kind: 'incoherent', reason: 'ambiguous_start_entity' }
  }
  const effects: HostDomainEffectDto[] = []
  for (const spec of START_EFFECT_FAMILY_SPECS) {
    // A bound round entity replaces the run family: an in-main ensemble start
    // has no participant run at its persist boundary, so no run row is
    // admitted and the batch is exactly thread + round.
    if (spec.family === 'run' && !admitsRunFamily(identity)) continue
    const entityId =
      spec.family === 'run'
        ? resolveRunEntityId(identity)
        : spec.family === 'thread'
          ? identity.threadId
          : resolveRoundEntityId(identity)
    // Solo identities admit no round row: the round spec is skipped, so solo
    // batches keep their exact two-effect shape.
    if (entityId === undefined) continue
    const left = uniqueRowWithId(spec.rows(before), spec.id, entityId)
    const right = uniqueRowWithId(spec.rows(after), spec.id, entityId)
    if (left.kind === 'duplicate' || right.kind === 'duplicate') {
      return { kind: 'incoherent', reason: 'duplicate_entity_id' }
    }
    const leftRow = left.kind === 'one' ? left.row : undefined
    const rightRow = right.kind === 'one' ? right.row : undefined
    // A BOUND entity is a foreign id: it was minted outside this command, so
    // matching the id alone would admit another thread's row as this start's
    // proof. Require the row to sit on the target thread, and emit nothing
    // when it does not — no upsert (so the proof fails closed) and no
    // tombstone (so a stranger's row is never retracted under our authority).
    // The standalone route binds nothing and is untouched by this branch; the
    // register-input roundId is not a binding and keeps its own shape.
    const bound =
      (spec.family === 'run' && identity.runEntityId !== undefined) ||
      (spec.family === 'round' && identity.roundEntityId !== undefined)
    if (bound && rightRow !== undefined && idOf(rightRow, 'threadId') !== identity.threadId) {
      continue
    }
    if (!leftRow && rightRow) effects.push(upsert(spec.family, entityId, rightRow))
    else if (leftRow && !rightRow) effects.push(tombstone(spec.family, entityId))
    else if (leftRow && rightRow && JSON.stringify(leftRow) !== JSON.stringify(rightRow)) {
      effects.push(upsert(spec.family, entityId, rightRow))
    }
  }
  return { kind: 'effects', effects }
}

/**
 * Start proof: run upsert for commandId AND thread upsert for
 * target.threadId, plus — only for ensemble identities — the round upsert
 * for roundId.
 *
 * A BOUND round entity replaces the run requirement rather than adding to it:
 * the proof becomes exactly thread + round. Binding both entities proves
 * nothing at all.
 */
export function provesQueuedStartEffects(
  effects: readonly HostDomainEffectDto[],
  identity: HostQueuedStartEffectIdentity
): boolean {
  if (bindsAmbiguousStart(identity)) return false
  const runEntityId = resolveRunEntityId(identity)
  const runUpsert =
    !admitsRunFamily(identity) ||
    effects.some(
      (effect) =>
        effect.family === 'run' && effect.kind === 'upsert' && effect.entityId === runEntityId
    )
  const threadUpsert = effects.some(
    (effect) =>
      effect.family === 'thread' &&
      effect.kind === 'upsert' &&
      effect.entityId === identity.threadId
  )
  const roundEntityId = resolveRoundEntityId(identity)
  const roundUpsert =
    roundEntityId === undefined ||
    effects.some(
      (effect) =>
        effect.family === 'round' && effect.kind === 'upsert' && effect.entityId === roundEntityId
    )
  return runUpsert && threadUpsert && roundUpsert
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
  completeStart(commandId: string, startEntities?: HostQueuedStartEntities): void
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
    phase: HostQueuedStartPhase,
    executionClaimCursor?: HostCommandReceiptExecutionClaimCursor
  ): HostQueuedStartPublicationOutcome {
    if (!stillPending(input.commandId, input.actor, input.fingerprint)) {
      return { kind: 'ignored', reason: 'receipt_not_pending' }
    }
    let result: HostCommandReceiptPhaseUpdateResult
    try {
      result = ports.updateReceiptPhase(input.commandId, phase, executionClaimCursor)
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

  async function publishComplete(
    input: HostQueuedStartPublicationRegisterInput,
    startEntities?: HostQueuedStartEntities
  ): Promise<void> {
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
      const identity: HostQueuedStartEffectIdentity = {
        commandId: input.commandId,
        threadId,
        ...(input.roundId !== undefined ? { roundId: input.roundId } : {}),
        ...(startEntities?.runEntityId !== undefined
          ? { runEntityId: startEntities.runEntityId }
          : {}),
        ...(startEntities?.roundEntityId !== undefined
          ? { roundEntityId: startEntities.roundEntityId }
          : {})
      }
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
      return advancePhase(input, 'starting', view.executionClaimCursor)
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
    completeStart(commandId, startEntities) {
      // Pending-only. A late or unknown commandId — a remote-queue re-flush
      // after a Host restart, for instance — finds no entry and returns
      // silently: no receipt is touched, so a restart-promoted receipt stays
      // indeterminate rather than being resurrected by foreign evidence.
      const input = pending.get(commandId)
      if (!input || inFlight.has(commandId)) return
      const phase = advancePhase(input, 'started')
      if (phase.kind !== 'started') return
      track(commandId, publishComplete(input, startEntities))
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

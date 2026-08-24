/**
 * W5-S1 — what happens to a deferred challenge when the Host restarts under it.
 *
 * The restart-ask ruling (blackboard `host-arc-restart-ask-semantics`, decided
 * A-now) says a challenge whose Host restarts before it is answered DIES
 * EXPLICITLY, and it bakes four MANDATORY HONESTY REQUIREMENTS into acceptance:
 *
 *   1. an answer given after restart must surface an explicit non-success to
 *      the caller — never a silent ack, never fake success;
 *   2. recovery must SURFACE the dead challenge rather than quietly heal it;
 *   3. re-issue = new commandId = fresh ask;
 *   4. it must never double-execute.
 *
 * Those requirements were ruled but never exercised. The pieces are unit-tested
 * in isolation — HostCommandReceiptStore.reopen() promotes pending receipts to
 * indeterminate, HostDeferredCommandBridge.reopen() lets `awaiting` rows
 * survive — but nothing drives a real challenge across a real restart and asks
 * what the CLIENT is told afterwards. That is the gap this file closes.
 *
 * The restart is real, not simulated with mocks: composition #1 is shut down
 * and composition #2 is constructed over the SAME durable directory, which is
 * exactly what a Host relaunch does. Both compositions run the real envelope
 * store, Bridge, S4a adapter, S4b pre-route, resolver, mutation pipeline and
 * completion coordinator over a real temp-dir journal.
 *
 * Companion to HostDeferredRoundTrip.test.ts (W36-S2), which drives the same
 * chain WITHOUT a restart. This file is deliberately separate rather than an
 * amendment: that one is frozen under review.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCapability,
  type HostCommand,
  type HostHealthProjection
} from '../../shared/hostProtocol'
import type {
  AppStoreHostAuthorityExecutor,
  AppStoreHostAuthoritySnapshotDonorFamilies
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from '../../host-runtime/HostAuthority'
import { HostCommandMutationPipeline } from './HostCommandMutationPipeline'
import { HostDeferredAllowPipeline } from './HostDeferredAllowPipeline'
import { HostDeferredCommandEnvelopeResolver } from './HostDeferredCommandEnvelopeResolver'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import { createHostMainComposition, type HostMainComposition } from './HostMainComposition'
import { HostMutationCompletionCoordinator } from './HostMutationCompletionCoordinator'
import { HostObservedMutationExecutor } from './HostObservedMutationExecutor'
import type { HostRuntimeBootstrap } from './HostRuntimeBootstrap'

const ACTOR: HostActorIdentity = {
  actorId: 'actor-a',
  clientId: 'client-a',
  clientClass: 'desktop'
}

const CONTEXT: HostAuthorityCallContext = {
  actor: ACTOR,
  client: { clientId: 'client-a', clientClass: 'desktop', clientVersion: '1.9.2' }
}

const NOW = '2026-08-05T09:00:00.000Z'

const ORIGINAL_COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ORIGINAL_IDEMPOTENCY_KEY = 'desktop:client-a:22222222-2222-4222-8222-222222222222'
const DECIDE_COMMAND_ID = '66666666-6666-4666-8666-666666666666'
const DECIDE_IDEMPOTENCY_KEY = 'desktop:client-a:77777777-7777-4777-8777-777777777777'
/** The re-issue after a dead challenge MUST be a new command, not a retry. */
const REISSUE_COMMAND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REISSUE_IDEMPOTENCY_KEY = 'desktop:client-a:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const TARGET_ID = 'thread-restart-recovery-target'

const CAPABILITIES: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'commands',
  'receipts',
  'health',
  'recovery'
]

const HEALTH: HostHealthProjection = {
  hostStatus: 'ok',
  connectionPhase: 'live',
  supervised: true,
  freshness: 'live'
}

function donorFamilies(): AppStoreHostAuthoritySnapshotDonorFamilies {
  return {
    health: HEALTH,
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: []
  }
}

function makeCommand(
  overrides: Partial<HostCommand> & Pick<HostCommand, 'commandId' | 'idempotencyKey' | 'actor'>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    name: 'thread.select',
    target: { threadId: TARGET_ID },
    arguments: {},
    issuedAt: NOW,
    ...overrides
  }
}

function decideCommand(
  approvalId: string,
  decision: string,
  ids: { commandId: string; idempotencyKey: string }
): HostCommand {
  return makeCommand({
    commandId: ids.commandId,
    idempotencyKey: ids.idempotencyKey,
    actor: ACTOR,
    name: 'approval.decide',
    target: { approvalId },
    arguments: { decision }
  })
}

interface Harness {
  readonly composition: HostMainComposition
  /** Ordinary H route. */
  readonly hExecutor: ReturnType<typeof vi.fn>
  /** Domain executor reachable ONLY through the deferred allow pipeline. */
  readonly deferredExecutor: ReturnType<typeof vi.fn>
}

/**
 * Build one composition over `userDataPath`. Calling this twice against the
 * same path is the restart: the second call re-reads the durable journals the
 * first one left behind, which is precisely what a Host relaunch does.
 *
 * Each build gets FRESH spies, so "nothing executed after the restart" is a
 * statement about the post-restart process only and cannot be contaminated by
 * pre-restart calls.
 */
function buildHarness(userDataPath: string): Harness {
  const hExecutor = vi.fn(async () => ({ status: 'succeeded' as const }))
  const deferredExecutor = vi.fn(async (_command: HostCommand) => ({
    status: 'succeeded' as const
  }))

  let compositionRef: HostMainComposition | null = null

  const realChain = (runtime: HostRuntimeBootstrap): HostDeferredAllowPipeline => {
    const resolver = new HostDeferredCommandEnvelopeResolver({
      envelopeStore: runtime.envelopeStore,
      receiptStore: runtime.receiptStore,
      executor: {
        execute: async () => {
          throw new Error('raw resolver executor must never run under the AllowPipeline')
        }
      } as unknown as ConstructorParameters<
        typeof HostDeferredCommandEnvelopeResolver
      >[0]['executor']
    })
    const publisher = new HostDomainDeltaPublisher({ store: runtime.deltaStore })
    const coordinator = new HostMutationCompletionCoordinator({
      publishEffects: (effects) => publisher.publish(effects),
      getPosition: () => runtime.getPosition(),
      completeReceipt: (i) => runtime.receiptStore.complete(i),
      markIndeterminate: (i) => runtime.receiptStore.markIndeterminate(i)
    })
    const mutation = new HostCommandMutationPipeline({
      observe: async (command) =>
        new HostObservedMutationExecutor({
          captureSnapshot: async () => {
            const snap = await compositionRef!.authority.snapshot(CONTEXT)
            if (!snap.ok) throw new Error('restart-recovery snapshot capture failed')
            return snap.value
          },
          executeCommand: (c) => deferredExecutor(c)
        }).execute(command),
      complete: (i) => coordinator.complete(i)
    })
    return new HostDeferredAllowPipeline({
      verifyCommand: (i) => resolver.verifyCommand(i),
      pipeline: mutation
    })
  }

  const composition = createHostMainComposition({
    userDataPath,
    commandExecutor: hExecutor as unknown as AppStoreHostAuthorityExecutor,
    snapshotDonor: () => donorFamilies(),
    authorityEvaluator: (command) =>
      command.name === 'thread.select'
        ? { decision: 'deferred' as const, challengeKind: 'approval' as const }
        : { decision: 'allowed' as const },
    healthProvider: () => HEALTH,
    host: { hostId: 'host-1', hostVersion: '1.9.2' },
    hostCapabilityOffer: CAPABILITIES,
    pipelineFactory: realChain,
    now: () => NOW
  })
  compositionRef = composition

  return { composition, hExecutor, deferredExecutor }
}

describe('deferred challenge across a Host restart (W5-S1)', () => {
  let userDataPath: string
  let live: Harness | null = null

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'host-restart-'))
    live = null
  })

  afterEach(async () => {
    await live?.composition.shutdown()
    live = null
    rmSync(userDataPath, { recursive: true, force: true })
  })

  /** Defer a domain command and read the challenge id off the snapshot. */
  async function deferAndPublishChallenge(h: Harness): Promise<string> {
    const submitted = await h.composition.authority.command(
      CONTEXT,
      makeCommand({
        commandId: ORIGINAL_COMMAND_ID,
        idempotencyKey: ORIGINAL_IDEMPOTENCY_KEY,
        actor: ACTOR
      })
    )
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) throw new Error('deferral failed')
    expect(submitted.value.status).toBe('pending')

    const snap = await h.composition.authority.snapshot(CONTEXT)
    expect(snap.ok).toBe(true)
    if (!snap.ok) throw new Error('snapshot failed')
    expect(snap.value.approvals).toHaveLength(1)
    return snap.value.approvals[0]!.approvalId
  }

  /** Shut the Host down and bring a new one up over the same durable dir. */
  async function restart(previous: Harness): Promise<Harness> {
    await previous.composition.shutdown()
    return buildHarness(userDataPath)
  }

  /** Collapse either result shape to one comparable outcome label. */
  function outcomeOf(result: Awaited<ReturnType<HostMainComposition['authority']['command']>>) {
    return result.ok ? result.value.status : 'refused'
  }

  it('POSITIVE CONTROL: with no restart, accepting the challenge really executes', async () => {
    // Without this, every "executed nothing" assertion below could pass on a
    // harness that was simply incapable of executing at all. This proves the
    // deferred route is live in this file, so the silence after a restart is a
    // finding rather than an artifact.
    live = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(live)

    const decided = await live.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    expect(decided.ok).toBe(true)
    expect(live.deferredExecutor).toHaveBeenCalledTimes(1)
    expect(live.hExecutor).not.toHaveBeenCalled()
  })

  it('REQUIREMENT 2: recovery surfaces the interrupted command instead of healing it', async () => {
    const first = buildHarness(userDataPath)
    await deferAndPublishChallenge(first)
    live = await restart(first)

    const summary = live.composition.getRecoverySummary()

    // The interrupted command is visibly indeterminate, not quietly dropped and
    // not quietly reported as fine.
    expect(summary.receipts.indeterminate).toBeGreaterThanOrEqual(1)
    expect(summary.deferred.availability).toBe('available')
  })

  it('REQUIREMENT 4: accepting a challenge after a restart executes NOTHING', async () => {
    const first = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(first)
    live = await restart(first)

    await live.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    // Neither route may run: the original command's outcome is unknown, so
    // executing it now could double-apply work the dead Host already began.
    expect(live.deferredExecutor).not.toHaveBeenCalled()
    expect(live.hExecutor).not.toHaveBeenCalled()
  })

  it('REQUIREMENT 1: that acceptance is answered with an explicit non-success', async () => {
    const first = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(first)
    live = await restart(first)

    const decided = await live.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    // The caller must be TOLD. A silent ack or a fabricated success here would
    // let a client believe an approved action ran when nothing did.
    // MEASURED, then pinned exactly — not asserted from the ruling's wording.
    // The weaker `not.toBe('succeeded')` would also accept `pending`, and a
    // client parked on `pending` for a challenge that can never run is exactly
    // the silent ack this requirement exists to forbid.
    const outcome = outcomeOf(decided)
    expect(outcome).toBe('indeterminate')
  })

  it('REQUIREMENT 3: re-issuing under a NEW commandId opens a fresh challenge', async () => {
    const first = buildHarness(userDataPath)
    await deferAndPublishChallenge(first)
    live = await restart(first)

    const reissued = await live.composition.authority.command(
      CONTEXT,
      makeCommand({
        commandId: REISSUE_COMMAND_ID,
        idempotencyKey: REISSUE_IDEMPOTENCY_KEY,
        actor: ACTOR
      })
    )

    // The user's way forward after a dead challenge: ask again, cleanly.
    expect(reissued.ok).toBe(true)
    if (!reissued.ok) throw new Error('re-issue failed')
    expect(reissued.value.status).toBe('pending')

    const snap = await live.composition.authority.snapshot(CONTEXT)
    expect(snap.ok).toBe(true)
    if (!snap.ok) throw new Error('snapshot failed')
    const ids = snap.value.approvals.map((card) => card.approvalId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

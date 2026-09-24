/**
 * W36-S2 — the deferred approval ROUND TRIP, end to end.
 *
 * Every slice of the deferred chain has been tested in isolation, but the join
 * has never been driven. The two existing halves are:
 *
 *   - HostMainComposition.test.ts "wires S4b hooks so correlated approval.decide
 *     hits pipeline once and zero H" — real correlation, MOCK pipeline.
 *   - HostMainComposition.test.ts "composes the real resolver/mutation/
 *     coordinator chain over the real stores" — REAL chain, but driven directly
 *     with an unknown envelope so nothing ever executes.
 *
 * Neither proves the thing the arc actually claims: that a command deferred by
 * the Authority, approved by a client through `approval.decide`, is executed
 * EXACTLY ONCE through the real chain, and that the ordinary H route never runs
 * for the decide. That join is what this file drives, through the composed
 * Authority only — no private handles, no direct pipeline pokes.
 *
 * Integration boundary, not a unit: the composition, Authority, envelope store,
 * Bridge, S4a adapter, S4b pre-route, resolver, mutation pipeline, observed
 * executor and completion coordinator are all the real ones over a real
 * temp-dir journal. Only the two leaf ports are spies, and they are DISTINCT
 * on purpose so "which route executed?" is answerable rather than assumed.
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
  type HostHealthProjection,
  type HostThreadProjection
} from '../../shared/hostProtocol'
import type {
  AppStoreHostAuthorityExecutor,
  AppStoreHostAuthoritySnapshotDonorFamilies
} from '../../host-runtime/AppStoreHostAuthority'
import type { HostAuthorityCallContext } from '../../host-runtime/HostAuthority'
import { HostCommandMutationPipeline } from '../../host-runtime/HostCommandMutationPipeline'
import { HostDeferredAllowPipeline } from '../../host-runtime/HostDeferredAllowPipeline'
import { HostDeferredCommandEnvelopeResolver } from '../../host-runtime/HostDeferredCommandEnvelopeResolver'
import { HostDomainDeltaPublisher } from '../../host-runtime/HostDomainDeltaPublisher'
import {
  createHostMainComposition,
  type HostMainComposition
} from '../../host-runtime/HostMainComposition'
import { HostMutationCompletionCoordinator } from '../../host-runtime/HostMutationCompletionCoordinator'
import { HostObservedMutationExecutor } from '../../host-runtime/HostObservedMutationExecutor'
import type { HostRuntimeBootstrap } from '../../host-runtime/HostRuntimeBootstrap'

const ACTOR: HostActorIdentity = {
  actorId: 'actor-a',
  clientId: 'client-a',
  clientClass: 'desktop'
}

const CONTEXT: HostAuthorityCallContext = {
  actor: ACTOR,
  client: { clientId: 'client-a', clientClass: 'desktop', clientVersion: '1.9.2' }
}

/** A second actor, used to prove correlation is actor-scoped. */
const OTHER_ACTOR: HostActorIdentity = {
  actorId: 'actor-b',
  clientId: 'client-b',
  clientClass: 'desktop'
}

const OTHER_CONTEXT: HostAuthorityCallContext = {
  actor: OTHER_ACTOR,
  client: { clientId: 'client-b', clientClass: 'desktop', clientVersion: '1.9.2' }
}

const NOW = '2026-08-05T09:00:00.000Z'

const ORIGINAL_COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ORIGINAL_IDEMPOTENCY_KEY = 'desktop:client-a:22222222-2222-4222-8222-222222222222'
const DECIDE_COMMAND_ID = '66666666-6666-4666-8666-666666666666'
const DECIDE_IDEMPOTENCY_KEY = 'desktop:client-a:77777777-7777-4777-8777-777777777777'
const SECOND_DECIDE_COMMAND_ID = '88888888-8888-4888-8888-888888888888'
const SECOND_DECIDE_IDEMPOTENCY_KEY = 'desktop:client-a:99999999-9999-4999-8999-999999999999'

/** Distinctive body value: proves the executed command is the ORIGINAL one. */
const ORIGINAL_TARGET_ID = 'thread-round-trip-original-target'

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
    target: { threadId: ORIGINAL_TARGET_ID },
    arguments: {},
    issuedAt: NOW,
    ...overrides
  }
}

/** The command a client submits to approve a published challenge card. */
function decideCommand(
  approvalId: string,
  decision: string,
  ids: { commandId: string; idempotencyKey: string; actor?: HostActorIdentity }
): HostCommand {
  return makeCommand({
    commandId: ids.commandId,
    idempotencyKey: ids.idempotencyKey,
    actor: ids.actor ?? ACTOR,
    name: 'approval.decide',
    target: { approvalId },
    arguments: { decision }
  })
}

interface Harness {
  readonly composition: HostMainComposition
  /** Ordinary H route. MUST stay untouched for a correlated decide. */
  readonly hExecutor: ReturnType<typeof vi.fn>
  /** Domain executor reachable ONLY through the deferred allow pipeline. */
  readonly deferredExecutor: ReturnType<typeof vi.fn>
}

function buildHarness(userDataPath: string): Harness {
  const hExecutor = vi.fn(async () => ({ status: 'succeeded' as const }))

  // Domain state the approved command actually mutates.
  //
  // This is load-bearing for the journal assertion: with a no-op spy the
  // before/after captures are identical, the diff yields zero effects, and
  // "nothing was published" is the CORRECT outcome — so asserting the cursor
  // moved would have been asserting a bug. Giving the executor a real mutation
  // is what makes the published-effect claim mean anything.
  const threads: HostThreadProjection[] = []
  const deferredExecutor = vi.fn(async (_command: HostCommand) => {
    threads.push({
      id: 'thread-created-by-round-trip',
      workspaceId: null,
      title: 'created by the approved command',
      chatKind: 'single',
      archived: false,
      pinned: false,
      updatedAt: Date.parse(NOW),
      messageCount: 0
    })
    return { status: 'succeeded' as const }
  })

  // Lazy: the factory runs DURING construction, before `composition` exists.
  // Production has the same shape — capture reads back through the Authority.
  let compositionRef: HostMainComposition | null = null

  const realChain = (runtime: HostRuntimeBootstrap): HostDeferredAllowPipeline => {
    const resolver = new HostDeferredCommandEnvelopeResolver({
      envelopeStore: runtime.envelopeStore,
      receiptStore: runtime.receiptStore,
      // The AllowPipeline consumes only verifyCommand (zero-H). If this ever
      // runs, a second execution route has been opened by mistake.
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
            if (!snap.ok) throw new Error('round-trip snapshot capture failed')
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
    snapshotDonor: () => ({ ...donorFamilies(), threads: [...threads] }),
    // Only the domain command defers. Everything else is ALLOWED, so if the
    // decide ever fell through to H it would really execute and hExecutor
    // would record it — the assertion below can fail rather than pass vacuously.
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

describe('deferred approval round trip (W36-S2)', () => {
  let userDataPath: string
  let harness: Harness | null = null

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'host-roundtrip-'))
    harness = null
  })

  afterEach(async () => {
    await harness?.composition.shutdown()
    harness = null
    rmSync(userDataPath, { recursive: true, force: true })
  })

  /**
   * Submit the domain command, then read the published challenge id back the
   * way a real client must: off the snapshot's approvals family (GAP-A). No
   * test ever reaches into the Bridge for it.
   */
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

  it('executes the ORIGINAL command exactly once when the challenge is accepted', async () => {
    harness = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(harness)

    // Nothing has executed yet: a deferral must not pre-run its own command.
    expect(harness.deferredExecutor).not.toHaveBeenCalled()
    expect(harness.hExecutor).not.toHaveBeenCalled()

    const decided = await harness.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    expect(decided.ok).toBe(true)
    if (!decided.ok) return

    // Exactly once, and it is the ORIGINAL command — not the decide.
    expect(harness.deferredExecutor).toHaveBeenCalledTimes(1)
    const executed = harness.deferredExecutor.mock.calls[0]![0] as HostCommand
    expect(executed.commandId).toBe(ORIGINAL_COMMAND_ID)
    expect(executed.name).toBe('thread.select')
    expect(executed.target.threadId).toBe(ORIGINAL_TARGET_ID)

    // E-primary: the ordinary H route never ran for the correlated decide.
    expect(harness.hExecutor).not.toHaveBeenCalled()

    // The receipt handed back is the ORIGINAL command's, now terminal.
    expect(decided.value.commandId).toBe(ORIGINAL_COMMAND_ID)
    expect(decided.value.status).not.toBe('pending')
  })

  it('retires the published approval card once the challenge is resolved', async () => {
    harness = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(harness)

    await harness.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    const after = await harness.composition.authority.snapshot(CONTEXT)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    // Only awaiting rows are published; a resolved challenge must not linger
    // as a pending card a client would render forever.
    expect(after.value.approvals.map((a) => a.approvalId)).not.toContain(challengeId)
  })

  it('does not execute a second time when the same decision is replayed', async () => {
    harness = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(harness)

    await harness.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )
    expect(harness.deferredExecutor).toHaveBeenCalledTimes(1)

    // A client retry after a dropped response must not re-run the domain
    // command. Distinct commandId so this is a genuine second submission
    // rather than plain command-level idempotency.
    const replay = await harness.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: SECOND_DECIDE_COMMAND_ID,
        idempotencyKey: SECOND_DECIDE_IDEMPOTENCY_KEY
      })
    )

    expect(harness.deferredExecutor).toHaveBeenCalledTimes(1)
    expect(harness.hExecutor).not.toHaveBeenCalled()
    // Whatever the outcome shape, it must never be a silent second success.
    if (replay.ok) {
      expect(replay.value.commandId).toBe(ORIGINAL_COMMAND_ID)
    }
  })

  it('never executes the domain command when the challenge is declined', async () => {
    harness = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(harness)

    const declined = await harness.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'decline', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    expect(declined.ok).toBe(true)
    expect(harness.deferredExecutor).not.toHaveBeenCalled()
    expect(harness.hExecutor).not.toHaveBeenCalled()
  })

  it('refuses a foreign actor and leaves the challenge executable by its owner', async () => {
    harness = buildHarness(userDataPath)
    const challengeId = await deferAndPublishChallenge(harness)

    const foreign = await harness.composition.authority.command(
      OTHER_CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: 'desktop:client-b:22222222-2222-4222-8222-222222222222',
        actor: OTHER_ACTOR
      })
    )

    // Body-free refusal, and critically: zero execution on either route.
    expect(foreign.ok).toBe(false)
    expect(harness.deferredExecutor).not.toHaveBeenCalled()
    expect(harness.hExecutor).not.toHaveBeenCalled()

    // The owner can still approve it — a rejected foreign decide must not
    // have consumed or corrupted the challenge.
    const owned = await harness.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: SECOND_DECIDE_COMMAND_ID,
        idempotencyKey: SECOND_DECIDE_IDEMPOTENCY_KEY
      })
    )
    expect(owned.ok).toBe(true)
    expect(harness.deferredExecutor).toHaveBeenCalledTimes(1)
  })

  it('falls through to the live H route for an uncorrelated approvalId', async () => {
    // POSITIVE CONTROL — this is what stops every `hExecutor` assertion above
    // from being vacuous. If the H spy were wired to nothing, "H was not
    // called" would pass no matter what the Authority did. Here an approvalId
    // that E does not own must reach H and really execute, proving the spy
    // fires and that its SILENCE in the correlated cases is a real finding.
    harness = buildHarness(userDataPath)
    await deferAndPublishChallenge(harness)

    const uncorrelated = await harness.composition.authority.command(
      CONTEXT,
      decideCommand('00000000-0000-4000-8000-000000000000', 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    expect(uncorrelated.ok).toBe(true)
    expect(harness.hExecutor).toHaveBeenCalledTimes(1)
    // ...and E's challenge was left strictly alone.
    expect(harness.deferredExecutor).not.toHaveBeenCalled()
  })

  it('publishes the executed round trip onto the sole journal', async () => {
    harness = buildHarness(userDataPath)
    const before = harness.composition.getPosition()
    const challengeId = await deferAndPublishChallenge(harness)

    await harness.composition.authority.command(
      CONTEXT,
      decideCommand(challengeId, 'accept', {
        commandId: DECIDE_COMMAND_ID,
        idempotencyKey: DECIDE_IDEMPOTENCY_KEY
      })
    )

    // The approved command really mutated domain state, so the observed diff
    // had an effect to publish and the sole journal advanced. One store: the
    // position the composition reports is the one the coordinator wrote to.
    expect(harness.deferredExecutor).toHaveBeenCalledTimes(1)
    const after = harness.composition.getPosition()
    expect(after).not.toEqual(before)
  })
})

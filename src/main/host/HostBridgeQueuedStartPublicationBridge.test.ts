import { describe, expect, it, vi } from 'vitest'

import {
  createHostQueuedStartPublication,
  type HostQueuedStartEntities,
  type HostQueuedStartStartedView
} from '../../host-runtime/HostQueuedStartPublication'
import type { HostCommandExecutionResult } from '../../host-runtime/HostCommandExecutionResult'
import type {
  HostBridgeQueuedStartFailure,
  HostBridgeQueuedStartView
} from './HostBridgeQueuedStartAdapter'
import {
  createHostBridgeQueuedStartPublicationBridge,
  type HostBridgeQueuedStartAuthorityPort
} from './HostBridgeQueuedStartPublicationBridge'

// Letters are load-bearing: an all-digit uuid makes `.toUpperCase()` a no-op,
// which would silently disarm the lowercase-only pin below.
const COMMAND_ID = '1f2e3d4c-5b6a-4987-8def-0123456789ab'
const ACTION_ID = `host:command:${COMMAND_ID}` as const
const THREAD_ID = 'thread-1'
const FINGERPRINT = 'fingerprint-1'
const RUN_ID = 'app-run-9'

const AUTHORITY_IDENTITY = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop',
  commandFingerprint: FINGERPRINT
} as const

function view(overrides: Partial<HostBridgeQueuedStartView> = {}): HostBridgeQueuedStartView {
  return {
    hostCommandActionId: ACTION_ID,
    threadId: THREAD_ID,
    authority: AUTHORITY_IDENTITY,
    phase: 'registered',
    ...overrides
  }
}

function preparedSolo(runId = RUN_ID): HostBridgeQueuedStartView {
  return view({
    phase: 'prepared',
    prepared: {
      start: { kind: 'solo', runId },
      effectRefs: [
        { family: 'thread', entityId: THREAD_ID },
        { family: 'run', entityId: runId }
      ]
    }
  })
}

function preparedEnsemble(): HostBridgeQueuedStartView {
  return view({
    phase: 'prepared',
    prepared: {
      start: { kind: 'ensemble', roundId: 'round-1', participantRunIds: ['run-a', 'run-b'] },
      effectRefs: [
        { family: 'thread', entityId: THREAD_ID },
        { family: 'round', entityId: 'round-1' },
        { family: 'run', entityId: 'run-a' },
        { family: 'run', entityId: 'run-b' }
      ]
    }
  })
}

function settled(
  status: 'started' | 'failed' | 'cancelled',
  errorCode?: string
): HostBridgeQueuedStartView {
  return view({
    phase: 'settled',
    settled: { status, ...(errorCode !== undefined ? { errorCode } : {}) }
  })
}

function spyAuthority(): {
  port: HostBridgeQueuedStartAuthorityPort
  starting: ReturnType<typeof vi.fn>
  dispatchSettled: ReturnType<typeof vi.fn>
} {
  const starting = vi.fn<(view: HostQueuedStartStartedView) => void>()
  const dispatchSettled =
    vi.fn<
      (
        commandId: string,
        result: HostCommandExecutionResult,
        startEntities?: HostQueuedStartEntities
      ) => void
    >()
  return {
    port: {
      handleQueuedStartStarting: starting,
      handleQueuedStartDispatchSettled: dispatchSettled
    },
    starting,
    dispatchSettled
  }
}

describe('createHostBridgeQueuedStartPublicationBridge', () => {
  it('refuses construction without a usable authority port', () => {
    expect(() =>
      createHostBridgeQueuedStartPublicationBridge({
        authority: {} as unknown as HostBridgeQueuedStartAuthorityPort
      })
    ).toThrow(/requires an injected authority port/)
  })

  it('never forwards the queued phase — the Authority owns that write', () => {
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(
      bridge.onQueued(
        view({ phase: 'queued', queued: { queueId: 'queue-1', reservedRunId: RUN_ID } })
      )
    ).toEqual({ kind: 'ignored', reason: 'queued_phase_owned_by_authority' })
    expect(starting).not.toHaveBeenCalled()
    expect(dispatchSettled).not.toHaveBeenCalled()
    expect(bridge.forwardedCount()).toBe(0)
  })

  it('drives a solo prepared view to starting and then a settlement binding the run entity', () => {
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    const order: string[] = []
    starting.mockImplementation(() => order.push('starting'))
    dispatchSettled.mockImplementation(() => order.push('settled'))

    expect(bridge.onPrepared(preparedSolo())).toEqual({
      kind: 'started',
      commandId: COMMAND_ID,
      runEntityId: RUN_ID
    })

    // Starting precedes settlement: the receipt must reach `starting` before
    // anything can publish its start effects.
    expect(order).toEqual(['starting', 'settled'])
    expect(starting).toHaveBeenCalledTimes(1)
    const startingView = starting.mock.calls[0]![0] as HostQueuedStartStartedView
    expect(startingView).toEqual({
      commandId: COMMAND_ID,
      threadId: THREAD_ID,
      fingerprint: FINGERPRINT,
      phase: 'starting',
      startedEvidence: false,
      terminalOutcome: null
    })
    // No durable pre-spawn claim exists on the in-main route, so no cursor is
    // asserted. Recovery therefore classifies a restart-promoted receipt as
    // `unknown`, never `claimed`.
    expect(startingView).not.toHaveProperty('executionClaimCursor')
    expect(Object.keys(startingView)).not.toContain('executionClaimCursor')

    expect(dispatchSettled).toHaveBeenCalledTimes(1)
    expect(dispatchSettled).toHaveBeenCalledWith(
      COMMAND_ID,
      { status: 'succeeded' },
      { runEntityId: RUN_ID }
    )
    // The run id is bound as EVIDENCE, never substituted for the commandId.
    expect(dispatchSettled.mock.calls[0]![0]).toBe(COMMAND_ID)
    expect(RUN_ID).not.toBe(COMMAND_ID)
  })

  it('drives an ensemble prepared view to starting and then a settlement binding the ROUND entity', () => {
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    const order: string[] = []
    starting.mockImplementation(() => order.push('starting'))
    dispatchSettled.mockImplementation(() => order.push('settled'))

    expect(bridge.onPrepared(preparedEnsemble())).toEqual({
      kind: 'started',
      commandId: COMMAND_ID,
      roundEntityId: 'round-1'
    })
    expect(order).toEqual(['starting', 'settled'])

    const startingView = starting.mock.calls[0]![0] as HostQueuedStartStartedView
    expect(startingView).toEqual({
      commandId: COMMAND_ID,
      threadId: THREAD_ID,
      fingerprint: FINGERPRINT,
      phase: 'starting',
      startedEvidence: false,
      terminalOutcome: null
    })
    expect(startingView).not.toHaveProperty('executionClaimCursor')

    expect(dispatchSettled).toHaveBeenCalledTimes(1)
    expect(dispatchSettled).toHaveBeenCalledWith(
      COMMAND_ID,
      { status: 'succeeded' },
      { roundEntityId: 'round-1' }
    )
    // EXACTLY ONE entity is bound. Binding a participant run beside the round
    // would be refused incoherent by the coordinator — and there is no
    // participant runId at the round-start persist boundary to bind anyway.
    const bound = dispatchSettled.mock.calls[0]![2] as HostQueuedStartEntities
    expect(bound).not.toHaveProperty('runEntityId')
    expect(Object.keys(bound)).toEqual(['roundEntityId'])
    // The round id is evidence: the receipt is still addressed by commandId.
    expect(dispatchSettled.mock.calls[0]![0]).toBe(COMMAND_ID)
  })

  it('refuses an ensemble prepared view carrying no usable round id and calls the Authority not at all', () => {
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
    const roundless = {
      ...preparedEnsemble(),
      prepared: {
        start: { kind: 'ensemble', roundId: '', participantRunIds: ['run-a'] },
        effectRefs: [{ family: 'thread', entityId: THREAD_ID }]
      }
    } as HostBridgeQueuedStartView

    expect(bridge.onPrepared(roundless)).toEqual({
      kind: 'refused',
      reason: 'missing_round_identity'
    })
    expect(starting).not.toHaveBeenCalled()
    expect(dispatchSettled).not.toHaveBeenCalled()
    expect(bridge.forwardedCount()).toBe(0)

    // The refusal must not be a one-shot: a later solo start still works.
    expect(bridge.onPrepared(preparedSolo()).kind).toBe('started')
  })

  it('refuses a started settlement it never drove a prepared for rather than succeeding it', () => {
    // The absorb race: the send registered with no live round, then the
    // orchestrator absorbed it into a round that started meanwhile, so no
    // `prepared` ever arrived. We hold no proof of the start.
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(bridge.onSettled(settled('started'))).toEqual({
      kind: 'refused',
      reason: 'started_without_prepared_evidence'
    })
    // Never succeeded, and never terminalized as failed either — the prompt
    // may well have been delivered. The Authority is not called at all.
    expect(starting).not.toHaveBeenCalled()
    expect(dispatchSettled).not.toHaveBeenCalled()
    expect(bridge.forwardedCount()).toBe(0)
  })

  it.each([
    { status: 'failed' as const, errorCode: 'provider_rejected' },
    { status: 'cancelled' as const, errorCode: undefined }
  ])('terminalizes a $status settlement exactly once', ({ status, errorCode }) => {
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(bridge.onSettled(settled(status, errorCode))).toEqual({
      kind: 'terminalized',
      commandId: COMMAND_ID,
      status
    })
    expect(starting).not.toHaveBeenCalled()
    expect(dispatchSettled).toHaveBeenCalledTimes(1)
    expect(dispatchSettled).toHaveBeenCalledWith(COMMAND_ID, {
      status,
      ...(errorCode !== undefined ? { errorCode } : {})
    })

    // Repeat delivery must not issue a second terminal decision.
    expect(bridge.onSettled(settled(status, errorCode))).toEqual({
      kind: 'refused',
      reason: 'already_forwarded'
    })
    expect(dispatchSettled).toHaveBeenCalledTimes(1)
  })

  it('ignores a started settlement because prepared already published success', () => {
    const { port, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(bridge.onPrepared(preparedSolo()).kind).toBe('started')
    expect(dispatchSettled).toHaveBeenCalledTimes(1)

    expect(bridge.onSettled(settled('started'))).toEqual({
      kind: 'ignored',
      reason: 'started_settlement_already_published'
    })
    expect(dispatchSettled).toHaveBeenCalledTimes(1)
  })

  it('maps an adapter publication failure onto one terminalizing settlement', () => {
    const { port, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
    const failure: HostBridgeQueuedStartFailure = {
      hostCommandActionId: ACTION_ID,
      threadId: THREAD_ID,
      reason: 'publication_failed'
    }

    expect(bridge.onFailure(failure)).toEqual({
      kind: 'terminalized',
      commandId: COMMAND_ID,
      status: 'failed'
    })
    expect(dispatchSettled).toHaveBeenCalledWith(COMMAND_ID, {
      status: 'failed',
      errorCode: 'publication_failed'
    })

    expect(bridge.onFailure(failure)).toEqual({ kind: 'refused', reason: 'already_forwarded' })
    expect(dispatchSettled).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'client-shaped action id', value: 'client:action:abc' },
    { label: 'uppercase uuid', value: `host:command:${COMMAND_ID.toUpperCase()}` },
    { label: 'non-uuid suffix', value: 'host:command:not-a-uuid' },
    { label: 'bare prefix', value: 'host:command:' }
  ])('refuses a $label rather than addressing a Host receipt', ({ value }) => {
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
    const bad = { ...preparedSolo(), hostCommandActionId: value } as HostBridgeQueuedStartView

    expect(bridge.onPrepared(bad)).toEqual({ kind: 'refused', reason: 'invalid_action_id' })
    expect(starting).not.toHaveBeenCalled()
    expect(dispatchSettled).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'prepared',
      run: (b: ReturnType<typeof createHostBridgeQueuedStartPublicationBridge>) =>
        b.onPrepared(view({ phase: 'prepared' })),
      reason: 'missing_prepared_evidence'
    },
    {
      label: 'settled',
      run: (b: ReturnType<typeof createHostBridgeQueuedStartPublicationBridge>) =>
        b.onSettled(view({ phase: 'settled' })),
      reason: 'missing_settled_evidence'
    }
  ])('refuses a $label view carrying no evidence', ({ run, reason }) => {
    const { port, starting, dispatchSettled } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(run(bridge)).toEqual({ kind: 'refused', reason })
    expect(starting).not.toHaveBeenCalled()
    expect(dispatchSettled).not.toHaveBeenCalled()
  })
})

describe('restart residual', () => {
  it('leaves a restart-promoted receipt alone when a re-flush settles an unregistered command', () => {
    // A remote-queue job survives a Host restart. Its flush reports a settled
    // start against the ORIGINAL commandId, but the coordinator that held the
    // pending registration died with the process. The bound run entity must
    // not resurrect that receipt.
    const getReceipt = vi.fn(() => ({ kind: 'missing' }) as never)
    const completeReceipt = vi.fn(() => null)
    const markIndeterminate = vi.fn(() => ({ kind: 'updated' }) as never)
    const updateReceiptPhase = vi.fn(() => ({ kind: 'updated' }) as never)
    const readScopedFamilies = vi.fn()
    const publishEffects = vi.fn()

    const publication = createHostQueuedStartPublication({
      getReceipt,
      completeReceipt,
      markIndeterminate,
      updateReceiptPhase,
      readScopedFamilies: readScopedFamilies as never,
      publishEffects: publishEffects as never,
      getPosition: () => ({ generation: 1, cursor: 1 }),
      now: () => '2026-09-22T00:00:00.000Z'
    })

    expect(publication.pendingCount()).toBe(0)
    publication.completeStart(COMMAND_ID, { runEntityId: RUN_ID })

    // Silent: no phase write, no completion, and no indeterminate re-stamp.
    // The receipt keeps whatever the restart promotion left on it.
    expect(updateReceiptPhase).not.toHaveBeenCalled()
    expect(completeReceipt).not.toHaveBeenCalled()
    expect(markIndeterminate).not.toHaveBeenCalled()
    expect(readScopedFamilies).not.toHaveBeenCalled()
    expect(publishEffects).not.toHaveBeenCalled()
    expect(publication.inFlightCount()).toBe(0)
  })
})

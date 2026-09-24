import { describe, expect, it, vi } from 'vitest'

import {
  createHostQueuedStartPublication,
  type HostQueuedStartEntities,
  type HostQueuedStartStartedView
} from '../../host-runtime/HostQueuedStartPublication'
import type { HostCommandExecutionResult } from '../../host-runtime/HostCommandExecutionResult'
import {
  createHostBridgeQueuedStartAdapter,
  type HostBridgeQueuedStartFailure,
  type HostBridgeQueuedStartView
} from './HostBridgeQueuedStartAdapter'
import {
  createHostBridgeQueuedStartPublicationBridge,
  type HostBridgeQueuedStartAuthorityPort,
  type HostBridgeQueuedStartPublicationBridge,
  type HostBridgeQueuedStartPublicationResult
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
  abort: ReturnType<typeof vi.fn>
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
  const abort = vi.fn<(commandId: string) => void>()
  return {
    port: {
      handleQueuedStartStarting: starting,
      handleQueuedStartDispatchSettled: dispatchSettled,
      abortQueuedStart: abort
    },
    starting,
    dispatchSettled,
    abort
  }
}

function publicationFailure(): HostBridgeQueuedStartFailure {
  return { hostCommandActionId: ACTION_ID, threadId: THREAD_ID, reason: 'publication_failed' }
}

function connectedAdapter(bridge: HostBridgeQueuedStartPublicationBridge) {
  const failures: HostBridgeQueuedStartPublicationResult[] = []
  const adapter = createHostBridgeQueuedStartAdapter({
    runProjectionOperation: async (operation) => operation(),
    onPrepared: (prepared) => {
      bridge.onPrepared(prepared)
    },
    onSettled: (terminal) => {
      bridge.onSettled(terminal)
    },
    onFailure: (failure) => {
      failures.push(bridge.onFailure(failure))
    }
  })
  adapter.register({
    hostCommandActionId: ACTION_ID,
    threadId: THREAD_ID,
    authority: AUTHORITY_IDENTITY
  })
  return { adapter, failures }
}

describe('createHostBridgeQueuedStartPublicationBridge', () => {
  it('refuses construction without a usable authority port', () => {
    expect(() =>
      createHostBridgeQueuedStartPublicationBridge({
        authority: {} as unknown as HostBridgeQueuedStartAuthorityPort
      })
    ).toThrow(/requires an injected authority port/)
  })

  it('refuses construction when the port cannot abandon proof', () => {
    // `abortQueuedStart` is required, not optional: without it the absorb race
    // would silently fall back to leaving the receipt pending forever.
    const { starting, dispatchSettled } = spyAuthority()
    expect(() =>
      createHostBridgeQueuedStartPublicationBridge({
        authority: {
          handleQueuedStartStarting: starting,
          handleQueuedStartDispatchSettled: dispatchSettled
        } as unknown as HostBridgeQueuedStartAuthorityPort
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
    const { port, starting, dispatchSettled, abort } = spyAuthority()
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
    // A proven start never abandons proof.
    expect(abort).not.toHaveBeenCalled()
  })

  it('drives an ensemble prepared view to starting and then a settlement binding the ROUND entity', () => {
    const { port, starting, dispatchSettled, abort } = spyAuthority()
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
    // A proven start never abandons proof.
    expect(abort).not.toHaveBeenCalled()
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

  it('terminalizes a started settlement it never drove a prepared for as INDETERMINATE', () => {
    // The absorb race: the send registered with no live round, then the
    // orchestrator absorbed it into a round that started meanwhile, so no
    // `prepared` ever arrived. We hold no proof of the start.
    const { port, starting, dispatchSettled, abort } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(bridge.onSettled(settled('started'))).toEqual({
      kind: 'terminalized',
      commandId: COMMAND_ID,
      status: 'indeterminate'
    })
    // Proof is abandoned exactly once, against this command's own id.
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledWith(COMMAND_ID)

    // THE SAFETY HALF, unchanged from the refusal this replaced: the receipt
    // is never succeeded and never settled as failed. An abandonment of proof
    // is not an execution result, so the settlement port is not touched at all.
    expect(dispatchSettled).not.toHaveBeenCalled()
    expect(starting).not.toHaveBeenCalled()
    expect(bridge.forwardedCount()).toBe(1)
  })

  it('abandons proof only once for a repeated started settlement with no prepared', () => {
    const { port, dispatchSettled, abort } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(bridge.onSettled(settled('started')).kind).toBe('terminalized')
    expect(bridge.onSettled(settled('started'))).toEqual({
      kind: 'refused',
      reason: 'already_forwarded'
    })
    // The terminal fence covers abandonment too: a redelivery re-stamps nothing.
    expect(abort).toHaveBeenCalledTimes(1)
    expect(dispatchSettled).not.toHaveBeenCalled()
  })

  it('ignores a late prepared or started view arriving after proof was abandoned', () => {
    const { port, starting, dispatchSettled, abort } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })

    expect(bridge.onSettled(settled('started')).kind).toBe('terminalized')
    abort.mockClear()

    // Outcome, not mechanism: whatever arrives late for this command, the
    // receipt is neither abandoned a second time nor settled.
    bridge.onPrepared(preparedSolo())
    bridge.onSettled(settled('started'))
    expect(abort).not.toHaveBeenCalled()
    expect(dispatchSettled).not.toHaveBeenCalled()
    expect(starting).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'failed' as const, errorCode: 'provider_rejected' },
    { status: 'cancelled' as const, errorCode: undefined }
  ])('terminalizes a $status settlement exactly once', ({ status, errorCode }) => {
    const { port, starting, dispatchSettled, abort } = spyAuthority()
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
    expect(bridge.onFailure(publicationFailure())).toEqual({
      kind: 'refused',
      reason: 'already_forwarded'
    })
    expect(abort).not.toHaveBeenCalled()
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

  it('maps an adapter publication failure onto one indeterminate abort', () => {
    const { port, dispatchSettled, abort } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
    const failure: HostBridgeQueuedStartFailure = {
      hostCommandActionId: ACTION_ID,
      threadId: THREAD_ID,
      reason: 'publication_failed'
    }

    expect(bridge.onFailure(failure)).toEqual({
      kind: 'terminalized',
      commandId: COMMAND_ID,
      status: 'indeterminate'
    })
    expect(abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(dispatchSettled).not.toHaveBeenCalled()

    expect(bridge.onFailure(failure)).toEqual({ kind: 'refused', reason: 'already_forwarded' })
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it.each([
    { mode: 'solo', phase: 'starting' },
    { mode: 'solo', phase: 'settlement' },
    { mode: 'ensemble', phase: 'starting' },
    { mode: 'ensemble', phase: 'settlement' }
  ])(
    'aborts once when a real adapter $mode prepared callback throws during $phase',
    async ({ mode, phase }) => {
      const { port, starting, dispatchSettled, abort } = spyAuthority()
      const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
      const { adapter, failures } = connectedAdapter(bridge)
      const callback = phase === 'starting' ? starting : dispatchSettled
      callback.mockImplementation(() => {
        throw new Error('publication failed after possible mutation')
      })
      const prepared = (mode === 'solo' ? preparedSolo() : preparedEnsemble()).prepared!
      const event = {
        kind: 'prepared' as const,
        hostCommandActionId: ACTION_ID,
        threadId: THREAD_ID,
        durablePromptAndStartPersisted: true as const,
        ...prepared
      }
      expect(await adapter.prepared(event)).toEqual({
        kind: 'failed',
        reason: 'publication_failed'
      })
      expect(failures).toEqual([
        { kind: 'terminalized', commandId: COMMAND_ID, status: 'indeterminate' }
      ])
      expect(abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      if (phase === 'starting') expect(dispatchSettled).not.toHaveBeenCalled()
      else {
        expect(dispatchSettled).toHaveBeenCalledOnce()
        expect(dispatchSettled).toHaveBeenCalledWith(
          COMMAND_ID,
          { status: 'succeeded' },
          mode === 'solo' ? { runEntityId: RUN_ID } : { roundEntityId: 'round-1' }
        )
      }
      expect(bridge.forwardedCount()).toBe(1)
      expect(await adapter.prepared(event)).toEqual({ kind: 'refused', reason: 'terminal' })
      expect(bridge.onFailure(publicationFailure())).toEqual({
        kind: 'refused',
        reason: 'already_forwarded'
      })
      expect(bridge.onSettled(settled('started'))).toEqual({
        kind: 'refused',
        reason: 'already_forwarded'
      })
      expect(abort).toHaveBeenCalledOnce()
      expect(starting).toHaveBeenCalledOnce()
    }
  )

  it.each(['failed', 'cancelled'] as const)(
    'abandons a throwing real adapter %s settlement without retrying it',
    async (status) => {
      const { port, dispatchSettled, abort } = spyAuthority()
      const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
      const { adapter, failures } = connectedAdapter(bridge)
      dispatchSettled.mockImplementation(() => {
        throw new Error('terminal publication failed')
      })
      expect(
        await adapter.settled({
          kind: 'settled',
          hostCommandActionId: ACTION_ID,
          threadId: THREAD_ID,
          status
        })
      ).toEqual({ kind: 'failed', reason: 'publication_failed' })
      expect(failures).toEqual([
        { kind: 'terminalized', commandId: COMMAND_ID, status: 'indeterminate' }
      ])
      expect(dispatchSettled).toHaveBeenCalledExactlyOnceWith(COMMAND_ID, { status })
      expect(abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(bridge.onFailure(publicationFailure())).toEqual({
        kind: 'refused',
        reason: 'already_forwarded'
      })
      expect(abort).toHaveBeenCalledOnce()
    }
  )

  it('does not erase the abort exception or replay an unconfirmed prepared publication', () => {
    const { port, starting, dispatchSettled, abort } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
    dispatchSettled.mockImplementation(() => {
      throw new Error('after mutation')
    })
    expect(() => bridge.onPrepared(preparedSolo())).toThrow('after mutation')
    expect(bridge.onPrepared(preparedSolo())).toEqual({
      kind: 'refused',
      reason: 'already_forwarded'
    })
    expect(bridge.onFailure(publicationFailure())).toEqual({
      kind: 'terminalized',
      commandId: COMMAND_ID,
      status: 'indeterminate'
    })
    expect(starting).toHaveBeenCalledOnce()
    expect(dispatchSettled).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
  })

  it.each(['starting', 'settlement'] as const)(
    'contains reentrant failure during %s without confirming a start',
    (phase) => {
      const { port, starting, dispatchSettled, abort } = spyAuthority()
      const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
      const callback = phase === 'starting' ? starting : dispatchSettled
      callback.mockImplementation(() => {
        expect(bridge.onPrepared(preparedSolo())).toEqual({
          kind: 'refused',
          reason: 'already_forwarded'
        })
        bridge.onFailure(publicationFailure())
      })
      expect(bridge.onPrepared(preparedSolo())).toEqual({
        kind: 'terminalized',
        commandId: COMMAND_ID,
        status: 'indeterminate'
      })
      expect(bridge.onSettled(settled('started'))).toEqual({
        kind: 'refused',
        reason: 'already_forwarded'
      })
      expect(abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(starting).toHaveBeenCalledOnce()
      expect(dispatchSettled).toHaveBeenCalledTimes(phase === 'starting' ? 0 : 1)
    }
  )

  it('does not abandon a normally completed prepared publication on a duplicate failure', () => {
    const { port, starting, dispatchSettled, abort } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
    expect(bridge.onPrepared(preparedSolo()).kind).toBe('started')
    expect(bridge.onFailure(publicationFailure())).toEqual({
      kind: 'refused',
      reason: 'already_forwarded'
    })
    expect(abort).not.toHaveBeenCalled()
    expect(starting).toHaveBeenCalledOnce()
    expect(dispatchSettled).toHaveBeenCalledOnce()
  })

  it('does not retry an abort which mutates then throws on the real adapter failure path', async () => {
    const { port, starting, dispatchSettled, abort } = spyAuthority()
    const bridge = createHostBridgeQueuedStartPublicationBridge({ authority: port })
    const { adapter } = connectedAdapter(bridge)
    let promoted = false
    starting.mockImplementation(() => {
      throw new Error('start publication failed')
    })
    abort.mockImplementation(() => {
      promoted = true
      throw new Error('after indeterminate mutation')
    })
    const prepared = preparedSolo().prepared!
    expect(
      await adapter.prepared({
        kind: 'prepared',
        hostCommandActionId: ACTION_ID,
        threadId: THREAD_ID,
        durablePromptAndStartPersisted: true,
        ...prepared
      })
    ).toEqual({ kind: 'failed', reason: 'publication_failed' })
    expect(promoted).toBe(true)
    expect(abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(dispatchSettled).not.toHaveBeenCalled()
    expect(bridge.onFailure(publicationFailure())).toEqual({
      kind: 'refused',
      reason: 'already_forwarded'
    })
    expect(abort).toHaveBeenCalledOnce()
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

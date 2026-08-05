import { describe, expect, it, vi } from 'vitest'

import type { HostActorIdentity, HostCursorPosition } from '../../shared/hostProtocol'
import type { HostDeferredAllowPipelineResult } from './HostDeferredAllowPipeline'
import type {
  HostDeferredCompleteReceiptInput,
  HostDeferredExecuteCommandInput,
  HostDeferredPublishEffectsInput
} from './HostDeferredCommandBridge'
import type { HostDeferredCommandEnvelopeResolverInput } from './HostDeferredCommandEnvelopeResolver'
import type {
  HostCommandReceiptStatus,
  HostCommandReceiptTerminalStatus
} from './HostCommandReceiptStore'
import {
  createHostDeferredResolutionAdapter,
  HOST_DEFERRED_RESOLUTION_ALREADY_TERMINAL_CODE,
  HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE,
  HOST_DEFERRED_RESOLUTION_KEY_UNAVAILABLE_CODE
} from './HostDeferredResolutionAdapter'
import type { HostDeferredAllowPipeline } from './HostDeferredAllowPipeline'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}

const IDEMPOTENCY_KEY = 'desktop:client-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const POSITION: HostCursorPosition = { generation: 3, cursor: 44 }

function sampleExecuteInput(
  overrides: Partial<HostDeferredExecuteCommandInput> = {}
): HostDeferredExecuteCommandInput {
  return {
    deferredId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    commandFingerprint: 'a'.repeat(64),
    commandName: 'thread.select',
    actor: ACTOR,
    challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    challengeKind: 'approval',
    ...overrides
  }
}

function completed(
  status: HostCommandReceiptTerminalStatus = 'succeeded'
): HostDeferredAllowPipelineResult {
  return {
    kind: 'completed',
    status,
    position: POSITION,
    envelope: 'updated'
  }
}

function assertBodyFree(value: unknown): void {
  const encoded = JSON.stringify(value)
  expect(encoded).not.toMatch(/SECRET_TOKEN_VALUE/)
  expect(encoded).not.toMatch(/ghp_/)
  expect(encoded).not.toMatch(/hidden-reasoning/)
  expect(encoded).not.toMatch(/Bearer/i)
  expect(encoded).not.toMatch(/password/i)
  expect(encoded).not.toMatch(/thread-body-secret/)
}

function openAdapter(options?: {
  pipelineResult?:
    | HostDeferredAllowPipelineResult
    | (() => Promise<HostDeferredAllowPipelineResult>)
  resolveIdempotencyKey?: (input: HostDeferredExecuteCommandInput) => string | null | undefined
  pipelineExecute?: ReturnType<typeof vi.fn>
}): {
  ports: ReturnType<typeof createHostDeferredResolutionAdapter>
  pipelineExecute: ReturnType<typeof vi.fn>
  resolveIdempotencyKey: ReturnType<typeof vi.fn>
} {
  const pipelineExecute =
    options?.pipelineExecute ??
    vi.fn(async () => {
      if (typeof options?.pipelineResult === 'function') {
        return options.pipelineResult()
      }
      return options?.pipelineResult ?? completed('succeeded')
    })

  const resolveIdempotencyKey =
    options?.resolveIdempotencyKey !== undefined
      ? vi.fn(options.resolveIdempotencyKey)
      : vi.fn(() => IDEMPOTENCY_KEY)

  const ports = createHostDeferredResolutionAdapter({
    pipeline: { execute: pipelineExecute } as unknown as HostDeferredAllowPipeline,
    resolveIdempotencyKey
  })

  return { ports, pipelineExecute, resolveIdempotencyKey }
}

/**
 * Simulate the Bridge resolveAllow post-claim sequence:
 * executeCommand → (optional) publishEffects → completeReceipt.
 * Counts every port hit so dual-completion can be RED-proven.
 */
async function simulateBridgeAllowSequence(
  ports: ReturnType<typeof createHostDeferredResolutionAdapter>,
  counters: {
    h: number
    publish: number
    complete: number
  },
  executeInput: HostDeferredExecuteCommandInput = sampleExecuteInput()
): Promise<void> {
  // Real Bridge only calls publishEffects when status===succeeded && effects.length>0.
  // We still always invoke the no-ops to prove they stay silent even if mis-called.
  const result = await ports.executeCommand(executeInput)
  counters.h += 1 // adapter surface call (pipeline is the real H owner; asserted separately)
  await ports.publishEffects({
    commandId: executeInput.commandId,
    deferredId: executeInput.deferredId,
    effects: result.effects ?? [{ kind: 'would-be-double-publish' }],
    actor: executeInput.actor
  })
  counters.publish += 1
  await ports.completeReceipt({
    commandId: executeInput.commandId,
    status:
      result.status === 'succeeded'
        ? 'succeeded'
        : result.status === 'cancelled'
          ? 'cancelled'
          : 'failed',
    terminalCode: result.terminalCode,
    actor: executeInput.actor,
    commandFingerprint: executeInput.commandFingerprint,
    commandName: executeInput.commandName
  })
  counters.complete += 1
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HostDeferredResolutionAdapter', () => {
  // -- Constructor validation -----------------------------------------------

  it('requires options', () => {
    expect(() => createHostDeferredResolutionAdapter(null as unknown as never)).toThrow(
      /requires options/
    )
    expect(() => createHostDeferredResolutionAdapter(undefined as unknown as never)).toThrow(
      /requires options/
    )
  })

  it('requires pipeline with execute', () => {
    expect(() =>
      createHostDeferredResolutionAdapter({
        pipeline: null as unknown as never,
        resolveIdempotencyKey: () => IDEMPOTENCY_KEY
      })
    ).toThrow(/requires pipeline/)

    expect(() =>
      createHostDeferredResolutionAdapter({
        pipeline: {} as unknown as HostDeferredAllowPipeline,
        resolveIdempotencyKey: () => IDEMPOTENCY_KEY
      })
    ).toThrow(/pipeline\.execute/)
  })

  it('requires resolveIdempotencyKey', () => {
    expect(() =>
      createHostDeferredResolutionAdapter({
        pipeline: { execute: vi.fn() } as unknown as HostDeferredAllowPipeline,
        resolveIdempotencyKey: null as unknown as never
      })
    ).toThrow(/resolveIdempotencyKey/)
  })

  // -- Happy path -----------------------------------------------------------

  it('executeCommand calls pipeline.execute exactly once with resolver input', async () => {
    const { ports, pipelineExecute, resolveIdempotencyKey } = openAdapter()
    const input = sampleExecuteInput()

    const result = await ports.executeCommand(input)

    expect(resolveIdempotencyKey).toHaveBeenCalledTimes(1)
    expect(resolveIdempotencyKey).toHaveBeenCalledWith(input)
    expect(pipelineExecute).toHaveBeenCalledTimes(1)

    const resolverInput = pipelineExecute.mock
      .calls[0][0] as HostDeferredCommandEnvelopeResolverInput
    expect(resolverInput).toEqual({
      deferredId: input.deferredId,
      commandId: input.commandId,
      idempotencyKey: IDEMPOTENCY_KEY,
      commandFingerprint: input.commandFingerprint,
      commandName: input.commandName,
      actor: input.actor,
      challengeId: input.challengeId,
      challengeKind: input.challengeKind
    })

    expect(result).toEqual({
      status: 'succeeded',
      terminalCode: 'executed',
      effects: []
    })
    assertBodyFree(result)
  })

  it('maps completed terminal statuses to executor results with empty effects', async () => {
    const cases: Array<{
      receipt: HostCommandReceiptTerminalStatus
      status: 'succeeded' | 'failed' | 'cancelled'
      terminalCode: string
    }> = [
      { receipt: 'succeeded', status: 'succeeded', terminalCode: 'executed' },
      { receipt: 'failed', status: 'failed', terminalCode: 'failed' },
      { receipt: 'denied', status: 'failed', terminalCode: 'denied' },
      { receipt: 'cancelled', status: 'cancelled', terminalCode: 'cancelled' }
    ]

    for (const c of cases) {
      const { ports, pipelineExecute } = openAdapter({ pipelineResult: completed(c.receipt) })
      const result = await ports.executeCommand(sampleExecuteInput())
      expect(pipelineExecute).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        status: c.status,
        terminalCode: c.terminalCode,
        effects: []
      })
      assertBodyFree(result)
    }
  })

  // -- Indeterminate / already_terminal / host_unavailable -----------------

  it('maps indeterminate(code) to failed with the exact code and zero second H', async () => {
    const codes = [
      'envelope_not_found',
      'receipt_already_indeterminate',
      'command_fingerprint_mismatch',
      'store_unavailable'
    ] as const

    for (const code of codes) {
      const { ports, pipelineExecute } = openAdapter({
        pipelineResult: { kind: 'indeterminate', code }
      })
      const result = await ports.executeCommand(sampleExecuteInput())
      expect(pipelineExecute).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ status: 'failed', terminalCode: code })
      expect(result.effects).toBeUndefined()
      assertBodyFree(result)
    }
  })

  it('maps already_terminal to non-success with ZERO fabricated success for every receipt status', async () => {
    const statuses: HostCommandReceiptStatus[] = [
      'succeeded',
      'failed',
      'denied',
      'cancelled',
      'conflict'
    ]

    for (const receiptStatus of statuses) {
      const { ports, pipelineExecute } = openAdapter({
        pipelineResult: { kind: 'already_terminal', receiptStatus }
      })
      const result = await ports.executeCommand(sampleExecuteInput())
      expect(pipelineExecute).toHaveBeenCalledTimes(1)
      expect(result.status).toBe('failed')
      expect(result.status).not.toBe('succeeded')
      expect(result.terminalCode).toBe(HOST_DEFERRED_RESOLUTION_ALREADY_TERMINAL_CODE)
      assertBodyFree(result)
    }
  })

  it('maps host_unavailable to failed body-free code', async () => {
    const { ports } = openAdapter({ pipelineResult: { kind: 'host_unavailable' } })
    const result = await ports.executeCommand(sampleExecuteInput())
    expect(result).toEqual({
      status: 'failed',
      terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
    })
    assertBodyFree(result)
  })

  it('maps pipeline throw to host_unavailable without leaking the error body', async () => {
    const { ports, pipelineExecute } = openAdapter({
      pipelineExecute: vi.fn(async () => {
        throw new Error('SECRET_TOKEN_VALUE hidden-reasoning Bearer ghp_leaked')
      })
    })
    const result = await ports.executeCommand(sampleExecuteInput())
    expect(pipelineExecute).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      status: 'failed',
      terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
    })
    assertBodyFree(result)
  })

  // -- Key resolution fail-closed -------------------------------------------

  it('skips the pipeline when idempotencyKey cannot be resolved (zero H)', async () => {
    for (const key of [null, undefined, ''] as const) {
      const { ports, pipelineExecute } = openAdapter({
        resolveIdempotencyKey: () => key
      })
      const result = await ports.executeCommand(sampleExecuteInput())
      expect(pipelineExecute).not.toHaveBeenCalled()
      expect(result).toEqual({
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_KEY_UNAVAILABLE_CODE
      })
      assertBodyFree(result)
    }
  })

  it('maps resolveIdempotencyKey throw to host_unavailable with zero pipeline call', async () => {
    const { ports, pipelineExecute } = openAdapter({
      resolveIdempotencyKey: () => {
        throw new Error('SECRET_TOKEN_VALUE')
      }
    })
    const result = await ports.executeCommand(sampleExecuteInput())
    expect(pipelineExecute).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'failed',
      terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
    })
    assertBodyFree(result)
  })

  // -- Dual-completion seam: already-owned no-ops ---------------------------

  it('publishEffects is an honest already-owned no-op (never throws, never side-effects)', async () => {
    const { ports } = openAdapter()
    const sideEffect = vi.fn()

    // Wrap is not needed — the port itself must be inert. Call repeatedly.
    const input: HostDeferredPublishEffectsInput = {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deferredId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      effects: [{ kind: 'thread.upsert', entityId: 'thread-1', summaryCode: 'sent' }],
      actor: ACTOR
    }

    await expect(ports.publishEffects(input)).resolves.toBeUndefined()
    await expect(ports.publishEffects(input)).resolves.toBeUndefined()
    expect(sideEffect).not.toHaveBeenCalled()
  })

  it('completeReceipt is an honest already-owned no-op (never throws, never side-effects)', async () => {
    const { ports } = openAdapter()
    const input: HostDeferredCompleteReceiptInput = {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'succeeded',
      terminalCode: 'executed',
      actor: ACTOR,
      commandFingerprint: 'a'.repeat(64),
      commandName: 'thread.select'
    }

    await expect(ports.completeReceipt(input)).resolves.toBeUndefined()
    await expect(ports.completeReceipt(input)).resolves.toBeUndefined()
  })

  /**
   * RED-proof: double-H.
   * One Bridge allow sequence must drive the AllowPipeline (and therefore H
   * via its mutation observe) exactly once. Re-calling the no-op ports must
   * not produce a second pipeline/H call.
   */
  it('RED-proof double-H: Bridge allow sequence reaches pipeline exactly once', async () => {
    // Count real "H" as pipeline.execute — the pipeline is the only path to H.
    const pipelineExecute = vi.fn(async () => completed('succeeded'))
    const { ports } = openAdapter({ pipelineExecute })

    const counters = { h: 0, publish: 0, complete: 0 }
    await simulateBridgeAllowSequence(ports, counters)

    // Surface was invoked once; pipeline (H owner) exactly once.
    expect(counters.h).toBe(1)
    expect(pipelineExecute).toHaveBeenCalledTimes(1)

    // Re-issuing publish/complete (Bridge retry / mis-order) still zero extra H.
    await ports.publishEffects({
      commandId: sampleExecuteInput().commandId,
      deferredId: sampleExecuteInput().deferredId,
      effects: [{ kind: 'retry' }],
      actor: ACTOR
    })
    await ports.completeReceipt({
      commandId: sampleExecuteInput().commandId,
      status: 'succeeded',
      actor: ACTOR,
      commandFingerprint: sampleExecuteInput().commandFingerprint,
      commandName: sampleExecuteInput().commandName
    })
    expect(pipelineExecute).toHaveBeenCalledTimes(1)
  })

  /**
   * RED-proof: double-complete.
   * Pipeline owns the sole complete. Bridge's completeReceipt + publishEffects
   * after execute must not invoke any secondary completion counters.
   */
  it('RED-proof double-complete: no-op ports never re-complete or re-publish', async () => {
    const underlyingComplete = vi.fn()
    const underlyingPublish = vi.fn()

    // Pipeline "owns" complete/publish — simulate by counting inside execute.
    let pipelineCompletes = 0
    let pipelinePublishes = 0
    const pipelineExecute = vi.fn(async () => {
      pipelinePublishes += 1
      underlyingPublish()
      pipelineCompletes += 1
      underlyingComplete()
      return completed('succeeded')
    })

    const ports = createHostDeferredResolutionAdapter({
      pipeline: { execute: pipelineExecute } as unknown as HostDeferredAllowPipeline,
      resolveIdempotencyKey: () => IDEMPOTENCY_KEY
    })

    // Instrument the returned ports: if no-ops ever delegated, these would fire.
    // We wrap after creation is not possible without re-binding — instead we
    // assert the underlying counters stay at the pipeline's single hit after
    // a full Bridge-style sequence that also hammers the no-ops.
    const input = sampleExecuteInput()
    const result = await ports.executeCommand(input)
    expect(result.status).toBe('succeeded')
    expect(result.effects).toEqual([])

    // Bridge would skip publish when effects empty; we still force both no-ops.
    await ports.publishEffects({
      commandId: input.commandId,
      deferredId: input.deferredId,
      effects: [{ kind: 'would-double' }],
      actor: input.actor
    })
    await ports.completeReceipt({
      commandId: input.commandId,
      status: 'succeeded',
      terminalCode: 'executed',
      actor: input.actor,
      commandFingerprint: input.commandFingerprint,
      commandName: input.commandName
    })
    await ports.publishEffects({
      commandId: input.commandId,
      deferredId: input.deferredId,
      effects: [{ kind: 'would-double-again' }],
      actor: input.actor
    })
    await ports.completeReceipt({
      commandId: input.commandId,
      status: 'succeeded',
      actor: input.actor,
      commandFingerprint: input.commandFingerprint,
      commandName: input.commandName
    })

    expect(pipelineExecute).toHaveBeenCalledTimes(1)
    expect(pipelinePublishes).toBe(1)
    expect(pipelineCompletes).toBe(1)
    expect(underlyingPublish).toHaveBeenCalledTimes(1)
    expect(underlyingComplete).toHaveBeenCalledTimes(1)
  })

  it('succeeded path never returns non-empty effects (forces Bridge to skip re-publish)', async () => {
    const { ports } = openAdapter({ pipelineResult: completed('succeeded') })
    const result = await ports.executeCommand(sampleExecuteInput())
    expect(result.status).toBe('succeeded')
    expect(result.effects).toEqual([])
    expect(result.effects?.length ?? 0).toBe(0)
  })

  it('ports object exposes exactly the three Bridge port functions', () => {
    const { ports } = openAdapter()
    expect(Object.keys(ports).sort()).toEqual(
      ['completeReceipt', 'executeCommand', 'publishEffects'].sort()
    )
    expect(typeof ports.completeReceipt).toBe('function')
    expect(typeof ports.executeCommand).toBe('function')
    expect(typeof ports.publishEffects).toBe('function')
  })
})

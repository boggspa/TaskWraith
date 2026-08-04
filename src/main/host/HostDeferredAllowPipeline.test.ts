import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand,
  type HostCursorPosition
} from '../../shared/hostProtocol'
import type { HostCommandMutationPipeline } from './HostCommandMutationPipeline'
import type { HostMutationCompletionResult } from './HostMutationCompletionCoordinator'
import type {
  HostDeferredCommandEnvelopeResolverIndeterminateCode,
  HostDeferredCommandEnvelopeResolverInput,
  HostDeferredCommandEnvelopeResolverVerifyResult
} from './HostDeferredCommandEnvelopeResolver'
import type {
  HostCommandReceiptIndeterminateCode,
  HostCommandReceiptStatus
} from './HostCommandReceiptStore'
import {
  HostDeferredAllowPipeline,
  type HostDeferredAllowPipelineConsumeEnvelope
} from './HostDeferredAllowPipeline'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}

function sampleCommand(overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: 'desktop:client-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    actor: ACTOR,
    name: 'thread.select',
    target: { threadId: 'thread-1' },
    arguments: {},
    issuedAt: '2026-08-04T00:00:00.000Z',
    ...overrides
  }
}

function sampleInput(
  overrides: Partial<HostDeferredCommandEnvelopeResolverInput> = {}
): HostDeferredCommandEnvelopeResolverInput {
  return {
    deferredId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: 'desktop:client-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    commandFingerprint: 'a'.repeat(64),
    commandName: 'thread.select',
    actor: ACTOR,
    challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    challengeKind: 'approval',
    ...overrides
  }
}

const VERIFIED_RESULT: HostDeferredCommandEnvelopeResolverVerifyResult = {
  kind: 'verified',
  command: sampleCommand()
}

const INDETERMINATE_VERIFY_RESULT: HostDeferredCommandEnvelopeResolverVerifyResult = {
  kind: 'indeterminate',
  code: 'envelope_not_found'
}

const ALREADY_TERMINAL_RESULT: HostDeferredCommandEnvelopeResolverVerifyResult = {
  kind: 'already_terminal',
  receiptStatus: 'succeeded'
}

const POSITION: HostCursorPosition = { generation: 3, cursor: 44 }

const COMPLETED_RESULT: HostMutationCompletionResult = {
  kind: 'completed',
  status: 'succeeded',
  position: POSITION,
  envelope: 'updated'
}

const INDETERMINATE_PIPELINE_RESULT: HostMutationCompletionResult = {
  kind: 'indeterminate',
  errorCode: 'deferred_receipt_uncertain',
  position: POSITION
}

const HOST_UNAVAILABLE_RESULT: HostMutationCompletionResult = {
  kind: 'host_unavailable'
}

const ANOMALY_RESULT: HostMutationCompletionResult = {
  kind: 'anomaly',
  reason: 'complete_refused'
}

function assertBodyFree(value: unknown): void {
  const encoded = JSON.stringify(value)
  expect(encoded).not.toMatch(/SECRET_TOKEN_VALUE/)
  expect(encoded).not.toMatch(/ghp_/)
  expect(encoded).not.toMatch(/hidden-reasoning/)
  expect(encoded).not.toMatch(/Bearer/i)
  expect(encoded).not.toMatch(/password/i)
}

/**
 * Open a pipeline with default ports for the happy path.
 */
function openPipeline(options?: {
  verifyCommand?: (
    input: HostDeferredCommandEnvelopeResolverInput
  ) => HostDeferredCommandEnvelopeResolverVerifyResult
  pipeline?: HostCommandMutationPipeline
  consumeEnvelope?: HostDeferredAllowPipelineConsumeEnvelope
}): {
  pipeline: HostDeferredAllowPipeline
  verifyCommand: ReturnType<typeof vi.fn>
  mutationExecute: ReturnType<typeof vi.fn>
  consumeEnvelope: ReturnType<typeof vi.fn>
} {
  const verifyCommand = vi.fn(() => options?.verifyCommand?.(sampleInput()) ?? VERIFIED_RESULT)
  const mutationExecute = vi.fn(async () => COMPLETED_RESULT)
  const innerPipeline = options?.pipeline ?? {
    execute: mutationExecute
  }
  const consumeEnvelope = vi.fn(() => ({ kind: 'updated' as const }))

  const pipeline = new HostDeferredAllowPipeline({
    verifyCommand,
    pipeline: innerPipeline as unknown as HostCommandMutationPipeline,
    consumeEnvelope: options?.consumeEnvelope === null ? undefined : consumeEnvelope
  })

  return { pipeline, verifyCommand, mutationExecute, consumeEnvelope }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HostDeferredAllowPipeline', () => {
  // -- Constructor validation -----------------------------------------------

  it('requires options', () => {
    expect(() => new HostDeferredAllowPipeline(null as unknown as never)).toThrow(
      /requires options/
    )
    expect(() => new HostDeferredAllowPipeline(undefined as unknown as never)).toThrow(
      /requires options/
    )
  })

  it('requires verifyCommand to be a function', () => {
    expect(
      () =>
        new HostDeferredAllowPipeline({
          verifyCommand: undefined as unknown as () => typeof VERIFIED_RESULT,
          pipeline: {
            execute: async () => COMPLETED_RESULT
          } as unknown as HostCommandMutationPipeline
        })
    ).toThrow(/requires verifyCommand/)
    expect(
      () =>
        new HostDeferredAllowPipeline({
          verifyCommand: 'not-a-function' as unknown as () => typeof VERIFIED_RESULT,
          pipeline: {
            execute: async () => COMPLETED_RESULT
          } as unknown as HostCommandMutationPipeline
        })
    ).toThrow(/requires verifyCommand/)
  })

  it('requires pipeline to be an object', () => {
    expect(
      () =>
        new HostDeferredAllowPipeline({
          verifyCommand: () => VERIFIED_RESULT,
          pipeline: null as unknown as HostCommandMutationPipeline
        })
    ).toThrow(/requires pipeline/)
    expect(
      () =>
        new HostDeferredAllowPipeline({
          verifyCommand: () => VERIFIED_RESULT,
          pipeline: undefined as unknown as HostCommandMutationPipeline
        })
    ).toThrow(/requires pipeline/)
  })

  it('requires pipeline.execute to be a function', () => {
    expect(
      () =>
        new HostDeferredAllowPipeline({
          verifyCommand: () => VERIFIED_RESULT,
          pipeline: { execute: null } as unknown as HostCommandMutationPipeline
        })
    ).toThrow(/requires pipeline\.execute/)
  })

  it('requires consumeEnvelope to be a function when provided', () => {
    expect(
      () =>
        new HostDeferredAllowPipeline({
          verifyCommand: () => VERIFIED_RESULT,
          pipeline: {
            execute: async () => COMPLETED_RESULT
          } as unknown as HostCommandMutationPipeline,
          consumeEnvelope: 'not-a-function' as unknown as HostDeferredAllowPipelineConsumeEnvelope
        })
    ).toThrow(/consumeEnvelope must be a function/)
  })

  it('accepts undefined consumeEnvelope', () => {
    expect(
      () =>
        new HostDeferredAllowPipeline({
          verifyCommand: () => VERIFIED_RESULT,
          pipeline: {
            execute: async () => COMPLETED_RESULT
          } as unknown as HostCommandMutationPipeline,
          consumeEnvelope: undefined
        })
    ).not.toThrow()
  })

  // -- Verify → indeterminate -----------------------------------------------

  it('returns indeterminate directly when verifyCommand returns indeterminate', async () => {
    const verifyCommand = vi.fn(() => INDETERMINATE_VERIFY_RESULT)
    const mutationExecute = vi.fn()
    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'indeterminate',
      code: 'envelope_not_found'
    })
    expect(verifyCommand).toHaveBeenCalledTimes(1)
    expect(mutationExecute).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('preserves the indeterminate code from verifyCommand exactly', async () => {
    const codes: HostDeferredCommandEnvelopeResolverIndeterminateCode[] = [
      'store_unavailable',
      'envelope_not_found',
      'envelope_actor_mismatch',
      'envelope_corrupt',
      'envelope_not_stored',
      'envelope_body_missing',
      'envelope_correlation_mismatch',
      'command_decode_failed',
      'command_validation_failed',
      'command_fingerprint_mismatch',
      'command_identity_mismatch',
      'receipt_not_found',
      'receipt_actor_mismatch',
      'receipt_incomplete',
      'receipt_not_pending',
      'receipt_not_deferred',
      'receipt_correlation_mismatch',
      'receipt_already_indeterminate',
      'quarantine_failed'
    ]

    for (const code of codes) {
      const verifyCommand = vi.fn(() => ({ kind: 'indeterminate' as const, code }))
      const pipeline = new HostDeferredAllowPipeline({
        verifyCommand,
        pipeline: { execute: vi.fn() } as unknown as HostCommandMutationPipeline
      })

      const result = await pipeline.execute(sampleInput())
      expect(result).toEqual({ kind: 'indeterminate', code })
    }
  })

  // -- Verify → already_terminal --------------------------------------------

  it('returns already_terminal directly when verifyCommand returns already_terminal', async () => {
    const verifyCommand = vi.fn(() => ALREADY_TERMINAL_RESULT)
    const mutationExecute = vi.fn()
    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'already_terminal',
      receiptStatus: 'succeeded'
    })
    expect(verifyCommand).toHaveBeenCalledTimes(1)
    expect(mutationExecute).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('preserves the receipt status for all terminal statuses', async () => {
    const statuses: HostCommandReceiptStatus[] = [
      'succeeded',
      'failed',
      'denied',
      'cancelled',
      'conflict'
    ]

    for (const receiptStatus of statuses) {
      const verifyCommand = vi.fn(() => ({
        kind: 'already_terminal' as const,
        receiptStatus
      }))
      const pipeline = new HostDeferredAllowPipeline({
        verifyCommand,
        pipeline: { execute: vi.fn() } as unknown as HostCommandMutationPipeline
      })

      const result = await pipeline.execute(sampleInput())
      expect(result).toEqual({ kind: 'already_terminal', receiptStatus })
    }
  })

  // -- Verify → verified → pipeline -----------------------------------------

  it('calls verifyCommand exactly once and pipeline.execute exactly once on verified', async () => {
    const { pipeline, verifyCommand, mutationExecute } = openPipeline()

    const result = await pipeline.execute(sampleInput())

    expect(verifyCommand).toHaveBeenCalledTimes(1)
    expect(mutationExecute).toHaveBeenCalledTimes(1)
    expect(mutationExecute).toHaveBeenCalledWith(VERIFIED_RESULT.command)
    expect(result.kind).toBe('completed')
  })

  it('passes the exact decoded command object by reference to pipeline.execute', async () => {
    const command = sampleCommand()
    const verifyCommand = vi.fn(() => ({ kind: 'verified' as const, command }))
    const mutationExecute = vi.fn(async (received: HostCommand) => {
      expect(received).toBe(command)
      return COMPLETED_RESULT
    })

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    await pipeline.execute(sampleInput())
    expect(mutationExecute).toHaveBeenCalledTimes(1)
  })

  it('returns completed with status, position, and envelope from pipeline', async () => {
    const { pipeline } = openPipeline()

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POSITION,
      envelope: 'updated'
    })
    assertBodyFree(result)
  })

  it('clones the position to prevent cross-call mutation', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => COMPLETED_RESULT)

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result1 = await pipeline.execute(sampleInput())
    const result2 = await pipeline.execute(sampleInput())

    expect(result1.kind).toBe('completed')
    expect(result2.kind).toBe('completed')
    if (result1.kind === 'completed' && result2.kind === 'completed') {
      expect(result1.position).not.toBe(result2.position)
      expect(result1.position).toEqual(POSITION)
      expect(result2.position).toEqual(POSITION)
    }
  })

  it('returns completed without envelope field when pipeline result has no envelope', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(
      async (): Promise<HostMutationCompletionResult> => ({
        kind: 'completed',
        status: 'succeeded',
        position: POSITION
      })
    )

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POSITION
    })
  })

  // -- Pipeline returns indeterminate ---------------------------------------

  it('maps pipeline indeterminate to our indeterminate with position', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => INDETERMINATE_PIPELINE_RESULT)

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'indeterminate',
      code: 'deferred_receipt_uncertain',
      position: POSITION
    })
    expect(verifyCommand).toHaveBeenCalledTimes(1)
    expect(mutationExecute).toHaveBeenCalledTimes(1)
    assertBodyFree(result)
  })

  it('preserves the error code from pipeline indeterminate', async () => {
    const codes: HostCommandReceiptIndeterminateCode[] = [
      'deferred_receipt_uncertain',
      'deferred_execution_may_have_begun',
      'deferred_effects_partial',
      'deferred_effects_unavailable'
    ]

    for (const errorCode of codes) {
      const verifyCommand = vi.fn(() => VERIFIED_RESULT)
      const mutationExecute = vi.fn(
        async (): Promise<HostMutationCompletionResult> => ({
          kind: 'indeterminate',
          errorCode,
          position: POSITION
        })
      )

      const pipeline = new HostDeferredAllowPipeline({
        verifyCommand,
        pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
      })

      const result = await pipeline.execute(sampleInput())
      expect(result).toEqual({
        kind: 'indeterminate',
        code: errorCode,
        position: POSITION
      })
    }
  })

  // -- Pipeline returns host_unavailable ------------------------------------

  it('returns host_unavailable when pipeline returns host_unavailable', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => HOST_UNAVAILABLE_RESULT)

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({ kind: 'host_unavailable' })
    expect(verifyCommand).toHaveBeenCalledTimes(1)
    expect(mutationExecute).toHaveBeenCalledTimes(1)
    assertBodyFree(result)
  })

  // -- Pipeline returns anomaly → closed mapping ----------------------------

  it('maps pipeline anomaly to host_unavailable', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => ANOMALY_RESULT)

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({ kind: 'host_unavailable' })
    expect(mutationExecute).toHaveBeenCalledTimes(1)
    assertBodyFree(result)
  })

  // -- Envelope consumption -------------------------------------------------

  it('calls consumeEnvelope only after completed', async () => {
    const { pipeline, consumeEnvelope, mutationExecute } = openPipeline()

    await pipeline.execute(sampleInput())

    expect(mutationExecute).toHaveBeenCalledTimes(1)
    expect(consumeEnvelope).toHaveBeenCalledTimes(1)
  })

  it('uses the consumeEnvelope result kind as the envelope field', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(
      async (): Promise<HostMutationCompletionResult> => ({
        kind: 'completed',
        status: 'failed',
        position: POSITION
      })
    )
    const consumeEnvelope = vi.fn(() => ({ kind: 'existing' as const }))

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline,
      consumeEnvelope
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'completed',
      status: 'failed',
      position: POSITION,
      envelope: 'existing'
    })
  })

  it('sets envelope to anomaly when consumeEnvelope throws, but still returns completed', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => COMPLETED_RESULT)
    const consumeEnvelope = vi.fn(() => {
      throw new Error('SECRET_TOKEN_VALUE envelope failure')
    })

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline,
      consumeEnvelope
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POSITION,
      envelope: 'anomaly'
    })
    // Envelope failure must not rewrite the receipt outcome.
    assertBodyFree(result)
  })

  it('does NOT call consumeEnvelope when pipeline returns indeterminate', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => INDETERMINATE_PIPELINE_RESULT)
    const consumeEnvelope = vi.fn()

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline,
      consumeEnvelope
    })

    await pipeline.execute(sampleInput())

    expect(consumeEnvelope).not.toHaveBeenCalled()
  })

  it('does NOT call consumeEnvelope when pipeline returns host_unavailable', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => HOST_UNAVAILABLE_RESULT)
    const consumeEnvelope = vi.fn()

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline,
      consumeEnvelope
    })

    await pipeline.execute(sampleInput())

    expect(consumeEnvelope).not.toHaveBeenCalled()
  })

  it('does NOT call consumeEnvelope when verifyCommand returns indeterminate', async () => {
    const verifyCommand = vi.fn(() => INDETERMINATE_VERIFY_RESULT)
    const consumeEnvelope = vi.fn()

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: vi.fn() } as unknown as HostCommandMutationPipeline,
      consumeEnvelope
    })

    await pipeline.execute(sampleInput())

    expect(consumeEnvelope).not.toHaveBeenCalled()
  })

  it('does NOT call consumeEnvelope when verifyCommand returns already_terminal', async () => {
    const verifyCommand = vi.fn(() => ALREADY_TERMINAL_RESULT)
    const consumeEnvelope = vi.fn()

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: vi.fn() } as unknown as HostCommandMutationPipeline,
      consumeEnvelope
    })

    await pipeline.execute(sampleInput())

    expect(consumeEnvelope).not.toHaveBeenCalled()
  })

  it('does not call consumeEnvelope when undefined', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => COMPLETED_RESULT)

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POSITION,
      envelope: 'updated'
    })
    // consumeEnvelope was not passed — the pipeline result envelope is used as-is
  })

  // -- Zero H ---------------------------------------------------------------

  it('never calls an executor directly — zero H path', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostDeferredAllowPipeline.ts'),
      'utf8'
    )
    const codeOnly = source.replace(/\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    expect(codeOnly).not.toMatch(/this\.executor/)
    expect(codeOnly).not.toMatch(/HostBridgeCommandExecutor/)
    expect(codeOnly).not.toMatch(/fingerprintHostCommand/)
    expect(codeOnly).not.toMatch(/decodeHostCommand/)
    // The only .execute is this.pipeline.execute — verify exactly one in code.
    const executeCalls = [...codeOnly.matchAll(/\.execute\(/g)]
    expect(executeCalls).toHaveLength(1)
  })

  // -- Input validation passthrough -----------------------------------------

  it('passes the input through to verifyCommand unchanged', async () => {
    const input = sampleInput()
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: async () => COMPLETED_RESULT } as unknown as HostCommandMutationPipeline
    })

    await pipeline.execute(input)

    expect(verifyCommand).toHaveBeenCalledWith(input)
  })

  // -- Import isolation -----------------------------------------------------

  it('imports only the allowed substrate modules and no forbidden surfaces', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostDeferredAllowPipeline.ts'),
      'utf8'
    )

    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])

    expect(imports).toEqual([
      '../../shared/hostProtocol',
      './HostCommandMutationPipeline',
      './HostMutationCompletionCoordinator',
      './HostDeferredCommandEnvelopeResolver',
      './HostCommandReceiptStore'
    ])

    // Strip comments before checking for forbidden surface references —
    // the JSDoc intentionally documents what we never call.
    const codeOnly = source.replace(/\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    // No forbidden symbols in code (comment mentions are intentional documentation).
    expect(codeOnly).not.toMatch(/HostDeferredCommandBridge/)
    expect(codeOnly).not.toMatch(/HostDeferredCommandEnvelopeStore/)
    expect(codeOnly).not.toMatch(/HostDomainDeltaPublisher/)
    expect(codeOnly).not.toMatch(/HostObservedMutationExecutor/)
    expect(codeOnly).not.toMatch(/AppStoreHostAuthority/)
    expect(codeOnly).not.toMatch(/EnsembleOrchestrator/)
    expect(codeOnly).not.toMatch(/\.completeReceipt\(/)
    expect(codeOnly).not.toMatch(/\.publishEffects\(/)
    expect(codeOnly).not.toMatch(/\.begin\(/)
    expect(codeOnly).not.toMatch(/markQuarantined/)
    expect(codeOnly).not.toMatch(/markConsumed/)
  })

  // -- Body-free results ----------------------------------------------------

  it('returns body-free results for all outcome kinds', async () => {
    const verifyCommand = vi.fn(() => ({
      kind: 'verified' as const,
      command: sampleCommand({
        arguments: { SECRET_TOKEN_VALUE: 'secret' } as Record<string, unknown>
      })
    }))
    const mutationExecute = vi.fn(async () => COMPLETED_RESULT)

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline,
      consumeEnvelope: () => ({ kind: 'updated' as const })
    })

    const result = await pipeline.execute(sampleInput())

    assertBodyFree(result)
    // The command itself is never serialised into the result.
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain('SECRET_TOKEN_VALUE')
  })

  // -- ConsumeEnvelope result kinds -----------------------------------------

  it('preserves consumeEnvelope anomaly kind', async () => {
    const verifyCommand = vi.fn(() => VERIFIED_RESULT)
    const mutationExecute = vi.fn(async () => COMPLETED_RESULT)
    const consumeEnvelope = vi.fn(() => ({ kind: 'anomaly' as const }))

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline,
      consumeEnvelope
    })

    const result = await pipeline.execute(sampleInput())

    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POSITION,
      envelope: 'anomaly'
    })
  })

  // -- Multiple calls preserve isolation ------------------------------------

  it('handles multiple sequential executions without cross-contamination', async () => {
    const callOrder: string[] = []
    const verifyCommand = vi.fn(() => {
      callOrder.push('verify')
      return VERIFIED_RESULT
    })
    const mutationExecute = vi.fn(async () => {
      callOrder.push('execute')
      return COMPLETED_RESULT
    })

    const pipeline = new HostDeferredAllowPipeline({
      verifyCommand,
      pipeline: { execute: mutationExecute } as unknown as HostCommandMutationPipeline
    })

    await pipeline.execute(sampleInput())
    await pipeline.execute(sampleInput())
    await pipeline.execute(sampleInput())

    expect(callOrder).toEqual(['verify', 'execute', 'verify', 'execute', 'verify', 'execute'])
    expect(verifyCommand).toHaveBeenCalledTimes(3)
    expect(mutationExecute).toHaveBeenCalledTimes(3)
  })

  // -- No double execution --------------------------------------------------

  it('never calls pipeline.execute more than once per execute call', async () => {
    const { pipeline, mutationExecute } = openPipeline()

    await pipeline.execute(sampleInput())

    expect(mutationExecute).toHaveBeenCalledTimes(1)
  })
})

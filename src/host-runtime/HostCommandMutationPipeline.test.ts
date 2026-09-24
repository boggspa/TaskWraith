import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_MAX_ID,
  HOST_PROTOCOL_VERSION,
  type HostCommand
} from '../shared/hostProtocol'
import type { HostDomainEffectDto } from './HostDomainDeltaPublisher'
import {
  HostCommandMutationPipeline,
  type HostCommandMutationPipelineComplete,
  type HostCommandMutationPipelineObserve
} from './HostCommandMutationPipeline'
import type {
  HostMutationCompletionInput,
  HostMutationCompletionResult
} from './HostMutationCompletionCoordinator'
import type { HostObservedMutationResult } from './HostObservedMutationExecutor'

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'

const EFFECT: HostDomainEffectDto = {
  kind: 'upsert',
  family: 'thread',
  entityId: 'thread-1',
  payload: { threadId: 'thread-1', title: 'Updated' }
}

const PRE_EXECUTION_FAILED: HostObservedMutationResult = {
  kind: 'pre_execution_failed',
  reason: 'before_snapshot_capture_failed',
  effects: []
}

const OBSERVED: HostObservedMutationResult = {
  kind: 'observed',
  execution: { status: 'succeeded', resultSummary: 'done' },
  effects: [EFFECT]
}

const OBSERVATION_FAILED: HostObservedMutationResult = {
  kind: 'observation_failed',
  execution: {
    status: 'failed',
    errorCode: 'bridge_failed',
    errorMessage: 'bounded'
  },
  effects: [],
  reason: 'after_snapshot_capture_failed'
}

const EXECUTION_MAY_HAVE_BEGUN: HostObservedMutationResult = {
  kind: 'execution_may_have_begun',
  effects: [],
  afterCapture: { status: 'capture_failed' }
}

const COMPLETED: HostMutationCompletionResult = {
  kind: 'completed',
  status: 'succeeded',
  position: { generation: 3, cursor: 44 },
  envelope: 'updated'
}

const MUTATIONS: readonly {
  readonly label: string
  readonly mutation: HostObservedMutationResult
}[] = [
  { label: 'pre_execution_failed', mutation: PRE_EXECUTION_FAILED },
  { label: 'observed', mutation: OBSERVED },
  { label: 'observation_failed', mutation: OBSERVATION_FAILED },
  { label: 'execution_may_have_begun', mutation: EXECUTION_MAY_HAVE_BEGUN }
]

const COORDINATOR_RESULTS: readonly {
  readonly label: string
  readonly result: HostMutationCompletionResult
}[] = [
  { label: 'completed', result: COMPLETED },
  {
    label: 'indeterminate',
    result: {
      kind: 'indeterminate',
      errorCode: 'deferred_receipt_uncertain',
      position: { generation: 3, cursor: 45 }
    }
  },
  { label: 'host_unavailable', result: { kind: 'host_unavailable' } },
  {
    label: 'anomaly',
    result: { kind: 'anomaly', reason: 'complete_refused' }
  }
]

function sampleCommand(overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: COMMAND_ID,
    idempotencyKey: 'desktop:client-1:22222222-2222-4222-8222-222222222222',
    actor: {
      actorId: 'actor-1',
      clientId: 'client-1',
      clientClass: 'desktop'
    },
    name: 'composer.send',
    target: { threadId: 'thread-1' },
    arguments: { text: 'hello' },
    issuedAt: '2026-08-04T00:00:00.000Z',
    ...overrides
  }
}

function assertBodyFree(value: unknown): void {
  const encoded = JSON.stringify(value)
  expect(encoded).not.toMatch(/SECRET_TOKEN_VALUE/)
  expect(encoded).not.toMatch(/ghp_/)
  expect(encoded).not.toMatch(/hidden-reasoning/)
  expect(encoded).not.toMatch(/Bearer/i)
  expect(encoded).not.toMatch(/password/i)
}

function openPipeline(options?: {
  observe?: HostCommandMutationPipelineObserve
  complete?: HostCommandMutationPipelineComplete
}): {
  pipeline: HostCommandMutationPipeline
  observe: HostCommandMutationPipelineObserve
  complete: HostCommandMutationPipelineComplete
} {
  const observe: HostCommandMutationPipelineObserve = options?.observe ?? (async () => OBSERVED)
  const complete: HostCommandMutationPipelineComplete = options?.complete ?? (() => COMPLETED)
  return {
    pipeline: new HostCommandMutationPipeline({ observe, complete }),
    observe,
    complete
  }
}

describe('HostCommandMutationPipeline', () => {
  it('requires exactly the observe and complete ports', () => {
    expect(
      () =>
        new HostCommandMutationPipeline({
          observe: undefined as unknown as HostCommandMutationPipelineObserve,
          complete: () => COMPLETED
        })
    ).toThrow(/requires observe/)
    expect(
      () =>
        new HostCommandMutationPipeline({
          observe: async () => OBSERVED,
          complete: undefined as unknown as HostCommandMutationPipelineComplete
        })
    ).toThrow(/requires complete/)
  })

  it.each(MUTATIONS)('observes then completes exactly once for $label', async ({ mutation }) => {
    const order: string[] = []
    const command = sampleCommand()
    const observe = vi.fn(async (received: HostCommand) => {
      order.push('observe')
      expect(received).toBe(command)
      return mutation
    })
    const complete = vi.fn((input: HostMutationCompletionInput) => {
      order.push('complete')
      expect(input.commandId).toBe(COMMAND_ID)
      expect(input.mutation).toBe(mutation)
      return COMPLETED
    })
    const pipeline = new HostCommandMutationPipeline({ observe, complete })

    const result = await pipeline.execute(command)

    expect(result).toBe(COMPLETED)
    expect(order).toEqual(['observe', 'complete'])
    expect(observe).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it.each(COORDINATOR_RESULTS)(
    'returns the exact $label coordinator result without interpretation',
    async ({ result: expected }) => {
      const observe = vi.fn(async () => OBSERVED)
      const complete = vi.fn(() => expected)
      const pipeline = new HostCommandMutationPipeline({ observe, complete })

      const result = await pipeline.execute(sampleCommand())

      expect(result).toBe(expected)
      expect(observe).toHaveBeenCalledTimes(1)
      expect(complete).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    {
      status: 'failed' as const,
      errorCode: 'bridge_failed',
      errorMessage: 'failed after changing state'
    },
    {
      status: 'cancelled' as const,
      errorCode: 'user_declined',
      errorMessage: 'cancelled after changing state'
    }
  ])('passes $status plus real effects to completion unchanged', async (execution) => {
    const effects: readonly HostDomainEffectDto[] = [EFFECT]
    const mutation: HostObservedMutationResult = {
      kind: 'observed',
      execution,
      effects
    }
    const observe = vi.fn(async () => mutation)
    const complete = vi.fn((_input: HostMutationCompletionInput) => COMPLETED)
    const pipeline = new HostCommandMutationPipeline({ observe, complete })

    await pipeline.execute(sampleCommand())

    const input = complete.mock.calls[0]?.[0]
    expect(input?.mutation).toBe(mutation)
    if (input?.mutation.kind !== 'observed') {
      throw new Error('expected observed mutation')
    }
    expect(input.mutation.execution).toBe(execution)
    expect(input.mutation.effects).toBe(effects)
  })

  it('converts an observer throw into one conservative completion without retry', async () => {
    const observe = vi.fn(async () => {
      throw new Error('SECRET_TOKEN_VALUE observer failure')
    })
    const complete = vi.fn((_input: HostMutationCompletionInput) => COMPLETED)
    const pipeline = new HostCommandMutationPipeline({ observe, complete })

    const result = await pipeline.execute(sampleCommand())

    expect(result).toBe(COMPLETED)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'execution_may_have_begun',
        effects: [],
        afterCapture: { status: 'capture_failed' }
      }
    })
    assertBodyFree(result)
  })

  it('returns body-free host_unavailable when completion throws and never retries', async () => {
    const observe = vi.fn(async () => OBSERVED)
    const complete = vi.fn((_input: HostMutationCompletionInput) => {
      throw new Error('SECRET_TOKEN_VALUE completion failure')
    })
    const pipeline = new HostCommandMutationPipeline({ observe, complete })

    const result = await pipeline.execute(sampleCommand())

    expect(result).toEqual({ kind: 'host_unavailable' })
    expect(observe).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    assertBodyFree(result)
  })

  it.each([
    { label: 'non-UUID', commandId: 'not-a-uuid' },
    {
      label: 'leading whitespace',
      commandId: ' 11111111-1111-4111-8111-111111111111'
    },
    {
      label: 'ASCII control',
      commandId: '11111111-1111-4111-8111-111111111111\u0000'
    },
    {
      label: 'over protocol bound',
      commandId: 'x'.repeat(HOST_PROTOCOL_MAX_ID + 1)
    }
  ])('rejects $label command IDs before either port', async ({ commandId }) => {
    const observe = vi.fn(async () => OBSERVED)
    const complete = vi.fn((_input: HostMutationCompletionInput) => COMPLETED)
    const pipeline = new HostCommandMutationPipeline({ observe, complete })

    const result = await pipeline.execute(sampleCommand({ commandId }))

    expect(result).toEqual({ kind: 'anomaly', reason: 'invalid_command_id' })
    expect(observe).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('accepts the maximum relevant UUID shape without broadening the ID contract', async () => {
    const command = sampleCommand({
      commandId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    })
    const observe = vi.fn(async () => OBSERVED)
    const complete = vi.fn((_input: HostMutationCompletionInput) => COMPLETED)
    const pipeline = new HostCommandMutationPipeline({ observe, complete })

    expect(await pipeline.execute(command)).toBe(COMPLETED)
    expect(observe).toHaveBeenCalledWith(command)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('passes a deeply frozen command through by reference without mutation', async () => {
    const command = Object.freeze({
      ...sampleCommand(),
      actor: Object.freeze({ ...sampleCommand().actor }),
      target: Object.freeze({ ...sampleCommand().target }),
      arguments: Object.freeze({ ...sampleCommand().arguments })
    }) as HostCommand
    const before = JSON.stringify(command)
    const observe = vi.fn(async (received: HostCommand) => {
      expect(received).toBe(command)
      return OBSERVED
    })
    const complete = vi.fn((_input: HostMutationCompletionInput) => COMPLETED)
    const pipeline = new HostCommandMutationPipeline({ observe, complete })

    await expect(pipeline.execute(command)).resolves.toBe(COMPLETED)
    expect(JSON.stringify(command)).toBe(before)
  })

  it('keeps the production module on the exact isolated two-port substrate surface', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/host-runtime/HostCommandMutationPipeline.ts'),
      'utf8'
    )
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])

    expect(imports).toEqual([
      '../shared/hostProtocol',
      '../host-shared/HostCommandIdentity',
      './HostMutationCompletionCoordinator',
      './HostObservedMutationExecutor'
    ])
    expect(source).not.toMatch(/\.publish\(/)
    expect(source).not.toMatch(/\.begin\(/)
    expect(source).not.toMatch(/fingerprintHostCommand/)
    expect(source).not.toMatch(/decodeHostCommand/)
    expect(source).not.toMatch(/markEnvelope/)
    expect(source).not.toMatch(/quarantine/)
  })

  it('has no production consumer wiring in the new substrate pair', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/host-runtime/HostCommandMutationPipeline.ts'),
      'utf8'
    )

    expect(source).not.toMatch(/new HostObservedMutationExecutor/)
    expect(source).not.toMatch(/new HostMutationCompletionCoordinator/)
    expect(source).not.toMatch(/HostDomainDeltaPublisher/)
    expect(source).not.toMatch(/HostCommandReceiptStore/)
    expect(source).not.toMatch(/HostDeferredCommand/)
  })

  it('uses no third port even when an extra runtime property is supplied', async () => {
    const observe = vi.fn(async () => OBSERVED)
    const complete = vi.fn((_input: HostMutationCompletionInput) => COMPLETED)
    const extra = vi.fn()
    const pipeline = new HostCommandMutationPipeline({
      observe,
      complete,
      runtime: extra
    } as {
      observe: HostCommandMutationPipelineObserve
      complete: HostCommandMutationPipelineComplete
      runtime: typeof extra
    })

    expect(await pipeline.execute(sampleCommand())).toBe(COMPLETED)
    expect(extra).not.toHaveBeenCalled()
  })

  it('default helper exposes only the two pipeline ports', () => {
    const opened = openPipeline()
    expect(Object.keys(opened).sort()).toEqual(['complete', 'observe', 'pipeline'])
  })
})

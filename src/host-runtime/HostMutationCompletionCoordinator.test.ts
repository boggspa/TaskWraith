import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { HostCursorPosition } from '../shared/hostProtocol'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type {
  HostCommandReceiptCompleteInput,
  HostCommandReceiptMarkIndeterminateInput,
  HostCommandReceiptMarkIndeterminateResult,
  HostCommandReceiptRecord
} from './HostCommandReceiptStore'
import type { HostDomainDeltaPublishResult, HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type { HostObservedMutationResult } from './HostObservedMutationExecutor'
import {
  HostMutationCompletionCoordinator,
  type HostMutationCompletionMarkEnvelopeConsumed,
  type HostMutationCompletionResult
} from './HostMutationCompletionCoordinator'

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const POS: HostCursorPosition = { generation: 3, cursor: 41 }
const POS_PUBLISHED: HostCursorPosition = { generation: 3, cursor: 44 }
const POS_PARTIAL: HostCursorPosition = { generation: 3, cursor: 42 }

const EFFECT: HostDomainEffectDto = {
  kind: 'upsert',
  family: 'thread',
  entityId: 'th-1',
  payload: { threadId: 'th-1', title: 't' }
}

const SUCCESS: HostCommandExecutionResult = {
  status: 'succeeded',
  resultSummary: 'ok'
}

const FAILED: HostCommandExecutionResult = {
  status: 'failed',
  errorCode: 'bridge_failed',
  errorMessage: 'nope'
}

const CANCELLED: HostCommandExecutionResult = {
  status: 'cancelled',
  errorCode: 'user_declined',
  errorMessage: 'declined'
}

function receipt(status: HostCommandReceiptRecord['status']): HostCommandReceiptRecord {
  return {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: 'desktop:client-1:22222222-2222-4222-8222-222222222222',
    commandFingerprint: 'a'.repeat(64),
    status,
    actor: { actorId: 'a1', clientId: 'c1', clientClass: 'desktop' },
    target: { kind: 'thread', id: 'th-1' },
    authority: { decision: 'allowed' },
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    generation: POS.generation,
    cursor: POS.cursor,
    ...(status === 'indeterminate' ? { errorCode: 'deferred_envelope_unavailable' as const } : {})
  }
}

function assertBodyFree(result: unknown): void {
  const text = JSON.stringify(result)
  expect(text).not.toMatch(/SECRET_TOKEN_VALUE/)
  expect(text).not.toMatch(/ghp_/)
  expect(text).not.toMatch(/hidden-reasoning/)
  expect(text).not.toMatch(/Bearer/i)
  expect(text).not.toMatch(/password/i)
  // Must not echo unrestricted tool/output or snapshot bodies
  expect(text).not.toMatch(/"payload"/)
  expect(text).not.toMatch(/family workspaces truncated/)
}

type Ports = {
  publishEffects: ReturnType<typeof vi.fn>
  getPosition: ReturnType<typeof vi.fn>
  completeReceipt: ReturnType<typeof vi.fn>
  markIndeterminate: ReturnType<typeof vi.fn>
  markEnvelopeConsumed?: ReturnType<typeof vi.fn>
}

function openCoordinator(overrides: Partial<Ports> = {}): {
  coordinator: HostMutationCompletionCoordinator
  ports: Ports
} {
  const ports: Ports = {
    publishEffects: overrides.publishEffects ?? vi.fn(),
    getPosition: overrides.getPosition ?? vi.fn(() => ({ ...POS })),
    completeReceipt:
      overrides.completeReceipt ??
      vi.fn((input: HostCommandReceiptCompleteInput) => {
        const rec = receipt(input.status)
        if (input.position) {
          rec.generation = input.position.generation
          rec.cursor = input.position.cursor
        }
        return rec
      }),
    markIndeterminate:
      overrides.markIndeterminate ??
      vi.fn(
        (
          input: HostCommandReceiptMarkIndeterminateInput
        ): HostCommandReceiptMarkIndeterminateResult => {
          const rec = receipt('indeterminate')
          if (input.position) {
            rec.generation = input.position.generation
            rec.cursor = input.position.cursor
          }
          rec.errorCode = input.errorCode
          return {
            kind: 'marked',
            receipt: rec
          }
        }
      ),
    ...(overrides.markEnvelopeConsumed !== undefined
      ? { markEnvelopeConsumed: overrides.markEnvelopeConsumed }
      : {})
  }

  const options: ConstructorParameters<typeof HostMutationCompletionCoordinator>[0] = {
    publishEffects: ports.publishEffects as never,
    getPosition: ports.getPosition as never,
    completeReceipt: ports.completeReceipt as never,
    markIndeterminate: ports.markIndeterminate as never,
    ...(ports.markEnvelopeConsumed
      ? {
          markEnvelopeConsumed:
            ports.markEnvelopeConsumed as HostMutationCompletionMarkEnvelopeConsumed
        }
      : {})
  }

  return {
    coordinator: new HostMutationCompletionCoordinator(options),
    ports
  }
}

describe('HostMutationCompletionCoordinator', () => {
  it('rejects missing options and non-function ports', () => {
    expect(() => new HostMutationCompletionCoordinator(undefined as never)).toThrow(
      /requires options/
    )
    expect(
      () =>
        new HostMutationCompletionCoordinator({
          publishEffects: undefined as never,
          getPosition: () => POS,
          completeReceipt: () => null,
          markIndeterminate: () => ({ kind: 'not_found' })
        })
    ).toThrow(/publishEffects/)
  })

  it('returns body-free anomaly for invalid commandId / mutation', () => {
    const { coordinator, ports } = openCoordinator()
    expect(
      coordinator.complete({
        commandId: '',
        mutation: {
          kind: 'pre_execution_failed',
          reason: 'before_snapshot_capture_failed',
          effects: []
        }
      })
    ).toEqual({
      kind: 'anomaly',
      reason: 'invalid_command_id'
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: null as never
      })
    ).toEqual({ kind: 'anomaly', reason: 'invalid_command_id' })
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('pre_execution_failed: no publish, complete failed at current position, no envelope', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const { coordinator, ports } = openCoordinator({ markEnvelopeConsumed: envelope })
    const mutation: HostObservedMutationResult = {
      kind: 'pre_execution_failed',
      reason: 'before_snapshot_privacy_failed',
      effects: []
    }
    const result = coordinator.complete({ commandId: COMMAND_ID, mutation })
    expect(result).toEqual({
      kind: 'completed',
      status: 'failed',
      position: POS
    })
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(ports.completeReceipt).toHaveBeenCalledTimes(1)
    expect(ports.completeReceipt.mock.calls[0][0]).toMatchObject({
      commandId: COMMAND_ID,
      status: 'failed',
      errorCode: 'pre_execution_before_snapshot_privacy_failed',
      position: POS
    })
    expect(envelope).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('pre_execution_failed with unreadable position leaves pending (host_unavailable)', () => {
    const { coordinator, ports } = openCoordinator({
      getPosition: vi.fn(() => {
        throw new Error('journal offline')
      })
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'pre_execution_failed',
        reason: 'before_snapshot_capture_failed',
        effects: []
      }
    })
    expect(result).toEqual({ kind: 'host_unavailable' })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
    expect(ports.publishEffects).not.toHaveBeenCalled()
  })

  it('observed empty effects: no publish, exact status at current position, then envelope', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const { coordinator, ports } = openCoordinator({ markEnvelopeConsumed: envelope })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
    })
    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POS,
      envelope: 'updated'
    })
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(ports.completeReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        position: POS,
        resultSummary: 'ok'
      })
    )
    expect(envelope).toHaveBeenCalledTimes(1)
  })

  it('forwards resultRef only for succeeded execution and drops it for cancelled execution', () => {
    const { coordinator, ports } = openCoordinator()
    coordinator.complete({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'observed',
        execution: {
          status: 'succeeded',
          resultRef: { kind: 'workspace', workspaceId: 'workspace-1' }
        },
        effects: []
      }
    })
    expect(ports.completeReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        resultRef: { kind: 'workspace', workspaceId: 'workspace-1' }
      })
    )

    coordinator.complete({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'observed',
        execution: {
          status: 'cancelled',
          resultRef: { kind: 'thread', threadId: 'thread-1' }
        },
        effects: []
      }
    })
    expect(ports.completeReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'cancelled' })
    )
    expect(ports.completeReceipt.mock.calls.at(-1)?.[0]).not.toHaveProperty('resultRef')
  })

  it('observed nonempty published: publish once then complete exact status at published.position', () => {
    const order: string[] = []
    const { coordinator } = openCoordinator({
      publishEffects: vi.fn(
        (effects: readonly HostDomainEffectDto[]): HostDomainDeltaPublishResult => {
          order.push('publish')
          expect(effects).toEqual([EFFECT])
          return {
            kind: 'published',
            position: POS_PUBLISHED,
            count: 1,
            results: []
          }
        }
      ),
      completeReceipt: vi.fn((input: HostCommandReceiptCompleteInput) => {
        order.push('complete')
        expect(input.position).toEqual(POS_PUBLISHED)
        const rec = receipt(input.status)
        if (input.position) {
          rec.generation = input.position.generation
          rec.cursor = input.position.cursor
        }
        return rec
      }),
      markEnvelopeConsumed: vi.fn(() => {
        order.push('envelope')
        return { kind: 'existing' as const }
      })
    })

    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POS_PUBLISHED,
      envelope: 'existing'
    })
    expect(order).toEqual(['publish', 'complete', 'envelope'])
  })

  it('failed + nonempty effects: publish then terminalize failed (never rewrite outcome)', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'published',
          position: POS_PUBLISHED,
          count: 1,
          results: []
        })
      )
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: FAILED, effects: [EFFECT] }
    })
    expect(result).toMatchObject({ kind: 'completed', status: 'failed', position: POS_PUBLISHED })
    expect(ports.completeReceipt.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      errorCode: 'bridge_failed',
      position: POS_PUBLISHED
    })
    assertBodyFree(result)
  })

  it('cancelled + nonempty effects: publish then terminalize cancelled', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'published',
          position: POS_PUBLISHED,
          count: 1,
          results: []
        })
      )
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: CANCELLED, effects: [EFFECT] }
    })
    expect(result).toMatchObject({
      kind: 'completed',
      status: 'cancelled',
      position: POS_PUBLISHED
    })
    expect(ports.completeReceipt.mock.calls[0][0].status).toBe('cancelled')
  })

  it('observed rejected publish → deferred_effects_unavailable, no envelope', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'rejected',
          reason: 'validation_failed',
          failures: [],
          position: POS
        })
      ),
      markEnvelopeConsumed: envelope
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(result).toEqual({
      kind: 'indeterminate',
      errorCode: 'deferred_effects_unavailable',
      position: POS
    })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
    expect(ports.markIndeterminate).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      position: POS,
      errorCode: 'deferred_effects_unavailable'
    })
    expect(envelope).not.toHaveBeenCalled()
  })

  it('observed partial publish → deferred_effects_partial at exact position', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'partial',
          position: POS_PARTIAL,
          publishedCount: 1,
          results: [],
          failedAtIndex: 1,
          failure: { kind: 'store_error', detail: 'append failed' }
        })
      )
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT, EFFECT] }
    })
    expect(result).toEqual({
      kind: 'indeterminate',
      errorCode: 'deferred_effects_partial',
      position: POS_PARTIAL
    })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('observed store_error with position → deferred_effects_partial', () => {
    const { coordinator } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'store_error',
          detail: 'disk',
          position: POS_PARTIAL
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
      })
    ).toEqual({
      kind: 'indeterminate',
      errorCode: 'deferred_effects_partial',
      position: POS_PARTIAL
    })
  })

  it('observed store_error with null position → leave pending (host_unavailable)', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'store_error',
          detail: 'position unreadable',
          position: null
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
      })
    ).toEqual({ kind: 'host_unavailable' })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
    expect(ports.markIndeterminate).not.toHaveBeenCalled()
  })

  it('publisher throw with readable position → deferred_effects_partial; no retry', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(() => {
        throw new Error('SECRET_TOKEN_VALUE boom')
      })
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(result).toEqual({
      kind: 'indeterminate',
      errorCode: 'deferred_effects_partial',
      position: POS
    })
    expect(ports.publishEffects).toHaveBeenCalledTimes(1)
    assertBodyFree(result)
  })

  it('publisher throw with unreadable position → host_unavailable', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(() => {
        throw new Error('boom')
      }),
      getPosition: vi.fn(() => {
        throw new Error('offline')
      })
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
      })
    ).toEqual({ kind: 'host_unavailable' })
    expect(ports.markIndeterminate).not.toHaveBeenCalled()
  })

  it('observation_failed retains its exact after-projection diagnosis', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const { coordinator, ports } = openCoordinator({ markEnvelopeConsumed: envelope })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'observation_failed',
        execution: SUCCESS,
        effects: [],
        reason: 'after_projection_truncated'
      }
    })
    expect(result).toEqual({
      kind: 'indeterminate',
      errorCode: 'observation_after_projection_truncated',
      position: POS
    })
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(ports.completeReceipt).not.toHaveBeenCalled()
    expect(envelope).not.toHaveBeenCalled()
  })

  it.each([
    ['generation_mismatch', 'observation_diff_generation_mismatch'],
    ['cursor_mismatch', 'observation_diff_cursor_mismatch'],
    ['duplicate_entity_id', 'observation_diff_incoherent']
  ] as const)('distinguishes diff incoherence %s', (incoherenceReason, errorCode) => {
    const { coordinator } = openCoordinator()
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: SUCCESS,
          effects: [],
          reason: 'diff_incoherent',
          incoherenceReason
        }
      })
    ).toEqual({ kind: 'indeterminate', errorCode, position: POS })
  })

  it('execution_may_have_begun → deferred_execution_may_have_begun', () => {
    const { coordinator, ports } = openCoordinator()
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'execution_may_have_begun',
          effects: [],
          afterCapture: { status: 'capture_failed' }
        }
      })
    ).toEqual({
      kind: 'indeterminate',
      errorCode: 'deferred_execution_may_have_begun',
      position: POS
    })
    expect(ports.publishEffects).not.toHaveBeenCalled()
  })

  it('completeReceipt null → body-free complete_refused anomaly; no envelope', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const { coordinator } = openCoordinator({
      completeReceipt: vi.fn(() => null),
      markEnvelopeConsumed: envelope
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'complete_refused' })
    expect(envelope).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('completeReceipt throw → complete_threw anomaly; no retry', () => {
    const { coordinator, ports } = openCoordinator({
      completeReceipt: vi.fn(() => {
        throw new Error('already terminal other status')
      })
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
      })
    ).toEqual({ kind: 'anomaly', reason: 'complete_threw' })
    expect(ports.completeReceipt).toHaveBeenCalledTimes(1)
  })

  it('markIndeterminate refusal / throw → body-free anomaly', () => {
    const refused = openCoordinator({
      markIndeterminate: vi.fn(() => ({ kind: 'terminal_refused', status: 'succeeded' as const }))
    })
    expect(
      refused.coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: SUCCESS,
          effects: [],
          reason: 'diff_incoherent'
        }
      })
    ).toEqual({ kind: 'anomaly', reason: 'mark_indeterminate_refused' })

    const threw = openCoordinator({
      markIndeterminate: vi.fn(() => {
        throw new Error('hidden-reasoning')
      })
    })
    const result = threw.coordinator.complete({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'execution_may_have_begun',
        effects: [],
        afterCapture: { status: 'complete' }
      }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'mark_indeterminate_threw' })
    assertBodyFree(result)
  })

  it('markIndeterminate already_indeterminate returns durable receipt position and errorCode', () => {
    const durableReceipt = receipt('indeterminate')
    durableReceipt.generation = 7
    durableReceipt.cursor = 99
    durableReceipt.errorCode = 'deferred_effects_partial'
    const { coordinator } = openCoordinator({
      markIndeterminate: vi.fn(
        (): HostCommandReceiptMarkIndeterminateResult => ({
          kind: 'already_indeterminate',
          receipt: durableReceipt
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: FAILED,
          effects: [],
          reason: 'after_snapshot_decode_failed'
        }
      })
    ).toEqual({
      kind: 'indeterminate',
      errorCode: 'deferred_effects_partial',
      position: { generation: 7, cursor: 99 }
    })
  })

  it('envelope anomaly after terminal does not rewrite receipt outcome', () => {
    const { coordinator } = openCoordinator({
      markEnvelopeConsumed: vi.fn(() => {
        throw new Error('SECRET_TOKEN_VALUE')
      })
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
    })
    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: POS,
      envelope: 'anomaly'
    })
    assertBodyFree(result)
  })

  it('envelope consume never runs after indeterminate paths', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const { coordinator } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'rejected',
          reason: 'validation_failed',
          failures: [],
          position: POS
        })
      ),
      markEnvelopeConsumed: envelope
    })
    coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(envelope).not.toHaveBeenCalled()
  })

  it('does not mutate input mutation / effects arrays', () => {
    const effects = Object.freeze([Object.freeze({ ...EFFECT })]) as readonly HostDomainEffectDto[]
    const mutation = Object.freeze({
      kind: 'observed' as const,
      execution: Object.freeze({ ...SUCCESS }),
      effects
    })
    const { coordinator } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'published',
          position: POS_PUBLISHED,
          count: 1,
          results: []
        })
      )
    })
    coordinator.complete({ commandId: COMMAND_ID, mutation })
    expect(mutation.effects).toBe(effects)
    expect(mutation.effects[0]).toEqual(EFFECT)
  })

  it('never double-publishes or double-completes on one call', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'published',
          position: POS_PUBLISHED,
          count: 1,
          results: []
        })
      )
    })
    coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(ports.publishEffects).toHaveBeenCalledTimes(1)
    expect(ports.completeReceipt).toHaveBeenCalledTimes(1)
    expect(ports.markIndeterminate).not.toHaveBeenCalled()
  })

  it('passes exact positions through without inventing cursors', () => {
    const { coordinator, ports } = openCoordinator({
      getPosition: vi.fn(() => ({ generation: 9, cursor: 100 })),
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'published',
          position: { generation: 9, cursor: 105 },
          count: 1,
          results: []
        })
      )
    })
    const published = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    }) as Extract<HostMutationCompletionResult, { kind: 'completed' }>
    expect(published.position).toEqual({ generation: 9, cursor: 105 })
    expect(ports.getPosition).not.toHaveBeenCalled()

    const empty = openCoordinator({
      getPosition: vi.fn(() => ({ generation: 2, cursor: 7 }))
    })
    const emptyResult = empty.coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: CANCELLED, effects: [] }
    }) as Extract<HostMutationCompletionResult, { kind: 'completed' }>
    expect(emptyResult.position).toEqual({ generation: 2, cursor: 7 })
  })

  it('same-terminal replay returns durable position when it differs from candidate', () => {
    const envelope = vi.fn(() => ({ kind: 'existing' as const }))
    // Durable receipt has a different generation/cursor than the candidate.
    const durableCompleted = receipt('succeeded')
    durableCompleted.generation = 5
    durableCompleted.cursor = 77
    const { coordinator } = openCoordinator({
      completeReceipt: vi.fn(() => durableCompleted),
      markEnvelopeConsumed: envelope
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
    })
    expect(result).toEqual({
      kind: 'completed',
      status: 'succeeded',
      position: { generation: 5, cursor: 77 },
      envelope: 'existing'
    })
    expect(envelope).toHaveBeenCalledTimes(1)
  })

  it('completed result uses durable record status, not candidate', () => {
    // Store returns existing 'failed' on a 'succeeded' completion attempt
    // (idempotent cross-status mismatch handled by store, but if store
    //  returns different-status record, coordinator treats it as anomaly).
    const differentStatus = receipt('failed')
    const { coordinator } = openCoordinator({
      completeReceipt: vi.fn(() => differentStatus)
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'complete_refused' })
  })

  it('completed result with wrong commandId in record → anomaly, zero envelope', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const wrongId = receipt('succeeded')
    wrongId.commandId = '99999999-9999-4999-8999-999999999999'
    const { coordinator } = openCoordinator({
      completeReceipt: vi.fn(() => wrongId),
      markEnvelopeConsumed: envelope
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'complete_refused' })
    expect(envelope).not.toHaveBeenCalled()
  })

  it('completed result with NaN generation → anomaly, zero envelope', () => {
    const envelope = vi.fn(() => ({ kind: 'updated' as const }))
    const badRecord = receipt('succeeded')
    badRecord.generation = NaN
    const { coordinator } = openCoordinator({
      completeReceipt: vi.fn(() => badRecord),
      markEnvelopeConsumed: envelope
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'complete_refused' })
    expect(envelope).not.toHaveBeenCalled()
  })

  it('completed result with negative cursor → anomaly', () => {
    const badRecord = receipt('succeeded')
    badRecord.cursor = -1
    const { coordinator } = openCoordinator({
      completeReceipt: vi.fn(() => badRecord)
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
      })
    ).toEqual({ kind: 'anomaly', reason: 'complete_refused' })
  })

  it('indeterminate receipt with wrong commandId → anomaly', () => {
    const wrongId = receipt('indeterminate')
    wrongId.commandId = '99999999-9999-4999-8999-999999999999'
    const { coordinator } = openCoordinator({
      markIndeterminate: vi.fn(
        (): HostCommandReceiptMarkIndeterminateResult => ({
          kind: 'marked',
          receipt: wrongId
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: FAILED,
          effects: [],
          reason: 'diff_incoherent'
        }
      })
    ).toEqual({ kind: 'anomaly', reason: 'mark_indeterminate_refused' })
  })

  it('indeterminate receipt with non-indeterminate status → anomaly', () => {
    const notIndeterminate = receipt('succeeded' as never)
    const { coordinator } = openCoordinator({
      markIndeterminate: vi.fn(
        (): HostCommandReceiptMarkIndeterminateResult => ({
          kind: 'marked',
          receipt: notIndeterminate
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: FAILED,
          effects: [],
          reason: 'diff_incoherent'
        }
      })
    ).toEqual({ kind: 'anomaly', reason: 'mark_indeterminate_refused' })
  })

  it('indeterminate receipt with invalid errorCode → anomaly', () => {
    const badCode = receipt('indeterminate')
    badCode.errorCode = 'not_a_valid_code'
    const { coordinator } = openCoordinator({
      markIndeterminate: vi.fn(
        (): HostCommandReceiptMarkIndeterminateResult => ({
          kind: 'marked',
          receipt: badCode
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: FAILED,
          effects: [],
          reason: 'diff_incoherent'
        }
      })
    ).toEqual({ kind: 'anomaly', reason: 'mark_indeterminate_refused' })
  })

  it('indeterminate receipt with NaN generation → anomaly', () => {
    const badRecord = receipt('indeterminate')
    badRecord.generation = NaN
    const { coordinator } = openCoordinator({
      markIndeterminate: vi.fn(
        (): HostCommandReceiptMarkIndeterminateResult => ({
          kind: 'marked',
          receipt: badRecord
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: FAILED,
          effects: [],
          reason: 'diff_incoherent'
        }
      })
    ).toEqual({ kind: 'anomaly', reason: 'mark_indeterminate_refused' })
  })

  it('negative position from getPosition → host_unavailable, zero receipt mutation', () => {
    const { coordinator, ports } = openCoordinator({
      getPosition: vi.fn(() => ({ generation: 0, cursor: -1 }))
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
      })
    ).toEqual({ kind: 'host_unavailable' })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('fractional position from getPosition → host_unavailable', () => {
    const { coordinator, ports } = openCoordinator({
      getPosition: vi.fn(() => ({ generation: 3, cursor: 3.5 }))
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
      })
    ).toEqual({ kind: 'host_unavailable' })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('NaN position from getPosition → host_unavailable', () => {
    const { coordinator, ports } = openCoordinator({
      getPosition: vi.fn(() => ({ generation: NaN, cursor: 0 }))
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: { kind: 'observed', execution: SUCCESS, effects: [] }
      })
    ).toEqual({ kind: 'host_unavailable' })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('Infinity position from publisher → anomaly, zero receipt mutation', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'published',
          position: { generation: Infinity, cursor: 0 },
          count: 1,
          results: []
        })
      )
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'publish_threw' })
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('invalid publisher rejected position → anomaly', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'rejected',
          reason: 'validation_failed',
          failures: [],
          position: { generation: 0, cursor: -1 }
        })
      )
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'publish_threw' })
    expect(ports.markIndeterminate).not.toHaveBeenCalled()
  })

  it('invalid publisher partial position → anomaly', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'partial',
          position: { generation: 0, cursor: 0.5 },
          publishedCount: 0,
          results: [],
          failedAtIndex: 0,
          failure: { kind: 'store_error', detail: 'err' }
        })
      )
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'publish_threw' })
    expect(ports.markIndeterminate).not.toHaveBeenCalled()
  })

  it('invalid publisher store_error non-null position → anomaly', () => {
    const { coordinator, ports } = openCoordinator({
      publishEffects: vi.fn(
        (): HostDomainDeltaPublishResult => ({
          kind: 'store_error',
          detail: 'err',
          position: { generation: NaN, cursor: 0 }
        })
      )
    })
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: { kind: 'observed', execution: SUCCESS, effects: [EFFECT] }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'publish_threw' })
    expect(ports.markIndeterminate).not.toHaveBeenCalled()
  })

  it('malformed observed execution shape → anomaly, zero port calls', () => {
    const { coordinator, ports } = openCoordinator()
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'observed',
        execution: null as never,
        effects: []
      }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'invalid_command_id' })
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(ports.completeReceipt).not.toHaveBeenCalled()
    expect(ports.markIndeterminate).not.toHaveBeenCalled()
  })

  it('malformed observed effects non-array → anomaly, zero port calls', () => {
    const { coordinator, ports } = openCoordinator()
    const result = coordinator.complete({
      commandId: COMMAND_ID,
      mutation: {
        kind: 'observed',
        execution: SUCCESS,
        effects: null as never
      }
    })
    expect(result).toEqual({ kind: 'anomaly', reason: 'invalid_command_id' })
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('already_indeterminate receipt with missing errorCode → anomaly', () => {
    const noCode = receipt('indeterminate')
    delete (noCode as unknown as Record<string, unknown>).errorCode
    const { coordinator } = openCoordinator({
      markIndeterminate: vi.fn(
        (): HostCommandReceiptMarkIndeterminateResult => ({
          kind: 'already_indeterminate',
          receipt: noCode
        })
      )
    })
    expect(
      coordinator.complete({
        commandId: COMMAND_ID,
        mutation: {
          kind: 'observation_failed',
          execution: FAILED,
          effects: [],
          reason: 'diff_incoherent'
        }
      })
    ).toEqual({ kind: 'anomaly', reason: 'mark_indeterminate_refused' })
  })

  it('production module has no Authority/AppStore/E/resolver/bootstrap/root imports', () => {
    const source = readFileSync(join(__dirname, 'HostMutationCompletionCoordinator.ts'), 'utf8')
    expect(source).not.toMatch(/AppStoreHostAuthority/)
    expect(source).not.toMatch(/HostDeferredCommandBridge/)
    expect(source).not.toMatch(/HostDeferredCommandEnvelopeResolver/)
    expect(source).not.toMatch(/HostRuntimeBootstrap/)
    expect(source).not.toMatch(/from ['"]\.\.\/index/)
    expect(source).not.toMatch(/EnsembleOrchestrator/)
    expect(source).not.toMatch(/from ['"].*\/App['"]/)
    // Type-only substrate imports are allowed; runtime must not construct them.
    expect(source).not.toMatch(/new HostObservedMutationExecutor/)
    expect(source).not.toMatch(/new HostDomainDeltaPublisher/)
    expect(source).not.toMatch(/new HostCommandReceiptStore/)
    expect(source).not.toMatch(/new HostDeferredCommandEnvelopeStore/)
    // No value imports from stores/executors — type-only only.
    expect(source).not.toMatch(/^import \{[^}]*HostCommandReceiptStore/m)
    expect(source).not.toMatch(/^import \{[^}]*HostDomainDeltaPublisher/m)
    expect(source).not.toMatch(/^import \{[^}]*HostObservedMutationExecutor/m)
  })
})

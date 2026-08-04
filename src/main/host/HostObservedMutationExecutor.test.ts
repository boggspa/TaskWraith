import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  createEmptyHostSnapshot,
  type HostActorIdentity,
  type HostCommand,
  type HostSnapshot
} from '../../shared/hostProtocol'
import type { HostBridgeCommandExecutorResult } from './HostBridgeCommandExecutor'
import {
  HostObservedMutationExecutor,
  hostSnapshotHasProjectionTruncation
} from './HostObservedMutationExecutor'

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}

const GENERATED_AT = '2026-08-04T03:00:00.000Z'

const SUCCESS_EXECUTION: HostBridgeCommandExecutorResult = {
  status: 'succeeded',
  resultSummary: 'ok'
}

const FAILED_EXECUTION: HostBridgeCommandExecutorResult = {
  status: 'failed',
  errorCode: 'bridge_not_executed',
  errorMessage: 'nope'
}

const CANCELLED_EXECUTION: HostBridgeCommandExecutorResult = {
  status: 'cancelled',
  errorCode: 'user_declined',
  errorMessage: 'declined'
}

function baseSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    ...createEmptyHostSnapshot({
      generation: 1,
      cursor: 7,
      freshness: 'live',
      generatedAt: GENERATED_AT
    }),
    ...overrides
  }
}

function cloneSnapshot(snapshot: HostSnapshot): HostSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as HostSnapshot
}

function sampleCommand(overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'desktop:client-1:22222222-2222-4222-8222-222222222222',
    actor: ACTOR,
    name: 'composer.send',
    target: { threadId: 'th-1' },
    arguments: { text: 'hello' },
    issuedAt: '2026-08-04T00:00:00.000Z',
    ...overrides
  }
}

function truncatedSnapshot(base: HostSnapshot = baseSnapshot()): HostSnapshot {
  return {
    ...base,
    warnings: [
      {
        warningId: 'projection_truncated:workspaces',
        severity: 'warning',
        code: 'projection_truncated',
        message: 'family workspaces truncated from 999 to 64 (dropped 935)',
        at: 1
      }
    ]
  }
}

function privacyDirtySnapshot(base: HostSnapshot = baseSnapshot()): HostSnapshot {
  return {
    ...base,
    warnings: [
      {
        warningId: 'w-secret',
        severity: 'warning',
        code: 'x',
        message: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        at: 1
      }
    ]
  }
}

function assertBodyFree(result: unknown): void {
  const text = JSON.stringify(result)
  expect(text).not.toMatch(/ghp_/)
  expect(text).not.toMatch(/SECRET_TOKEN_VALUE/)
  expect(text).not.toMatch(/family workspaces truncated/)
  expect(text).not.toMatch(/password/i)
  expect(text).not.toMatch(/Bearer/i)
}

describe('hostSnapshotHasProjectionTruncation', () => {
  it('detects semantic projection_truncated warning codes only', () => {
    expect(hostSnapshotHasProjectionTruncation(baseSnapshot())).toBe(false)
    expect(
      hostSnapshotHasProjectionTruncation(
        baseSnapshot({
          warnings: [
            {
              warningId: 'w-1',
              severity: 'info',
              code: 'other',
              message: 'projection_truncated appears only in body text',
              at: 1
            }
          ]
        })
      )
    ).toBe(false)
    expect(hostSnapshotHasProjectionTruncation(truncatedSnapshot())).toBe(true)
  })
})

describe('HostObservedMutationExecutor construction', () => {
  it('requires both ports', () => {
    expect(() => new HostObservedMutationExecutor(null as never)).toThrow(/options/)
    expect(
      () =>
        new HostObservedMutationExecutor({
          captureSnapshot: undefined as never,
          executeCommand: async () => SUCCESS_EXECUTION
        })
    ).toThrow(/captureSnapshot/)
    expect(
      () =>
        new HostObservedMutationExecutor({
          captureSnapshot: () => baseSnapshot(),
          executeCommand: undefined as never
        })
    ).toThrow(/executeCommand/)
  })
})

describe('HostObservedMutationExecutor pre-execution fences', () => {
  it('does not execute when before capture throws', async () => {
    const executeCommand = vi.fn(async () => SUCCESS_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        throw new Error('capture boom SECRET_TOKEN_VALUE')
      },
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'pre_execution_failed',
      reason: 'before_snapshot_capture_failed',
      effects: []
    })
    expect(executeCommand).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('does not execute when before snapshot fails decode', async () => {
    const executeCommand = vi.fn(async () => SUCCESS_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => ({ not: 'a snapshot' }),
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'pre_execution_failed',
      reason: 'before_snapshot_decode_failed',
      effects: []
    })
    expect(executeCommand).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('does not execute when before snapshot fails privacy', async () => {
    const executeCommand = vi.fn(async () => SUCCESS_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => privacyDirtySnapshot(),
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'pre_execution_failed',
      reason: 'before_snapshot_privacy_failed',
      effects: []
    })
    expect(executeCommand).not.toHaveBeenCalled()
    assertBodyFree(result)
  })

  it('does not execute when before snapshot has projection_truncated warning', async () => {
    const executeCommand = vi.fn(async () => SUCCESS_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => truncatedSnapshot(),
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'pre_execution_failed',
      reason: 'before_projection_truncated',
      effects: []
    })
    expect(executeCommand).not.toHaveBeenCalled()
    assertBodyFree(result)
  })
})

describe('HostObservedMutationExecutor execute once + after capture', () => {
  it('executes exactly once and returns empty effects when unchanged', async () => {
    const before = baseSnapshot({
      threads: [
        {
          id: 'th-1',
          workspaceId: null,
          title: 'Host Arc',
          chatKind: 'ensemble',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ]
    })
    const after = cloneSnapshot(before)
    after.generatedAt = '2026-08-04T04:00:00.000Z'
    after.freshness = 'cached'

    let captures = 0
    const executeCommand = vi.fn(async () => SUCCESS_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'observed',
      execution: SUCCESS_EXECUTION,
      effects: []
    })
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(captures).toBe(2)
  })

  it('returns deterministic upsert + tombstone effects from actual snapshot diff', async () => {
    const before = baseSnapshot({
      workspaces: [
        {
          id: 'ws-keep',
          name: 'Keep',
          path: '/tmp/keep',
          pinned: false,
          updatedAt: 1
        },
        {
          id: 'ws-gone',
          name: 'Gone',
          path: '/tmp/gone',
          pinned: false,
          updatedAt: 1
        }
      ],
      threads: [
        {
          id: 'th-1',
          workspaceId: null,
          title: 'old',
          chatKind: 'ensemble',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ]
    })
    const after = cloneSnapshot(before)
    after.workspaces = [
      {
        id: 'ws-keep',
        name: 'Keep',
        path: '/tmp/keep',
        pinned: false,
        updatedAt: 1
      },
      {
        id: 'ws-new',
        name: 'New',
        path: '/tmp/new',
        pinned: true,
        updatedAt: 2
      }
    ]
    after.threads[0]!.title = 'new-title'

    let captures = 0
    const executeCommand = vi.fn(async () => SUCCESS_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result.kind).toBe('observed')
    if (result.kind !== 'observed') return
    expect(result.execution).toEqual(SUCCESS_EXECUTION)
    expect(result.effects.map((e) => `${e.family}:${e.kind}:${e.entityId}`)).toEqual([
      'workspace:tombstone:ws-gone',
      'workspace:upsert:ws-new',
      'thread:upsert:th-1'
    ])
    const threadUpsert = result.effects.find((e) => e.family === 'thread')
    expect(threadUpsert?.payload).toMatchObject({ id: 'th-1', title: 'new-title' })
    expect(threadUpsert?.payload).not.toBe(after.threads[0])
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })

  it('attempts after capture when execution returns failed status', async () => {
    const before = baseSnapshot()
    const after = cloneSnapshot(before)
    let captures = 0
    const executeCommand = vi.fn(async () => FAILED_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'observed',
      execution: FAILED_EXECUTION,
      effects: []
    })
    expect(captures).toBe(2)
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })

  it('preserves failed outcome with coherent nonempty actual effects', async () => {
    const command = sampleCommand()
    const frozen = JSON.stringify(command)
    const before = baseSnapshot()
    const after = cloneSnapshot(before)
    after.workspaces = [
      {
        id: 'ws-from-after',
        name: 'Observed',
        path: '/tmp/observed',
        pinned: true,
        updatedAt: 2
      }
    ]

    let captures = 0
    const executeCommand = vi.fn(async () => FAILED_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand
    })

    const result = await executor.execute(command)
    expect(result.kind).toBe('observed')
    if (result.kind !== 'observed') return
    expect(result.execution).toEqual(FAILED_EXECUTION)
    expect(
      result.effects.map((effect) => `${effect.family}:${effect.kind}:${effect.entityId}`)
    ).toEqual(['workspace:upsert:ws-from-after'])
    expect(result.effects[0]?.payload).toMatchObject({
      id: 'ws-from-after',
      path: '/tmp/observed'
    })
    expect(JSON.stringify(result.effects)).not.toContain('hello')
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(captures).toBe(2)
    expect(JSON.stringify(command)).toBe(frozen)
    assertBodyFree(result)
  })

  it('preserves cancelled outcome with coherent nonempty actual effects', async () => {
    const command = sampleCommand()
    const frozen = JSON.stringify(command)
    const before = baseSnapshot()
    const after = cloneSnapshot(before)
    after.workspaces = [
      {
        id: 'ws-from-after',
        name: 'Observed',
        path: '/tmp/observed',
        pinned: true,
        updatedAt: 2
      }
    ]

    let captures = 0
    const executeCommand = vi.fn(async () => CANCELLED_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand
    })

    const result = await executor.execute(command)
    expect(result.kind).toBe('observed')
    if (result.kind !== 'observed') return
    expect(result.execution).toEqual(CANCELLED_EXECUTION)
    expect(
      result.effects.map((effect) => `${effect.family}:${effect.kind}:${effect.entityId}`)
    ).toEqual(['workspace:upsert:ws-from-after'])
    expect(result.effects[0]?.payload).toMatchObject({
      id: 'ws-from-after',
      path: '/tmp/observed'
    })
    expect(JSON.stringify(result.effects)).not.toContain('hello')
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(captures).toBe(2)
    expect(JSON.stringify(command)).toBe(frozen)
    assertBodyFree(result)
  })

  it('attempts after capture when executor throws and never leaks thrown secrets', async () => {
    const before = baseSnapshot()
    const after = cloneSnapshot(before)
    after.threads = [
      {
        id: 'th-1',
        workspaceId: null,
        title: 'spawned',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 1,
        messageCount: 0
      }
    ]
    let captures = 0
    const executeCommand = vi.fn(async () => {
      throw new Error('executor boom SECRET_TOKEN_VALUE ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    })
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'execution_may_have_begun',
      effects: [],
      afterCapture: { status: 'complete' }
    })
    // Uncertain execution must never claim observed effects even when after is complete.
    expect(result.effects).toEqual([])
    expect(captures).toBe(2)
    expect(executeCommand).toHaveBeenCalledTimes(1)
    assertBodyFree(result)
  })

  it('reports after capture failure metadata when executor throws and after fails', async () => {
    const before = baseSnapshot()
    let captures = 0
    const executeCommand = vi.fn(async () => {
      throw new Error('boom')
    })
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        if (captures === 1) return before
        throw new Error('after capture SECRET_TOKEN_VALUE')
      },
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'execution_may_have_begun',
      effects: [],
      afterCapture: { status: 'capture_failed' }
    })
    assertBodyFree(result)
  })

  it('does not mutate the input command', async () => {
    const command = sampleCommand()
    const frozen = JSON.stringify(command)
    const before = baseSnapshot()
    const after = cloneSnapshot(before)
    let captures = 0
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand: async (cmd) => {
        // Attempt local mutation of received reference would still be caller-owned;
        // substrate must not mutate the object itself before/after dispatch.
        expect(JSON.stringify(cmd)).toBe(frozen)
        return SUCCESS_EXECUTION
      }
    })

    await executor.execute(command)
    expect(JSON.stringify(command)).toBe(frozen)
  })
})

describe('HostObservedMutationExecutor after-observation failures', () => {
  it('returns zero effects when after capture throws', async () => {
    const before = baseSnapshot()
    let captures = 0
    const executeCommand = vi.fn(async () => SUCCESS_EXECUTION)
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        if (captures === 1) return before
        throw new Error('after fail SECRET_TOKEN_VALUE')
      },
      executeCommand
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'observation_failed',
      execution: SUCCESS_EXECUTION,
      effects: [],
      reason: 'after_snapshot_capture_failed'
    })
    expect(executeCommand).toHaveBeenCalledTimes(1)
    assertBodyFree(result)
  })

  it('returns zero effects when after snapshot fails decode', async () => {
    const before = baseSnapshot()
    let captures = 0
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : { not: 'snapshot' }
      },
      executeCommand: async () => SUCCESS_EXECUTION
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'observation_failed',
      execution: SUCCESS_EXECUTION,
      effects: [],
      reason: 'after_snapshot_decode_failed'
    })
    assertBodyFree(result)
  })

  it('returns zero effects when after snapshot fails privacy', async () => {
    const before = baseSnapshot()
    let captures = 0
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : privacyDirtySnapshot()
      },
      executeCommand: async () => SUCCESS_EXECUTION
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'observation_failed',
      execution: SUCCESS_EXECUTION,
      effects: [],
      reason: 'after_snapshot_privacy_failed'
    })
    assertBodyFree(result)
  })

  it('returns zero effects when after snapshot has projection_truncated', async () => {
    const before = baseSnapshot()
    let captures = 0
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : truncatedSnapshot()
      },
      executeCommand: async () => SUCCESS_EXECUTION
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'observation_failed',
      execution: SUCCESS_EXECUTION,
      effects: [],
      reason: 'after_projection_truncated'
    })
    assertBodyFree(result)
  })

  it('returns zero effects on incoherent generation/cursor mismatch', async () => {
    const before = baseSnapshot()
    const after = cloneSnapshot(before)
    after.generation = 2
    let captures = 0
    const executor = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : after
      },
      executeCommand: async () => SUCCESS_EXECUTION
    })

    const result = await executor.execute(sampleCommand())
    expect(result).toEqual({
      kind: 'observation_failed',
      execution: SUCCESS_EXECUTION,
      effects: [],
      reason: 'diff_incoherent',
      incoherenceReason: 'generation_mismatch'
    })

    const afterCursor = cloneSnapshot(before)
    afterCursor.cursor = 99
    captures = 0
    const executor2 = new HostObservedMutationExecutor({
      captureSnapshot: () => {
        captures += 1
        return captures === 1 ? before : afterCursor
      },
      executeCommand: async () => SUCCESS_EXECUTION
    })
    const result2 = await executor2.execute(sampleCommand())
    expect(result2).toMatchObject({
      kind: 'observation_failed',
      reason: 'diff_incoherent',
      incoherenceReason: 'cursor_mismatch',
      effects: []
    })
  })
})

describe('HostObservedMutationExecutor isolation fences', () => {
  it('does not import forbidden host modules or mutate receipt/publisher seams', () => {
    const source = readFileSync(join(__dirname, 'HostObservedMutationExecutor.ts'), 'utf8')
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /^\s*}?\s*from\s+['"]/.test(line))
      .join('\n')
    expect(importLines).not.toMatch(/HostCommandReceiptStore/)
    expect(importLines).not.toMatch(/HostDeferredCommand/)
    expect(importLines).not.toMatch(/HostAuthority/)
    expect(importLines).not.toMatch(/AppStore/)
    expect(importLines).not.toMatch(/EnsembleOrchestrator/)
    expect(importLines).not.toMatch(/HostRuntimeBootstrap/)
    expect(importLines).not.toMatch(/workLocks/)
    expect(importLines).not.toMatch(/workProvenance/)
    expect(source).not.toMatch(/markIndeterminate/)
    expect(source).not.toMatch(/publishDomain/)
    expect(source).not.toMatch(/new HostDomainDeltaPublisher/)
    // Type-only import of HostDomainEffectDto is allowed; no publisher construction.
    expect(source).toContain("from './HostDomainDeltaPublisher'")
    expect(source).toContain('import type { HostDomainEffectDto }')
    expect(source).toContain('diffHostSnapshotDomainEffects')
    expect(source).toContain('inspectHostSnapshotPrivacy')
    expect(source).toContain('decodeHostSnapshot')
  })
})

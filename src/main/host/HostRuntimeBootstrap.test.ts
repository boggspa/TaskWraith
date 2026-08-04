import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HostRuntimeBootstrap,
  type HostRuntimeDeferredRecoveryRecord
} from './HostRuntimeBootstrap'

const ACTOR = {
  clientId: 'test-client',
  actorId: 'actor-1',
  clientClass: 'test' as const
}

describe('HostRuntimeBootstrap', () => {
  let hostDataDir: string

  beforeEach(() => {
    hostDataDir = mkdtempSync(join(tmpdir(), 'host-runtime-'))
  })

  afterEach(() => {
    rmSync(hostDataDir, { recursive: true, force: true })
  })

  it('composes both durable stores under one injected Host directory', () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })

    expect(runtime.getPosition()).toEqual({ generation: 1, cursor: 0 })
    expect(runtime.getRecoverySummary()).toMatchObject({
      position: { generation: 1, cursor: 0 },
      receipts: { size: 0, indeterminate: 0 }
    })
    expect(runtime.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })

    const delta = runtime.deltaStore.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'thread-1',
      payload: { title: 'bounded' }
    })
    expect(delta.kind).toBe('appended')

    const receipt = runtime.receiptStore.begin({
      commandId: 'command-1',
      idempotencyKey: 'idem-1',
      commandName: 'composer.send',
      commandFingerprint: 'a'.repeat(64),
      actor: ACTOR,
      target: { kind: 'thread', id: 'thread-1' },
      authority: { decision: 'allowed' }
    })
    expect(receipt.kind).toBe('created')
    if (receipt.kind !== 'created') return
    // Position sourced only through delta-backed bootstrap callback.
    expect(receipt.receipt.generation).toBe(1)
    expect(receipt.receipt.cursor).toBe(1)
    expect(receipt.receipt.commandName).toBe('composer.send')
    expect(runtime.getPosition()).toEqual({ generation: 1, cursor: 1 })
  })

  it('reports available deferred recovery and deduplicates indeterminate command ids', () => {
    const first = new HostRuntimeBootstrap({ hostDataDir })
    first.receiptStore.begin({
      commandId: 'shared-command',
      idempotencyKey: 'idem-shared',
      commandName: 'ping',
      commandFingerprint: 'a'.repeat(64),
      actor: ACTOR,
      target: { kind: 'host', id: 'host-1' },
      authority: { decision: 'allowed' }
    })

    const restarted = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () => [
          { commandId: 'shared-command', state: 'indeterminate' },
          { commandId: 'deferred-only', state: 'indeterminate' },
          { commandId: 'completed-deferred', state: 'succeeded' }
        ]
      }
    })
    const summary = restarted.getRecoverySummary()

    expect(summary.receipts).toMatchObject({ size: 1, indeterminate: 1 })
    expect(summary.deferred).toEqual({
      availability: 'available',
      size: 3,
      indeterminate: 2,
      uniqueIndeterminateCommandCount: 2
    })
  })

  it('reports unavailable deferred recovery when the source throws or returns invalid records', () => {
    const throwing = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () => {
          throw new Error('bridge unavailable')
        }
      }
    })
    expect(throwing.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })

    const invalid = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () => [{ commandId: 'missing-state' } as unknown as HostRuntimeDeferredRecoveryRecord]
      }
    })
    expect(invalid.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })
  })

  it('fails closed when deferred recovery exceeds the bounded record limit', () => {
    const runtime = new HostRuntimeBootstrap({
      hostDataDir,
      deferredRecovery: {
        list: () =>
          Array.from({ length: 2_001 }, (_, index) => ({
            commandId: `command-${index}`,
            state: 'indeterminate' as const
          }))
      }
    })

    expect(runtime.getRecoverySummary().deferred).toEqual({
      availability: 'unavailable',
      size: null,
      indeterminate: null,
      uniqueIndeterminateCommandCount: null
    })
  })

  it('reconstructs delta position and promotes pending receipts to indeterminate', () => {
    const first = new HostRuntimeBootstrap({ hostDataDir })
    first.deltaStore.append({
      kind: 'upsert',
      family: 'mission',
      entityId: 'mission-1',
      payload: { title: 'durable' }
    })
    first.deltaStore.resetGeneration('restart-boundary')

    first.receiptStore.begin({
      commandId: 'command-pending',
      idempotencyKey: 'idem-pending',
      commandName: 'ping',
      commandFingerprint: 'b'.repeat(64),
      actor: ACTOR,
      target: { kind: 'mission', id: 'mission-1' },
      authority: { decision: 'allowed' }
    })

    const restarted = new HostRuntimeBootstrap({ hostDataDir })
    expect(restarted.getPosition()).toEqual({ generation: 2, cursor: 1 })
    expect(restarted.deltaStore.getByCursor(1)?.envelope.kind).toBe('generation-reset')
    const pending = restarted.receiptStore.getByCommandId('command-pending', ACTOR)
    expect(pending.kind).toBe('found')
    if (pending.kind !== 'found') return
    expect(pending.receipt.status).toBe('indeterminate')
    expect(pending.receipt.recoveryState).toBe('recoverable-indeterminate')
    // Mint-time position preserved across reopen (generation-reset cursor 1).
    expect(pending.receipt.generation).toBe(2)
    expect(pending.receipt.cursor).toBe(1)
    expect(restarted.getRecoverySummary().receipts.indeterminate).toBe(1)
  })

  it('flushes both stores through their existing compaction boundaries', () => {
    const runtime = new HostRuntimeBootstrap({ hostDataDir })
    runtime.deltaStore.append({ kind: 'upsert', family: 'warning', entityId: 'w1' })
    runtime.flush()

    const reopened = new HostRuntimeBootstrap({ hostDataDir })
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 1 })
    expect(reopened.deltaStore.getByCursor(1)?.envelope.entityId).toBe('w1')
  })
})

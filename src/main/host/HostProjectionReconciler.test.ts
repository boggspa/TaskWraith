import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createEmptyHostSnapshot,
  type HostApprovalProjection,
  type HostSnapshot,
  type HostThreadProjection
} from '../../shared/hostProtocol'
import { HostDeltaStore } from '../../host-runtime/HostDeltaStore'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import { HostProjectionReconciler } from './HostProjectionReconciler'

describe('HostProjectionReconciler', () => {
  let dataDir: string
  let store: HostDeltaStore
  let threads: HostThreadProjection[]
  let approvals: HostApprovalProjection[]

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-reconcile-'))
    store = new HostDeltaStore({
      dataDir,
      now: () => '2026-08-12T20:00:00.000Z'
    })
    threads = []
    approvals = []
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function capture(): HostSnapshot {
    const position = store.getPosition()
    return {
      ...createEmptyHostSnapshot({
        generation: position.generation,
        cursor: position.cursor,
        freshness: 'live',
        generatedAt: '2026-08-12T20:00:00.000Z'
      }),
      threads: JSON.parse(JSON.stringify(threads)) as HostThreadProjection[],
      approvals: JSON.parse(JSON.stringify(approvals)) as HostApprovalProjection[],
      recovery: {
        reopenStatus: 'clean',
        lastGeneration: position.generation,
        lastCursor: position.cursor
      }
    }
  }

  function open(overrides: { captureSnapshot?: () => unknown | Promise<unknown> } = {}) {
    const publisher = new HostDomainDeltaPublisher({ store })
    return new HostProjectionReconciler({
      captureSnapshot: overrides.captureSnapshot ?? capture,
      fetchDeltas: (position) => store.since(position),
      publishEffects: (effects) => publisher.publish(effects),
      schedule: () => ({ scheduled: true }),
      cancelScheduled: () => undefined
    })
  }

  const thread = (): HostThreadProjection => ({
    id: 'thread-1',
    workspaceId: null,
    title: 'Host finish',
    chatKind: 'single',
    archived: false,
    pinned: false,
    updatedAt: 1,
    messageCount: 1
  })

  const approval = (): HostApprovalProjection => ({
    approvalId: 'approval-1',
    commandId: 'command-1',
    threadId: 'thread-1',
    status: 'pending',
    actionKind: 'tool.call',
    createdAt: 1,
    summary: 'Allow tool call'
  })

  it('publishes an external projection mutation through the sole journal', async () => {
    const reconciler = open()
    await reconciler.start()
    threads = [thread()]

    await expect(reconciler.reconcileNow()).resolves.toEqual({
      kind: 'published',
      position: { generation: 1, cursor: 1 },
      count: 1
    })
    const deltas = store.since({ generation: 1, cursor: 0 })
    expect(deltas).toMatchObject({
      kind: 'deltas',
      toCursor: 1,
      deltas: [
        {
          family: 'thread',
          kind: 'upsert',
          entityId: 'thread-1',
          payload: expect.objectContaining({ title: 'Host finish' })
        }
      ]
    })
    reconciler.stop()
  })

  it('advances through Host-command deltas and publishes only the external remainder', async () => {
    const reconciler = open()
    await reconciler.start()

    threads = [thread()]
    const commandDelta = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'thread-1',
      payload: thread()
    })
    expect(commandDelta.kind).toBe('appended')
    approvals = [approval()]

    await expect(reconciler.reconcileNow()).resolves.toEqual({
      kind: 'published',
      position: { generation: 1, cursor: 2 },
      count: 1
    })
    const deltas = store.since({ generation: 1, cursor: 0 })
    expect(deltas.kind).toBe('deltas')
    if (deltas.kind === 'deltas') {
      expect(deltas.deltas.map((delta) => `${delta.family}:${delta.entityId}`)).toEqual([
        'thread:thread-1',
        'approval:approval-1'
      ])
    }
    reconciler.stop()
  })

  it('rebases rather than inventing deltas across a generation reset', async () => {
    const reconciler = open()
    await reconciler.start()
    const reset = store.append({
      kind: 'generation-reset',
      family: 'snapshot-meta',
      generation: 2
    })
    expect(reset.kind).toBe('appended')

    await expect(reconciler.reconcileNow()).resolves.toEqual({
      kind: 'rebased',
      position: { generation: 2, cursor: 1 },
      reason: 'generation_changed'
    })
    reconciler.stop()
  })

  it('fails startup when it cannot establish a coherent baseline', async () => {
    const reconciler = open({ captureSnapshot: () => ({ broken: true }) })
    await expect(reconciler.start()).rejects.toThrow(
      'host_projection_reconcile_baseline_unavailable'
    )
    expect(reconciler.isRunning).toBe(false)
  })

  it('owns and cancels exactly one app-lifetime schedule', async () => {
    const callback = vi.fn()
    const cancel = vi.fn()
    const reconciler = new HostProjectionReconciler({
      captureSnapshot: capture,
      fetchDeltas: (position) => store.since(position),
      publishEffects: (effects) => new HostDomainDeltaPublisher({ store }).publish(effects),
      schedule: (scheduled) => {
        callback.mockImplementation(scheduled)
        return 'timer-1'
      },
      cancelScheduled: cancel
    })

    await reconciler.start()
    expect(reconciler.isRunning).toBe(true)
    reconciler.stop()
    expect(cancel).toHaveBeenCalledWith('timer-1')
    expect(reconciler.isRunning).toBe(false)
    await expect(reconciler.reconcileNow()).resolves.toEqual({ kind: 'stopped' })
  })
})

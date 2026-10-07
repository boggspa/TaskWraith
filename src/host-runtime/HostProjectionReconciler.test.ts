import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createEmptyHostSnapshot,
  type HostApprovalProjection,
  type HostRunProjection,
  type HostSnapshot,
  type HostThreadProjection
} from '../shared/hostProtocol'
import { HostDeltaStore } from './HostDeltaStore'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import {
  HOST_PROJECTION_BASELINE_INCOMPLETE_LIMIT,
  HOST_PROJECTION_TICK_INCOMPLETE_LIMIT,
  HostProjectionReconciler
} from './HostProjectionReconciler'

describe('HostProjectionReconciler', () => {
  let dataDir: string
  let store: HostDeltaStore
  let threads: HostThreadProjection[]
  let approvals: HostApprovalProjection[]
  let runs: HostRunProjection[]

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-reconcile-'))
    store = new HostDeltaStore({
      dataDir,
      now: () => '2026-08-12T20:00:00.000Z'
    })
    threads = []
    approvals = []
    runs = []
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
      runs: JSON.parse(JSON.stringify(runs)) as HostRunProjection[],
      recovery: {
        reopenStatus: 'clean',
        lastGeneration: position.generation,
        lastCursor: position.cursor
      }
    }
  }

  function open(
    overrides: {
      captureSnapshot?: () => unknown | Promise<unknown>
      captureComplete?: () => boolean
    } = {}
  ) {
    const publisher = new HostDomainDeltaPublisher({ store })
    return new HostProjectionReconciler({
      captureSnapshot: overrides.captureSnapshot ?? capture,
      ...(overrides.captureComplete ? { captureComplete: overrides.captureComplete } : {}),
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

  it('aligns transport metadata without serializing the unchanged catalogue or mutating captures', async () => {
    let snapshot = capture()
    snapshot.threads = [{ ...thread(), latestPreview: 'Panel activity. '.repeat(120) }]
    const original = structuredClone(snapshot)
    const reconciler = open({ captureSnapshot: () => snapshot })
    await reconciler.start()
    const initialSnapshot = snapshot
    snapshot = {
      ...snapshot,
      generatedAt: '2026-08-12T20:00:01.000Z',
      freshness: 'cached',
      health: { ...snapshot.health, freshness: 'cached' },
      recovery: { reopenStatus: 'clean' }
    }
    const current = structuredClone(snapshot)
    const stringify = vi.spyOn(JSON, 'stringify')
    let result: Awaited<ReturnType<HostProjectionReconciler['reconcileNow']>>
    let serializations: number
    try {
      result = await reconciler.reconcileNow()
      serializations = stringify.mock.calls.length
    } finally {
      stringify.mockRestore()
      reconciler.stop()
    }
    expect(result).toEqual({ kind: 'unchanged', position: { generation: 1, cursor: 0 } })
    expect(serializations).toBe(0)
    expect(initialSnapshot).toEqual(original)
    expect(snapshot).toEqual(current)
  })

  const run = (runId: string, providerOutcome: HostRunProjection['providerOutcome']) => ({
    runId,
    threadId: 'thread-1',
    providerId: 'codex',
    providerOutcome,
    startedAt: 1
  })

  /** Every envelope the journal holds, as `kind:family:entityId`. */
  function journal(): string[] {
    const deltas = store.since({ generation: 1, cursor: 0 })
    if (deltas.kind !== 'deltas') return []
    return deltas.deltas.map((delta) => `${delta.kind}:${delta.family}:${delta.entityId}`)
  }

  describe('an incomplete capture (the run window has not loaded)', () => {
    // The window a client connected before the restart already holds.
    const held = (): HostRunProjection[] =>
      Array.from({ length: 50 }, (_, index) => run(`run-${index}`, 'completed'))

    it('is not a baseline: boot from an empty window to the loaded one publishes no run rows', async () => {
      let loaded = false
      const reconciler = open({ captureComplete: () => loaded })
      await reconciler.start()
      // Still loading: refused, not adopted, nothing published.
      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'unavailable',
        reason: 'capture_incomplete'
      })
      runs = held()
      loaded = true
      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'initialized',
        position: { generation: 1, cursor: 0 }
      })
      await expect(reconciler.reconcileNow()).resolves.toMatchObject({ kind: 'unchanged' })
      expect(journal()).toEqual([])
      reconciler.stop()
    })

    it('still publishes a genuinely new run on the first loaded pass that shows it', async () => {
      runs = held()
      let loaded = true
      const reconciler = open({ captureComplete: () => loaded })
      await reconciler.start()
      // A refresh is under way: the window's rows are not a whole window.
      loaded = false
      runs = [run('run-new', 'running'), ...held().slice(0, 10)]
      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'unavailable',
        reason: 'capture_incomplete'
      })
      expect(journal()).toEqual([])
      loaded = true
      runs = [run('run-new', 'running'), ...held().slice(0, 49)]
      await expect(reconciler.reconcileNow()).resolves.toMatchObject({
        kind: 'published',
        count: 2
      })
      expect(journal()).toEqual(['tombstone:run:run-49', 'upsert:run:run-new'])
      reconciler.stop()
    })

    it('holds a baseline back only so long, then proceeds as before', async () => {
      const reconciler = open({ captureComplete: () => false })
      await reconciler.start()
      for (let pass = 1; pass < HOST_PROJECTION_BASELINE_INCOMPLETE_LIMIT; pass += 1) {
        await expect(reconciler.reconcileNow()).resolves.toMatchObject({
          reason: 'capture_incomplete'
        })
      }
      await expect(reconciler.reconcileNow()).resolves.toMatchObject({ kind: 'initialized' })
      // Past the bound, an incomplete pass is diffed as it always was.
      threads = [thread()]
      await expect(reconciler.reconcileNow()).resolves.toMatchObject({
        kind: 'published',
        count: 1
      })
      reconciler.stop()
    })

    it('holds other families back only for a few passes inside the loop', async () => {
      let loaded = true
      const reconciler = open({ captureComplete: () => loaded })
      await reconciler.start()
      loaded = false
      approvals = [approval()]
      for (let pass = 0; pass < HOST_PROJECTION_TICK_INCOMPLETE_LIMIT; pass += 1) {
        await expect(reconciler.reconcileNow()).resolves.toMatchObject({
          reason: 'capture_incomplete'
        })
      }
      await expect(reconciler.reconcileNow()).resolves.toMatchObject({
        kind: 'published',
        count: 1
      })
      expect(journal()).toEqual(['upsert:approval:approval-1'])
      reconciler.stop()
    })

    it('reads completeness on both sides of the capture', async () => {
      let loaded = true
      let captures = 0
      const reconciler = open({
        captureComplete: () => loaded,
        captureSnapshot: () => {
          const snapshot = capture()
          // The window unloads while the second capture is taken.
          captures += 1
          if (captures === 2) loaded = false
          return snapshot
        }
      })
      await reconciler.start()
      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'unavailable',
        reason: 'capture_incomplete'
      })
      reconciler.stop()
    })
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

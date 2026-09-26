/**
 * Independent Threads M4 slice 13f2 (design §23.17, test 6): the reconciler's
 * `owns` option. Effects another publisher owns (the public window index,
 * once it publishes) are dropped from the diff before the empty check, so the
 * baseline advances to the current capture and nothing owned is ever
 * republished from a capture that ran ahead of the journal. Non-owned drift
 * is still reconciled, and without `owns` the reconciler is unchanged.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createEmptyHostSnapshot,
  type HostApprovalProjection,
  type HostSnapshot,
  type HostThreadProjection,
  type HostWarningProjection,
  type HostWorkspaceProjection
} from '../shared/hostProtocol'
import { HostDeltaStore } from './HostDeltaStore'
import { HostDomainDeltaPublisher, type HostDomainEffectDto } from './HostDomainDeltaPublisher'
import { HostProjectionReconciler } from './HostProjectionReconciler'
import { hostPublicWindowOwnsEffect } from './HostPublicWindowIndex'

const TIMEOUT = 10_000
const NOW = '2026-09-26T09:00:00.000Z'

describe('HostProjectionReconciler: effects another publisher owns (M4 slice 13f2)', () => {
  let dataDir: string
  let store: HostDeltaStore
  let threads: HostThreadProjection[]
  let workspaces: HostWorkspaceProjection[]
  let approvals: HostApprovalProjection[]
  let warnings: HostWarningProjection[]

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-reconcile-owned-'))
    store = new HostDeltaStore({ dataDir, now: () => NOW })
    threads = []
    workspaces = []
    approvals = []
    warnings = []
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
        generatedAt: NOW
      }),
      workspaces: structuredClone(workspaces),
      threads: structuredClone(threads),
      approvals: structuredClone(approvals),
      warnings: structuredClone(warnings),
      recovery: {
        reopenStatus: 'clean',
        lastGeneration: position.generation,
        lastCursor: position.cursor
      }
    }
  }

  const ownsIndexEffect = (effect: HostDomainEffectDto): boolean =>
    hostPublicWindowOwnsEffect(effect.family, effect.entityId)

  function open(options: { owns?: (effect: HostDomainEffectDto) => boolean } = {}) {
    const publisher = new HostDomainDeltaPublisher({ store })
    const published: HostDomainEffectDto[][] = []
    const reconciler = new HostProjectionReconciler({
      captureSnapshot: capture,
      fetchDeltas: (position) => store.since(position),
      publishEffects: (effects) => {
        published.push([...effects])
        return publisher.publish(effects)
      },
      schedule: () => ({ scheduled: true }),
      cancelScheduled: () => undefined,
      ...(options.owns ? { owns: options.owns } : {})
    })
    return { reconciler, published }
  }

  function journalled(): string[] {
    const since = store.since({ generation: store.getPosition().generation, cursor: 0 })
    if (since.kind !== 'deltas') throw new Error(`unexpected ${since.kind}`)
    return since.deltas.map((delta) => `${delta.kind}:${delta.family}:${delta.entityId}`)
  }

  const thread = (title = 'Indexed'): HostThreadProjection => ({
    id: 'thread-1',
    workspaceId: null,
    title,
    chatKind: 'single',
    archived: false,
    pinned: false,
    updatedAt: 1,
    messageCount: 1
  })

  const workspace = (): HostWorkspaceProjection => ({
    id: 'ws-1',
    name: 'AGBench',
    path: '/tmp/ws',
    pinned: false,
    updatedAt: 1
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

  const warning = (warningId: string): HostWarningProjection => ({
    warningId,
    severity: 'warning',
    code: warningId.split(':')[0]!,
    message: `warning ${warningId}`,
    at: 1
  })

  it(
    'an owned row the capture holds ahead of the journal is not published, and the baseline advances past it',
    async () => {
      const { reconciler, published } = open({ owns: ownsIndexEffect })
      await reconciler.start()
      // The index's group is appended but not yet durable, so the capture
      // (which reads the wire) shows the row the journal does not.
      threads = [thread()]

      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'unchanged',
        position: { generation: 1, cursor: 0 }
      })
      expect(published).toEqual([])
      expect(journalled()).toEqual([])

      // The baseline advanced to that capture: the same row is never a diff again.
      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'unchanged',
        position: { generation: 1, cursor: 0 }
      })
      expect(published).toEqual([])
      await reconciler.stop()
    },
    TIMEOUT
  )

  it(
    'non-owned drift is still reconciled while the owned drift beside it is dropped',
    async () => {
      const { reconciler, published } = open({ owns: ownsIndexEffect })
      await reconciler.start()
      threads = [thread()]
      approvals = [approval()]
      workspaces = [workspace()]
      warnings = [warning('projection_windowed:runs'), warning('host_degraded')]

      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'published',
        position: { generation: 1, cursor: 3 },
        count: 3
      })
      expect(published).toHaveLength(1)
      expect(published[0]!.map((effect) => `${effect.family}:${effect.entityId}`)).toEqual([
        'workspace:ws-1',
        'approval:approval-1',
        'warning:host_degraded'
      ])
      expect(journalled()).toEqual([
        'upsert:workspace:ws-1',
        'upsert:approval:approval-1',
        'upsert:warning:host_degraded'
      ])

      // Settled: the owned rows were absorbed into the baseline with the rest.
      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'unchanged',
        position: { generation: 1, cursor: 3 }
      })
      await reconciler.stop()
    },
    TIMEOUT
  )

  it(
    'an owned row the journal carried and the capture no longer holds yields no tombstone',
    async () => {
      const { reconciler, published } = open({ owns: ownsIndexEffect })
      await reconciler.start()
      // The index published the row; the baseline advances through the journal.
      const appended = store.append({
        kind: 'upsert',
        family: 'thread',
        entityId: 'thread-1',
        payload: thread()
      })
      expect(appended.kind).toBe('appended')
      // The capture lags the journal (a wire read before the group), or the
      // index has since removed the row: either way, not the reconciler's call.
      threads = []

      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'unchanged',
        position: { generation: 1, cursor: 1 }
      })
      expect(published).toEqual([])
      expect(journalled()).toEqual(['upsert:thread:thread-1'])
      await reconciler.stop()
    },
    TIMEOUT
  )

  it(
    'a changed owned row is not republished over the index, but a changed non-owned row is',
    async () => {
      const { reconciler, published } = open({ owns: ownsIndexEffect })
      threads = [thread('Before')]
      workspaces = [workspace()]
      await reconciler.start()
      threads = [thread('After')]
      workspaces = [{ ...workspace(), pinned: true }]

      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'published',
        position: { generation: 1, cursor: 1 },
        count: 1
      })
      expect(
        published[0]!.map((effect) => `${effect.kind}:${effect.family}:${effect.entityId}`)
      ).toEqual(['upsert:workspace:ws-1'])
      expect(journalled()).toEqual(['upsert:workspace:ws-1'])
      await reconciler.stop()
    },
    TIMEOUT
  )

  it(
    'without owns the same owned drift is published as before (negative control)',
    async () => {
      const { reconciler, published } = open()
      await reconciler.start()
      threads = [thread()]
      warnings = [warning('projection_windowed:runs')]

      await expect(reconciler.reconcileNow()).resolves.toEqual({
        kind: 'published',
        position: { generation: 1, cursor: 2 },
        count: 2
      })
      expect(published[0]!.map((effect) => `${effect.family}:${effect.entityId}`)).toEqual([
        'thread:thread-1',
        'warning:projection_windowed:runs'
      ])
      expect(journalled()).toEqual([
        'upsert:thread:thread-1',
        'upsert:warning:projection_windowed:runs'
      ])
      await reconciler.stop()
    },
    TIMEOUT
  )

  it(
    'owns is consulted per effect with the family and the entity id',
    async () => {
      const seen: string[] = []
      const { reconciler } = open({
        owns: (effect) => {
          seen.push(`${effect.family}:${effect.entityId}`)
          return effect.family === 'thread'
        }
      })
      await reconciler.start()
      threads = [thread()]
      approvals = [approval()]

      await expect(reconciler.reconcileNow()).resolves.toMatchObject({
        kind: 'published',
        count: 1
      })
      expect(seen).toEqual(['thread:thread-1', 'approval:approval-1'])
      expect(journalled()).toEqual(['upsert:approval:approval-1'])
      await reconciler.stop()
    },
    TIMEOUT
  )
})

/**
 * The projection reconciler decodes each snapshot once: the capture when it
 * takes it. Its baseline is already decoded, so the diff it runs every pass
 * must not decode either side again (an idle pass used to decode three
 * snapshots: the capture, then the baseline and the capture inside the diff).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as hostProtocol from '../shared/hostProtocol'
import { HostDeltaStore } from './HostDeltaStore'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import { HostProjectionReconciler } from './HostProjectionReconciler'

vi.mock('../shared/hostProtocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/hostProtocol')>()
  return { ...actual, decodeHostSnapshot: vi.fn(actual.decodeHostSnapshot) }
})

const decode = vi.mocked(hostProtocol.decodeHostSnapshot)

describe('HostProjectionReconciler decoding', () => {
  let dataDir: string
  let store: HostDeltaStore
  let threads: hostProtocol.HostThreadProjection[]

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-reconcile-decode-'))
    store = new HostDeltaStore({ dataDir, now: () => '2026-10-07T00:00:00.000Z' })
    threads = [
      {
        id: 'thread-1',
        workspaceId: null,
        title: 'Decoded once',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 1,
        messageCount: 1
      }
    ]
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function capture(): hostProtocol.HostSnapshot {
    const position = store.getPosition()
    return {
      ...hostProtocol.createEmptyHostSnapshot({
        generation: position.generation,
        cursor: position.cursor,
        freshness: 'live',
        generatedAt: '2026-10-07T00:00:00.000Z'
      }),
      threads: structuredClone(threads)
    }
  }

  it('decodes only the capture on a pass that finds nothing new', async () => {
    const publisher = new HostDomainDeltaPublisher({ store })
    const reconciler = new HostProjectionReconciler({
      captureSnapshot: capture,
      fetchDeltas: (position) => store.since(position),
      publishEffects: (effects) => publisher.publish(effects),
      schedule: () => null,
      cancelScheduled: () => undefined
    })
    await reconciler.start()
    decode.mockClear()
    await expect(reconciler.reconcileNow()).resolves.toMatchObject({ kind: 'unchanged' })
    expect(decode).toHaveBeenCalledTimes(1)

    // A change is still found and published from the decoded pair.
    threads = [{ ...threads[0]!, title: 'Changed' }]
    await expect(reconciler.reconcileNow()).resolves.toMatchObject({
      kind: 'published',
      count: 1
    })
    decode.mockClear()
    await expect(reconciler.reconcileNow()).resolves.toMatchObject({ kind: 'unchanged' })
    expect(decode).toHaveBeenCalledTimes(1)
    await reconciler.stop()
  })
})

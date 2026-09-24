import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudioResourceSnapshot } from '../../shared/studioResourceSnapshot'
import {
  STUDIO_RESOURCE_ACTIVITY_FIELDS,
  STUDIO_RESOURCE_VIDEO_FIELDS
} from '../../shared/studioResourceSnapshot'
import type { StudioRequestMessage } from './StudioProtocol'
import { resourceSnapshotFixture } from './StudioResourceSnapshot.test-fixtures'
import {
  StudioResourceSnapshotQueries,
  STUDIO_RESOURCE_QUERY_TIMEOUT_MS
} from './StudioResourceSnapshotQuery'

afterEach(() => vi.useRealTimers())

function request(queries = new StudioResourceSnapshotQueries(), child = {}, sequence = 1) {
  const writes: StudioRequestMessage[] = []
  const ticket = queries.reserve(child, 4242)
  ticket.send(7, (message) => {
    writes.push(message)
    return true
  })
  const wire = writes[0]
  const snapshot = resourceSnapshotFixture({
    nonce: (wire.params as { nonce: string }).nonce,
    documentRevision: 7,
    sampleSequence: sequence,
    monotonicMs: 100 + sequence
  })
  return {
    queries,
    child,
    ticket,
    wire,
    snapshot,
    reply: (result: unknown = snapshot) =>
      queries.handle(child, { jsonrpc: '2.0', id: wire.id, result })
  }
}

describe('StudioResourceSnapshotQueries', () => {
  it('preserves measured overcapacity and retained audio rather than applying acceptance policy', async () => {
    const query = request()
    query.snapshot.resources.video.presentationLeases = 8
    query.snapshot.resources.video.presentationLeaseCapacity = 3
    expect(query.wire).toMatchObject({
      method: 'studio/getResourceSnapshot',
      id: -1,
      params: {
        schemaVersion: 1,
        expectedRevision: 7,
        nonce: expect.stringMatching(/^[a-f0-9]{48}$/)
      }
    })
    expect(query.reply()).toBe(true)
    await expect(query.ticket.result).resolves.toEqual({ ok: true, snapshot: query.snapshot })
    expect(query.ticket.pending).toBe(false)
    expect(query.reply()).toBe(false)
  })

  const invalidCases: [string, (snapshot: StudioResourceSnapshot) => void][] = [
    [
      'nonce',
      (s) => {
        s.nonce = 'b'.repeat(48)
      }
    ],
    [
      'PID',
      (s) => {
        s.processPid++
      }
    ],
    [
      'revision',
      (s) => {
        s.documentRevision++
      }
    ],
    [
      'instance identifier',
      (s) => {
        s.processInstanceId = 'invented'
      }
    ],
    [
      'non-finite time',
      (s) => {
        s.monotonicMs = NaN
      }
    ],
    [
      'unsafe count',
      (s) => {
        s.resources.video.frameObjects = Number.MAX_SAFE_INTEGER + 1
      }
    ],
    [
      'negative count',
      (s) => {
        s.resources.audio.pcmBytes = -1
      }
    ],
    [
      'fractional count',
      (s) => {
        s.resources.video.decoderSessions = 0.5
      }
    ],
    [
      'duplicate surfaces',
      (s) => {
        s.resources.video.ioSurfaceIds = [1, 1]
        s.resources.video.ioSurfaces = 2
      }
    ],
    [
      'surface count mismatch',
      (s) => {
        s.resources.video.ioSurfaceIds = [1]
      }
    ],
    [
      'duplicate assets',
      (s) => {
        s.assets.sequenceAssetIds = ['a', 'a']
      }
    ],
    [
      'byte budget',
      (s) => {
        s.assets.sequenceAssetIds = Array.from({ length: 1000 }, (_, i) => `${i}${'a'.repeat(200)}`)
      }
    ]
  ]
  it.each(invalidCases)('rejects invalid %s', async (_name, mutate) => {
    const query = request()
    mutate(query.snapshot)
    expect(query.reply()).toBe(true)
    await expect(query.ticket.result).resolves.toMatchObject({
      ok: false,
      code: 'resource_snapshot_invalid'
    })
  })

  it.each(STUDIO_RESOURCE_VIDEO_FIELDS)('requires the actual %s observation', async (field) => {
    const query = request()
    const malformed = structuredClone(query.snapshot) as unknown as {
      resources: { video: Record<string, unknown> }
    }
    delete malformed.resources.video[field]
    query.reply(malformed)
    await expect(query.ticket.result).resolves.toMatchObject({
      ok: false,
      code: 'resource_snapshot_invalid'
    })
  })

  it.each(['sequence', 'time', 'instance', ...STUDIO_RESOURCE_ACTIVITY_FIELDS])(
    'rejects stale/reset %s within the same child',
    async (field) => {
      const first = request()
      for (const key of STUDIO_RESOURCE_ACTIVITY_FIELDS) first.snapshot.activity[key] = 5
      first.reply()
      await first.ticket.result
      const second = request(first.queries, first.child, 2)
      second.snapshot.activity = { ...first.snapshot.activity }
      if (field === 'sequence') second.snapshot.sampleSequence = 1
      else if (field === 'time') second.snapshot.monotonicMs = first.snapshot.monotonicMs
      else if (field === 'instance')
        second.snapshot.processInstanceId = 'f04e4d5d-1723-4e1a-8a6e-e1f14f97825e'
      else {
        const key = field as keyof StudioResourceSnapshot['activity']
        second.snapshot.activity[key] = 4
      }
      second.reply()
      await expect(second.ticket.result).resolves.toMatchObject({
        ok: false,
        code: 'resource_snapshot_invalid'
      })
    }
  )

  it('accepts advancing samples with a new nonce and nondecreasing lifetime totals', async () => {
    const first = request()
    first.reply()
    await first.ticket.result
    const second = request(first.queries, first.child, 2)
    expect(second.snapshot.nonce).not.toBe(first.snapshot.nonce)
    second.snapshot.activity.decodeSubmissions++
    second.reply()
    await expect(second.ticket.result).resolves.toMatchObject({ ok: true })
  })

  it('does not let a consumer mutation erase the retained freshness fence', async () => {
    const first = request()
    first.reply()
    await first.ticket.result
    first.snapshot.activity.decodeSubmissions = 0
    first.snapshot.sampleSequence = 0
    const second = request(first.queries, first.child, 2)
    second.snapshot.activity.decodeSubmissions = 1
    second.reply()
    await expect(second.ticket.result).resolves.toMatchObject({ code: 'resource_snapshot_invalid' })
  })

  it('bounds pending work before it reaches the serialized send lane and never sends expired work', async () => {
    vi.useFakeTimers()
    const queries = new StudioResourceSnapshotQueries()
    const child = {}
    const pending = Array.from({ length: 4 }, () => queries.reserve(child, 4242))
    await expect(queries.reserve(child, 4242).result).resolves.toMatchObject({
      ok: false,
      code: 'resource_query_capacity'
    })
    await vi.advanceTimersByTimeAsync(STUDIO_RESOURCE_QUERY_TIMEOUT_MS)
    for (const ticket of pending) {
      await expect(ticket.result).resolves.toMatchObject({
        ok: false,
        code: 'resource_query_timeout'
      })
      const write = vi.fn(() => true)
      ticket.send(7, write)
      expect(write).not.toHaveBeenCalled()
    }
    const next = queries.reserve(child, 4242)
    expect(next.pending).toBe(true)
    next.cancel('resource_query_stopped', 'done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fences old children even when the replacement has the same PID', async () => {
    const first = request()
    first.queries.cancelChild(first.child, 'resource_query_child_exited', 'exited')
    await expect(first.ticket.result).resolves.toMatchObject({
      code: 'resource_query_child_exited'
    })
    const next = request(first.queries, {})
    expect(
      next.queries.handle(first.child, { jsonrpc: '2.0', id: next.wire.id, result: next.snapshot })
    ).toBe(false)
    expect(next.reply(first.snapshot)).toBe(true)
    await expect(next.ticket.result).resolves.toMatchObject({ code: 'resource_snapshot_invalid' })
  })

  it('ignores unrelated IDs and methods without satisfying the diagnostic query', async () => {
    const query = request()
    expect(
      query.queries.handle(query.child, { jsonrpc: '2.0', id: 99, result: query.snapshot })
    ).toBe(false)
    expect(
      query.queries.handle(query.child, {
        jsonrpc: '2.0',
        id: query.wire.id,
        method: 'studio/hello'
      })
    ).toBe(false)
    expect(query.ticket.pending).toBe(true)
    query.reply()
    await expect(query.ticket.result).resolves.toMatchObject({ ok: true })
  })

  it.each([false, 'throw'])(
    'settles a failed write (%s) without a timeout or restart',
    async (behavior) => {
      const queries = new StudioResourceSnapshotQueries()
      const ticket = queries.reserve({}, 4242)
      ticket.send(7, () => {
        if (behavior === 'throw') throw new Error('closed')
        return false
      })
      await expect(ticket.result).resolves.toMatchObject({ code: 'resource_query_delivery_failed' })
    }
  )

  it('returns explicit native unavailability and rejects ambiguous response envelopes', async () => {
    const query = request()
    const error = {
      code: 4011,
      message: 'headless',
      data: { studioCode: 'resource_snapshot_unavailable' }
    }
    query.queries.handle(query.child, { jsonrpc: '2.0', id: query.wire.id, error })
    await expect(query.ticket.result).resolves.toMatchObject({
      code: 'resource_snapshot_unavailable'
    })
    const next = request(query.queries, query.child)
    next.queries.handle(next.child, {
      jsonrpc: '2.0',
      id: next.wire.id,
      error,
      result: next.snapshot
    })
    await expect(next.ticket.result).resolves.toMatchObject({ code: 'resource_snapshot_invalid' })
  })
})

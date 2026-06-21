import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CanvasStore } from './CanvasStore'
import type { CanvasEventRecord, CanvasSessionRecord } from './canvasTypes'

function session(id: string, over: Partial<CanvasSessionRecord> = {}): CanvasSessionRecord {
  return {
    schemaVersion: 1,
    id,
    driver: 'web',
    url: 'http://localhost:3000',
    title: 'title',
    viewport: { width: 1280, height: 800 },
    originAllowlist: [],
    status: 'active',
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
    ...over
  }
}

function event(id: string, canvasId: string, over: Partial<CanvasEventRecord> = {}): CanvasEventRecord {
  return {
    schemaVersion: 1,
    id,
    canvasId,
    kind: 'snapshot',
    createdAt: '2026-06-21T00:00:00.000Z',
    ...over
  }
}

describe('CanvasStore', () => {
  let dir: string
  let store: CanvasStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-store-'))
    store = new CanvasStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips sessions and is idempotent on id', () => {
    store.upsertSession(session('a'))
    store.upsertSession(session('a', { status: 'closed' }))
    expect(store.listSessions()).toHaveLength(1)
    expect(store.getSession('a')?.status).toBe('closed')
  })

  it('persists across store instances', () => {
    store.upsertSession(session('a'))
    const reopened = new CanvasStore(dir)
    expect(reopened.getSession('a')?.url).toBe('http://localhost:3000')
  })

  it('rejects records without an id', () => {
    expect(() => store.upsertSession(session(''))).toThrow()
  })

  it('appends events, filters by canvasId', () => {
    store.appendEvent(event('e1', 'a'))
    store.appendEvent(event('e2', 'b'))
    store.appendEvent(event('e3', 'a', { kind: 'screenshot' }))
    expect(store.listEvents('a')).toHaveLength(2)
    expect(store.listEvents()).toHaveLength(3)
    expect(store.listEvents('a').map((e) => e.kind)).toEqual(['snapshot', 'screenshot'])
  })

  it('normalizes a screenshot event to metadata only (no pixel field round-trips unredacted)', () => {
    store.appendEvent(event('e1', 'a', { kind: 'screenshot', detail: { frameHash: 'abc', width: 10, height: 20 } }))
    const [evt] = store.listEvents('a')
    expect(evt.detail).toEqual({ frameHash: 'abc', width: 10, height: 20 })
  })
})

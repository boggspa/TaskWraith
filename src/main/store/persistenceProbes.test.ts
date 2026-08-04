import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  __setPersistenceProbeTestHooks,
  beginPersistenceWrite,
  classifyPersistenceTarget,
  isPersistenceProbeEnabled,
  recordPersistenceWrite,
  resetPersistenceProbes,
  snapshotPersistenceProbes
} from './persistenceProbes'

/**
 * A scripted clock so phase durations are asserted exactly rather than being
 * "some positive number", which would pass even if the phases were swapped.
 */
function scriptedClock(ticks: number[]): () => number {
  let index = 0
  return () => {
    const value = ticks[Math.min(index, ticks.length - 1)]
    index += 1
    return value
  }
}

describe('persistenceProbes', () => {
  beforeEach(() => {
    resetPersistenceProbes()
    __setPersistenceProbeTestHooks({ enabled: null, now: null })
    delete process.env.PERF_PRELOAD_PROBE
  })

  afterEach(() => {
    resetPersistenceProbes()
    __setPersistenceProbeTestHooks({ enabled: null, now: null })
    delete process.env.PERF_PRELOAD_PROBE
  })

  describe('gating', () => {
    it('is disabled by default so production pays only a null check', () => {
      expect(isPersistenceProbeEnabled()).toBe(false)
      expect(beginPersistenceWrite('/tmp/chats/abc.json')).toBeNull()
    })

    it('enables from PERF_PRELOAD_PROBE and reads the flag fresh, not at import', () => {
      expect(isPersistenceProbeEnabled()).toBe(false)
      process.env.PERF_PRELOAD_PROBE = '1'
      expect(isPersistenceProbeEnabled()).toBe(true)
      expect(beginPersistenceWrite('/tmp/chats/abc.json')).not.toBeNull()
    })

    it('accepts "true" as well as "1" but rejects other values', () => {
      process.env.PERF_PRELOAD_PROBE = 'true'
      expect(isPersistenceProbeEnabled()).toBe(true)
      process.env.PERF_PRELOAD_PROBE = '0'
      expect(isPersistenceProbeEnabled()).toBe(false)
      process.env.PERF_PRELOAD_PROBE = 'yes'
      expect(isPersistenceProbeEnabled()).toBe(false)
    })

    it('drops samples entirely while disabled', () => {
      recordPersistenceWrite({
        target: 'chat',
        bytes: 100,
        serializeMs: 1,
        writeMs: 1,
        fsyncMs: 1,
        renameMs: 1,
        totalMs: 4
      })
      const snapshot = snapshotPersistenceProbes()
      expect(snapshot.enabled).toBe(false)
      expect(snapshot.writes).toBe(0)
      expect(snapshot.targets).toEqual([])
    })
  })

  describe('classification', () => {
    it('maps each named persistence suspect to its own class', () => {
      expect(classifyPersistenceTarget('/u/chat-list-index.json')).toBe('chat-list-index')
      expect(classifyPersistenceTarget('/u/session-checkpoints.json')).toBe('session-checkpoints')
      expect(classifyPersistenceTarget('/u/session-checkpoints-archive.jsonl')).toBe(
        'session-checkpoints-archive'
      )
      expect(classifyPersistenceTarget('/u/settings.json')).toBe('settings')
      expect(classifyPersistenceTarget('/u/chats/2f8c-aaaa.json')).toBe('chat')
    })

    it('collapses every chat id to one class so a 455-turn soak cannot grow cardinality', () => {
      const first = classifyPersistenceTarget('/u/chats/aaaaaaaa-1111.json')
      const second = classifyPersistenceTarget('/u/chats/bbbbbbbb-2222.json')
      expect(first).toBe('chat')
      expect(second).toBe('chat')
    })

    it('classifies unknown files as other rather than retaining their path', () => {
      expect(classifyPersistenceTarget('/u/some-private-workspace-name.json')).toBe('other')
    })

    it('handles Windows-style separators', () => {
      expect(classifyPersistenceTarget('C:\\Users\\x\\chats\\abc.json')).toBe('chat')
      expect(classifyPersistenceTarget('C:\\Users\\x\\chat-list-index.json')).toBe('chat-list-index')
    })
  })

  describe('phase attribution', () => {
    it('attributes each phase to the correct duration', () => {
      // begin=0, serialize@5, write@25, fsync@125, rename@130, end@140
      __setPersistenceProbeTestHooks({
        enabled: true,
        now: scriptedClock([0, 5, 25, 125, 130, 140])
      })

      const probe = beginPersistenceWrite('/u/chats/abc.json')
      expect(probe).not.toBeNull()
      probe!.afterSerialize(4096)
      probe!.afterWrite()
      probe!.afterFsync()
      probe!.afterRename()
      probe!.end()

      const [chat] = snapshotPersistenceProbes().targets
      expect(chat.target).toBe('chat')
      expect(chat.writes).toBe(1)
      expect(chat.bytes).toBe(4096)
      expect(chat.serializeMs).toBe(5)
      expect(chat.writeMs).toBe(20)
      // fsync is the phase a CPU profile cannot see; it must be isolated.
      expect(chat.fsyncMs).toBe(100)
      expect(chat.renameMs).toBe(5)
      expect(chat.totalMs).toBe(140)
    })

    it('keeps totalMs as the full durable span, exceeding the sum of named phases', () => {
      __setPersistenceProbeTestHooks({
        enabled: true,
        now: scriptedClock([0, 5, 25, 125, 130, 200])
      })
      const probe = beginPersistenceWrite('/u/chats/abc.json')!
      probe.afterSerialize(10)
      probe.afterWrite()
      probe.afterFsync()
      probe.afterRename()
      probe.end()

      const [chat] = snapshotPersistenceProbes().targets
      const named = chat.serializeMs + chat.writeMs + chat.fsyncMs + chat.renameMs
      expect(named).toBe(130)
      expect(chat.totalMs).toBe(200)
      expect(chat.totalMs).toBeGreaterThan(named)
    })

    it('contributes nothing when a write throws before end()', () => {
      __setPersistenceProbeTestHooks({ enabled: true, now: scriptedClock([0, 5, 25]) })
      const probe = beginPersistenceWrite('/u/chats/abc.json')!
      probe.afterSerialize(10)
      probe.afterWrite()
      // No end(): the write failed. A failed write is not a measurement.
      expect(snapshotPersistenceProbes().writes).toBe(0)
    })

    it('is idempotent so a double end() cannot double-count', () => {
      __setPersistenceProbeTestHooks({ enabled: true, now: () => 0 })
      const probe = beginPersistenceWrite('/u/chats/abc.json')!
      probe.afterSerialize(10)
      probe.end()
      probe.end()
      expect(snapshotPersistenceProbes().writes).toBe(1)
    })

    it('never emits negative durations if the clock steps backwards', () => {
      __setPersistenceProbeTestHooks({ enabled: true, now: scriptedClock([100, 50, 40, 30, 20, 10]) })
      const probe = beginPersistenceWrite('/u/chats/abc.json')!
      probe.afterSerialize(10)
      probe.afterWrite()
      probe.afterFsync()
      probe.afterRename()
      probe.end()
      const [chat] = snapshotPersistenceProbes().targets
      expect(chat.serializeMs).toBe(0)
      expect(chat.writeMs).toBe(0)
      expect(chat.fsyncMs).toBe(0)
      expect(chat.renameMs).toBe(0)
      expect(chat.totalMs).toBe(0)
    })
  })

  describe('aggregation', () => {
    beforeEach(() => {
      __setPersistenceProbeTestHooks({ enabled: true, now: null })
    })

    it('accumulates writes per target and tracks the worst single write', () => {
      recordPersistenceWrite({
        target: 'chat',
        bytes: 1000,
        serializeMs: 1,
        writeMs: 2,
        fsyncMs: 3,
        renameMs: 4,
        totalMs: 10
      })
      recordPersistenceWrite({
        target: 'chat',
        bytes: 3000,
        serializeMs: 1,
        writeMs: 2,
        fsyncMs: 3,
        renameMs: 4,
        totalMs: 40
      })

      const [chat] = snapshotPersistenceProbes().targets
      expect(chat.writes).toBe(2)
      expect(chat.bytes).toBe(4000)
      expect(chat.fsyncMs).toBe(6)
      expect(chat.maxTotalMs).toBe(40)
      expect(chat.maxBytes).toBe(3000)
    })

    it('separates the three named write-amplification suspects and ranks by bytes', () => {
      recordPersistenceWrite({
        target: 'chat',
        bytes: 15_700_000,
        serializeMs: 0,
        writeMs: 0,
        fsyncMs: 0,
        renameMs: 0,
        totalMs: 0
      })
      recordPersistenceWrite({
        target: 'session-checkpoints',
        bytes: 20_300_000,
        serializeMs: 0,
        writeMs: 0,
        fsyncMs: 0,
        renameMs: 0,
        totalMs: 0
      })
      recordPersistenceWrite({
        target: 'chat-list-index',
        bytes: 7_200_000,
        serializeMs: 0,
        writeMs: 0,
        fsyncMs: 0,
        renameMs: 0,
        totalMs: 0
      })

      const snapshot = snapshotPersistenceProbes()
      expect(snapshot.targets.map((entry) => entry.target)).toEqual([
        'session-checkpoints',
        'chat',
        'chat-list-index'
      ])
      expect(snapshot.bytes).toBe(43_200_000)
      expect(snapshot.writes).toBe(3)
    })

    it('returns copies so a caller cannot mutate the live counters', () => {
      recordPersistenceWrite({
        target: 'chat',
        bytes: 10,
        serializeMs: 0,
        writeMs: 0,
        fsyncMs: 0,
        renameMs: 0,
        totalMs: 0
      })
      const first = snapshotPersistenceProbes()
      first.targets[0].bytes = 999_999
      expect(snapshotPersistenceProbes().targets[0].bytes).toBe(10)
    })

    it('reset clears counters between harness phases', () => {
      recordPersistenceWrite({
        target: 'chat',
        bytes: 10,
        serializeMs: 0,
        writeMs: 0,
        fsyncMs: 0,
        renameMs: 0,
        totalMs: 0
      })
      expect(snapshotPersistenceProbes().writes).toBe(1)
      resetPersistenceProbes()
      expect(snapshotPersistenceProbes().writes).toBe(0)
    })
  })

  describe('writeJson wiring (source region)', () => {
    // No DOM/electron test env here, and importing store/index.ts pulls the
    // whole main-process surface, so the wiring is guarded by asserting the
    // call order in source. This catches accidental removal or reordering,
    // which would silently produce an empty metric set that reads as a clean
    // run with nothing measured.
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf-8')
    const writeJsonRegion = source.slice(
      source.indexOf('function writeJson<T>('),
      source.indexOf('function normalizeHistoryDeletionIntent')
    )

    it('imports the probe', () => {
      expect(source).toContain("from './persistenceProbes'")
    })

    it('marks every durability phase in order inside writeJson', () => {
      const order = [
        'beginPersistenceWrite(filePath)',
        'probe?.afterSerialize(',
        'probe?.afterWrite()',
        'probe?.afterFsync()',
        'probe?.afterRename()',
        'probe?.end()'
      ]
      let cursor = -1
      for (const marker of order) {
        const at = writeJsonRegion.indexOf(marker)
        expect(at, `missing or out-of-order probe marker: ${marker}`).toBeGreaterThan(cursor)
        cursor = at
      }
    })

    it('serializes once and measures the bytes actually written', () => {
      expect(writeJsonRegion).toContain('const serialized = JSON.stringify(data, null, 2)')
      expect(writeJsonRegion).toContain("Buffer.byteLength(serialized, 'utf-8')")
      expect(writeJsonRegion).toContain("fs.writeFileSync(fd, serialized, 'utf-8')")
    })
  })
})

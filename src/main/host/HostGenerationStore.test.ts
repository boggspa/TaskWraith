import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HostGenerationStore,
  HOST_GENERATION_CHECKPOINT_FILENAME,
  HOST_GENERATION_JOURNAL_FILENAME
} from './HostGenerationStore'

describe('HostGenerationStore', () => {
  let dataDir: string
  let clock: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-generation-'))
    clock = '2026-08-03T17:00:00.000Z'
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function openStore(options?: { compactAfterRecords?: number; initialGeneration?: number }) {
    return new HostGenerationStore({
      dataDir,
      now: () => clock,
      compactAfterRecords: options?.compactAfterRecords,
      initialGeneration: options?.initialGeneration
    })
  }

  it('seeds initial generation/cursor and advances monotonically within a generation', () => {
    const store = openStore()
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })

    const a1 = store.advance({ generation: 1, cursor: 0 })
    expect(a1.kind).toBe('advanced')
    if (a1.kind !== 'advanced') return
    expect(a1.state.cursor).toBe(1)
    expect(a1.state.generation).toBe(1)

    const a2 = store.advance({ generation: 1, cursor: 1 })
    expect(a2.kind).toBe('advanced')
    if (a2.kind !== 'advanced') return
    expect(a2.state.cursor).toBe(2)
  })

  it('rejects advance when previous cursor or generation mismatches', () => {
    const store = openStore()
    store.advance({ generation: 1, cursor: 0 })

    const gap = store.advance({ generation: 1, cursor: 0 })
    expect(gap.kind).toBe('rejected')
    if (gap.kind !== 'rejected') return
    expect(gap.reason).toBe('previous_cursor_mismatch')

    const genMismatch = store.advance({ generation: 9, cursor: 1 })
    expect(genMismatch.kind).toBe('rejected')
    if (genMismatch.kind !== 'rejected') return
    expect(genMismatch.reason).toBe('generation_mismatch')
  })

  it('durably resets generation and zeroes cursor', () => {
    const store = openStore()
    store.advance({ generation: 1, cursor: 0 })
    store.advance({ generation: 1, cursor: 1 })

    clock = '2026-08-03T17:00:05.000Z'
    const reset = store.resetGeneration('host restart discontinuity')
    expect(reset.kind).toBe('reset')
    expect(reset.state.generation).toBe(2)
    expect(reset.state.cursor).toBe(0)
    expect(reset.state.lastResetReason).toBe('host restart discontinuity')

    const next = store.advance({ generation: 2, cursor: 0 })
    expect(next.kind).toBe('advanced')
    if (next.kind !== 'advanced') return
    expect(next.state.cursor).toBe(1)
  })

  it('reopens after simulated Host restart and preserves generation/cursor', () => {
    const store = openStore()
    store.advance({ generation: 1, cursor: 0 })
    store.advance({ generation: 1, cursor: 1 })
    store.resetGeneration('fence')
    store.advance({ generation: 2, cursor: 0 })

    const reopened = openStore()
    expect(reopened.getPosition()).toEqual({ generation: 2, cursor: 1 })
    expect(reopened.getState().lastResetReason).toBe('fence')
  })

  it('drops a truncated journal tail without inventing state', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.advance({ generation: 1, cursor: 0 })
    store.advance({ generation: 1, cursor: 1 })

    const journalPath = join(dataDir, HOST_GENERATION_JOURNAL_FILENAME)
    const prior = readFileSync(journalPath, 'utf8')
    writeFileSync(
      journalPath,
      `${prior}{"op":"advance","generation":1,"previousCursor":2,"cursor":3`
    )

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 2 })
    expect(reopened.getState().recoveryState).toBe('recovered-truncated-tail')
  })

  it('skips corrupt interior journal lines and surfaces recovery state', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.advance({ generation: 1, cursor: 0 })
    store.advance({ generation: 1, cursor: 1 })

    const journalPath = join(dataDir, HOST_GENERATION_JOURNAL_FILENAME)
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    // Inject corrupt line after seed + first advance; second advance remains valid after it.
    const corrupted = [...lines.slice(0, 2), 'NOT-JSON', ...lines.slice(2)].join('\n') + '\n'
    writeFileSync(journalPath, corrupted)

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getPosition().cursor).toBe(2)
    expect(reopened.getState().recoveryState).toBe('recovered-corrupt-interior')
    expect(reopened.getState().recoveryWarnings.length).toBeGreaterThan(0)
  })

  it('compacts journal into checkpoint', () => {
    const store = openStore({ compactAfterRecords: 2 })
    store.advance({ generation: 1, cursor: 0 })
    store.advance({ generation: 1, cursor: 1 })
    store.advance({ generation: 1, cursor: 2 })
    store.compact()

    const checkpointPath = join(dataDir, HOST_GENERATION_CHECKPOINT_FILENAME)
    expect(existsSync(checkpointPath)).toBe(true)
    const doc = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      generation: number
      cursor: number
    }
    expect(doc.generation).toBe(1)
    expect(doc.cursor).toBe(3)

    const reopened = openStore()
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 3 })
  })
})

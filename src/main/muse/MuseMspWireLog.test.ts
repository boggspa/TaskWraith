import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { MuseMspWireObservation } from './MuseMspClient'
import { createMuseMspWireLog, museMspWireLogDebugEnabled } from './MuseMspWireLog'

const dirs: string[] = []
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-wire-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const readEvents = (dir: string, runId: string): Record<string, unknown>[] =>
  readFileSync(join(dir, `${runId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe('createMuseMspWireLog', () => {
  it('records open, verbose frames, observations, and close as JSONL', () => {
    const dir = makeDir()
    const sink = createMuseMspWireLog({
      dir,
      runId: 'run-1',
      sessionId: 'sess-1',
      verbose: true,
      now: () => 1_700_000_000_000
    })
    sink.onRawFrame('out', { jsonrpc: '2.0', id: 1, method: 'initialize' })
    sink.observe({ type: 'unparsable', line: 'garbage' } satisfies MuseMspWireObservation)
    sink.close()
    const events = readEvents(dir, 'run-1')
    expect(events.map((event) => event.event)).toEqual(['open', 'frame', 'observation', 'close'])
    expect(events[0]).toMatchObject({ runId: 'run-1', sessionId: 'sess-1', verbose: true })
    expect(events[1]).toMatchObject({ direction: 'out', frame: { id: 1 } })
    expect(events[2].observation).toEqual({ type: 'unparsable', line: 'garbage' })
    expect(typeof events[3].ts).toBe('string')
  })

  it('drops frame events unless verbose but always keeps metadata events', () => {
    const dir = makeDir()
    const sink = createMuseMspWireLog({ dir, runId: 'run-2', verbose: false })
    sink.onRawFrame('in', { method: 'item/delta' })
    sink.observe({ type: 'unknownMethod', method: 'future/method' })
    sink.close()
    expect(readEvents(dir, 'run-2').map((event) => event.event)).toEqual([
      'open',
      'observation',
      'close'
    ])
  })

  it('parses the debug env flag', () => {
    const enabled = { TASKWRAITH_MUSE_MSP_DEBUG: '1' } as NodeJS.ProcessEnv
    expect(museMspWireLogDebugEnabled(enabled)).toBe(true)
    expect(
      museMspWireLogDebugEnabled({ TASKWRAITH_MUSE_MSP_DEBUG: 'true' } as NodeJS.ProcessEnv)
    ).toBe(true)
    expect(
      museMspWireLogDebugEnabled({ TASKWRAITH_MUSE_MSP_DEBUG: 'YES' } as NodeJS.ProcessEnv)
    ).toBe(true)
    expect(
      museMspWireLogDebugEnabled({ TASKWRAITH_MUSE_MSP_DEBUG: '0' } as NodeJS.ProcessEnv)
    ).toBe(false)
    expect(
      museMspWireLogDebugEnabled({ TASKWRAITH_MUSE_MSP_DEBUG: 'enabled' } as NodeJS.ProcessEnv)
    ).toBe(false)
    expect(museMspWireLogDebugEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('runs every serialized line through redact, metadata included', () => {
    const dir = makeDir()
    const sink = createMuseMspWireLog({
      dir,
      runId: 'run-4',
      verbose: true,
      redact: (text) => text.replaceAll('sk-secret', 'sk-REDACTED')
    })
    sink.onRawFrame('in', { method: 'x', params: { token: 'sk-secret' } })
    sink.observe({ type: 'unparsable', line: 'sk-secret' })
    sink.close()
    const raw = readFileSync(join(dir, 'run-4.jsonl'), 'utf8')
    expect(raw).not.toContain('sk-secret')
    expect(raw).toContain('sk-REDACTED')
  })

  it('caps the verbose frame stream while metadata events stay exempt', () => {
    const dir = makeDir()
    const sink = createMuseMspWireLog({ dir, runId: 'run-5', verbose: true, maxBytes: 0 })
    for (let i = 0; i < 5; i++) {
      sink.onRawFrame('in', { method: 'item/delta', delta: 'x'.repeat(100), i })
    }
    sink.observe({ type: 'unknownMethod', method: 'm' })
    sink.close()
    expect(readEvents(dir, 'run-5').map((event) => event.event)).toEqual([
      'open',
      'observation',
      'close'
    ])
  })

  it('never throws when the directory cannot be created', () => {
    const dir = makeDir()
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'occupied')
    const sink = createMuseMspWireLog({ dir: blocker, runId: 'run-6' })
    expect(() => {
      sink.onRawFrame('in', { method: 'x' })
      sink.observe({ type: 'tripwire', message: 'm' })
      sink.close()
    }).not.toThrow()
  })

  it('close is idempotent and drops anything queued after it', () => {
    const dir = makeDir()
    const sink = createMuseMspWireLog({ dir, runId: 'run-7' })
    sink.close()
    sink.close()
    sink.observe({ type: 'tripwire', message: 'late' })
    expect(readEvents(dir, 'run-7').map((event) => event.event)).toEqual(['open', 'close'])
  })
})

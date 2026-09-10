import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { childTerminationRecord } = require('./runT2Baseline.cjs')
const src = readFileSync(new URL('./runT2Baseline.cjs', import.meta.url), 'utf8')

describe('T2 capture hang guards (source pins)', () => {
  it('bounds in-flight heap_snapshot with the remaining capture budget', () => {
    expect(src).toContain('function remainingCaptureBudgetMs()')
    expect(src).toContain('timeoutMs: remainingCaptureBudgetMs()')
    expect(src).toContain('awaitWithTimeout(')
    expect(src).toContain('capture:profiles_stop.renderer')
  })

  it('runs SIGTERM/SIGINT through the same terminateExactChild path', () => {
    expect(src).toContain("process.once('SIGINT', stopLaunch)")
    expect(src).toContain("process.once('SIGTERM', stopLaunch)")
    expect(src).toContain('signal: launchAbort.signal')
    expect(src).toContain('options.signal.addEventListener')
    expect(src).toContain('userDataPath: userDataResolved.userDataPath')
  })

  it('does not skip heap_snapshot under --lean', () => {
    expect(src).toContain('collectRendererHeapSnapshot(renderer')
    expect(src).not.toMatch(/args\.lean[\s\S]{0,80}heap_snapshot/)
    expect(src).not.toMatch(/heap_snapshot[\s\S]{0,80}args\.lean/)
  })

  it('passes the 120s × 3 sampling contract into the paired path', () => {
    expect(src).toContain('MATRIX_SAMPLING')
    expect(src).toContain('windowMs:')
    expect(src).toContain('MATRIX_SAMPLING.windowMs')
    expect(src).toContain('MATRIX_SAMPLING.repetitions')
    expect(src).toContain('aloneReplayWindows:')
  })
})

describe('stray reap audit record', () => {
  it('keeps the force and stray-kill facts that a clean-looking shutdown hides', () => {
    expect(
      childTerminationRecord({
        pid: 1,
        terminated: true,
        usedForce: true,
        killedProcessGroup: true,
        strayKills: [{ pid: 42, reason: 'listening on owned inspector port' }]
      })
    ).toEqual({
      usedForce: true,
      killedProcessGroup: true,
      strayKills: [{ pid: 42, reason: 'listening on owned inspector port' }]
    })
  })

  it('records no termination at all rather than an empty one, and invents no kills', () => {
    expect(childTerminationRecord(null)).toBeNull()
    expect(childTerminationRecord(undefined)).toBeNull()
    // A truthy non-record must not become a claim about force or kills.
    expect(childTerminationRecord({ usedForce: 'yes', strayKills: 'two' })).toEqual({
      usedForce: false,
      killedProcessGroup: false,
      strayKills: []
    })
  })

  it('carries the record into the report, the cleanup journal and the abort path', () => {
    expect(src).toContain('report.childTermination = childTermination')
    expect(src).toContain('{ childTermination }')
    expect(src).toContain('abortTermination: record')
  })
})

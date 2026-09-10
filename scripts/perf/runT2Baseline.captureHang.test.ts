import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { childTerminationRecord, abortExitCode } = require('./runT2Baseline.cjs')
const src = readFileSync(new URL('./runT2Baseline.cjs', import.meta.url), 'utf8')

describe('T2 capture hang guards (source pins)', () => {
  it('bounds in-flight heap_snapshot with the remaining capture budget', () => {
    expect(src).toContain('function remainingCaptureBudgetMs()')
    expect(src).toContain('timeoutMs: remainingCaptureBudgetMs()')
    expect(src).toContain('awaitWithTimeout(')
    expect(src).toContain('capture:profiles_stop.renderer')
  })

  it('runs SIGTERM/SIGINT through the same terminateExactChild path', () => {
    // The handler now carries which signal arrived, so it can exit with that
    // signal's code; both still route through the one stopLaunch path.
    expect(src).toContain("process.once('SIGINT', () => stopLaunch('SIGINT'))")
    expect(src).toContain("process.once('SIGTERM', () => stopLaunch('SIGTERM'))")
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

describe('abort lane (source pins — the launch harness lives in perfHarness.test.ts)', () => {
  it('makes the abort sticky so a pre-spawn signal still refuses the launch', () => {
    expect(src).toContain('let launchAborted = false')
    expect(src).toContain('launchAborted = true')
    expect(src).toContain("throw new Error('Refusing --launch: aborted before spawn")
    // The guard has to precede the spawn, not merely exist.
    expect(src.indexOf('Refusing --launch: aborted before spawn')).toBeLessThan(
      src.indexOf('childSession = spawnExactElectronChild(')
    )
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

describe('aborted runs leave honestly', () => {
  it("never yields 0, and carries the signal's own conventional code", () => {
    expect(abortExitCode('SIGTERM')).toBe(143)
    expect(abortExitCode('SIGINT')).toBe(130)
    // Anything else is still an abort, so it is still not a success.
    expect(abortExitCode(null)).toBe(143)
    expect(abortExitCode('SIGHUP')).toBe(143)
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', null]) {
      expect(abortExitCode(name)).not.toBe(0)
    }
  })

  it('wires that code through the handler and both promise lanes', () => {
    expect(src).toContain('process.exitCode = abortExitCode(signalName)')
    expect(src).toContain('process.exit(abortExitCode(signalName))')
    // The success lane must refuse to print ok:true after an abort...
    expect(src).toContain('process.exit(abortExitCode(abortedBy))')
    // ...and the failure lane must not downgrade the signal to a plain 1.
    expect(src).toContain('process.exit(abortedBy ? abortExitCode(abortedBy) : 1)')
  })

  it('terminalises the progress record the moment the abort arrives', () => {
    expect(src).toContain("updateProgress({ status: 'aborted' }, { log: false })")
    // Attempt 4 left `running` in the journal for 18 minutes after its SIGTERM.
    expect(src.indexOf("status: 'aborted'")).toBeLessThan(
      src.indexOf('const session = childSession')
    )
  })
})

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const {
  compareM5FlagPair,
  ZERO_COUNTERS,
  COUNTED_COUNTERS,
  LISTED_OWNERS
} = require('./m5FlagPair.cjs')
const { resolveRolloutFlags } = require('./rolloutFlags.cjs')
const flag = 'TASKWRAITH_JOURNAL_FLUSHER'
function fixture() {
  return Array.from({ length: 6 }, (_, index) => ({
    i7: { complete: true, runtimeFlagInventoryMatched: true },
    gates: { gCorrect: true, gCap: true },
    startedAtMs: index * 130000,
    endedAtMs: index * 130000 + 120000,
    state: index % 2 ? 'on' : 'off',
    repetition: Math.floor(index / 2),
    identity: {
      gitSha: 'a'.repeat(40),
      buildId: 'build',
      buildOutputSha256: 'e'.repeat(64),
      fixtureFingerprint: 'b'.repeat(64),
      seed: 42,
      workload: 'light_beside_large_live',
      cell: 'large/2/warm/ollama_same_model_repeated/none',
      windowMs: 120000,
      provenance: {
        sourceSha256: 'f'.repeat(64),
        dirtyTreeFingerprint: '0'.repeat(64),
        authoritativeBaseline: true,
        dirty: false,
        isolatedWorktree: true,
        gitSha: 'a'.repeat(40)
      }
    },
    rolloutFlags: resolveRolloutFlags({ declared: index % 2 ? [flag] : [] }).record,
    window: {
      id: `window-${index}`,
      startedAtMs: index * 130000,
      endedAtMs: index * 130000 + 120000,
      role: 'light-beside',
      repetition: Math.floor(index / 2),
      durationMs: 120000,
      censored: false,
      evidence: {
        x1: {
          expectedEndAtMs: index * 130000 + 120000,
          id: `window-${index}`,
          status: 'complete',
          p95Ms: 10,
          startedAtMs: index * 130000,
          endedAtMs: index * 130000 + 120000
        },
        x1b: {
          clockId: 'main-measured-monotonic',
          gaps: [{ startedAtMs: index * 130000 + 1, endedAtMs: index * 130000 + 2001 }],
          complete: true,
          blockedMs: 2000,
          appSuspensionPrevented: true,
          definition: 'expected_timer_gap_at_least_25ms'
        },
        x2: {
          attributionEligible: true,
          censored: false,
          clockId: 'main-measured-monotonic',
          ownerAbsenceProven: index % 2 === 1,
          profileSha256: 'c'.repeat(64),
          gapArtifactSha256: 'd'.repeat(64),
          windowId: `window-${index}`,
          startedAtMs: index * 130000,
          endedAtMs: index * 130000 + 120000,
          gapCoverage: [
            {
              startedAtMs: index * 130000 + 1,
              endedAtMs: index * 130000 + 2001,
              complete: true,
              frames:
                index % 2
                  ? [
                      {
                        startedAtMs: index * 130000 + 1,
                        endedAtMs: index * 130000 + 2001,
                        owner: 'mutation-derivation',
                        classification: 'residual'
                      }
                    ]
                  : [
                      {
                        startedAtMs: index * 130000 + 1,
                        endedAtMs: index * 130000 + 1001,
                        owner: 's6_materialize',
                        classification: 'listed'
                      },
                      {
                        startedAtMs: index * 130000 + 1001,
                        endedAtMs: index * 130000 + 2001,
                        owner: 'mutation-derivation',
                        classification: 'residual'
                      }
                    ]
            }
          ],
          owners: [...LISTED_OWNERS],
          complete: true,
          gapAttributed: true,
          overflow: 0,
          listedOwnerMs: index % 2 ? 0 : 1000,
          listedOwnerMsBounds: { lower: index % 2 ? 0 : 1000, upper: index % 2 ? 0 : 1000 },
          nonExemptOwnerGaps: []
        },
        x3: {
          complete: true,
          counters: Object.fromEntries(
            [...ZERO_COUNTERS, ...COUNTED_COUNTERS].map((key: string) => [key, 0])
          )
        }
      }
    }
  }))
}
const check = (captures: any[]) => compareM5FlagPair({ captures, changedFlags: [flag] })
describe('M5 X6 evidence comparator', () => {
  it('uses ON upper/OFF lower and never applies the floor to straddling bounds', () => {
    const captures = fixture()
    for (const capture of captures) {
      capture.window.evidence.x2.listedOwnerMsBounds =
        capture.state === 'off' ? { lower: 50, upper: 150 } : { lower: 5, upper: 11 }
    }
    expect(check(captures).reasons).toContain('80% conservative owner reduction not achieved')
    for (const capture of captures.filter((row) => row.state === 'on'))
      capture.window.evidence.x2.listedOwnerMsBounds = { lower: 0, upper: 10 }
    expect(check(captures).ok).toBe(true)
    for (const capture of captures.filter((row) => row.state === 'off'))
      capture.window.evidence.x2.listedOwnerMsBounds = { lower: 0, upper: 99 }
    expect(check(captures).ok).toBe(true)
  })
  it.each([false, undefined, null, 'true', 1])(
    'refuses non-true attribution eligibility: %s',
    (value) => {
      const captures: any[] = fixture()
      captures[1].window.evidence.x2.attributionEligible = value
      expect(check(captures).reasons).toContain(
        'X2 attribution explicitly eligible and uncensored required'
      )
    }
  )
  it.each([true, undefined, null, 'false', 0])(
    'refuses non-false attribution censoring: %s',
    (value) => {
      const captures: any[] = fixture()
      captures[1].window.evidence.x2.censored = value
      expect(check(captures).reasons).toContain(
        'X2 attribution explicitly eligible and uncensored required'
      )
    }
  )
  it('refuses a null gap followed by another gap without throwing', () => {
    const captures: any[] = fixture()
    captures[1].window.evidence.x1b.gaps = [null, { startedAtMs: 130100, endedAtMs: 130200 }]
    captures[1].window.evidence.x2.gapCoverage = [
      null,
      { startedAtMs: 130100, endedAtMs: 130200, complete: true, frames: [] }
    ]
    expect(() => check(captures)).not.toThrow()
    expect(check(captures).ok).toBe(false)
  })
  it('counts overrun blocking against the nominal denominator without truncation', () => {
    const captures = fixture()
    captures[1].endedAtMs += 50
    captures[1].window.endedAtMs += 50
    captures[1].window.evidence.x1.endedAtMs += 50
    captures[1].window.evidence.x2.endedAtMs += 50
    expect(check(captures).ok).toBe(true)
  })
  it('refuses missing qualification, malformed captures and false gap coverage', () => {
    expect(check([null, ...fixture().slice(1)]).ok).toBe(false)
    for (const mutate of [
      (c: any) => {
        delete c.gates
      },
      (c: any) => {
        c.gates.gCorrect = false
      },
      (c: any) => {
        c.identity.provenance.authoritativeBaseline = false
      },
      (c: any) => {
        c.endedAtMs++
      },
      (c: any) => {
        c.window.startedAtMs++
      },
      (c: any) => {
        c.window.evidence.x2.gapCoverage = []
      },
      (c: any) => {
        c.window.evidence.x2.gapCoverage[0].complete = false
      },
      (c: any) => {
        c.window.evidence.x2.windowId = 'wrong'
      },
      (c: any) => {
        c.identity.cell = 'invented'
      }
    ]) {
      const captures = fixture()
      mutate(captures[1])
      expect(check(captures).ok).toBe(false)
    }
  })
  it('checks 2% cap and owner medians', () => {
    expect(check(fixture()).ok).toBe(true)
    const captures = fixture()
    captures[1].window.evidence.x1b.blockedMs = 2401
    expect(check(captures).reasons).toContain('2% blocked-time cap exceeded or missing')
  })
  it.each(['x1', 'x1b', 'x2', 'x3'])('does not turn absent %s into zero', (key) => {
    const captures: any[] = fixture()
    delete captures[1].window.evidence[key]
    expect(check(captures).ok).toBe(false)
  })
  it('refuses wrong build, noninterleaving, censored windows and overflow', () => {
    for (const mutation of [
      (c: any[]) => {
        c[1].identity.gitSha = 'c'.repeat(40)
      },
      (c: any[]) => {
        c[1].state = 'off'
      },
      (c: any[]) => {
        c[1].window.censored = true
      },
      (c: any[]) => {
        c[1].window.evidence.x2.overflow = 1
      },
      (c: any[]) => {
        c[1].window.evidence.x1.id = 'wrong'
      },
      (c: any[]) => {
        c[1].rolloutFlags = resolveRolloutFlags().record
      }
    ]) {
      const captures = fixture()
      mutation(captures)
      expect(check(captures).ok).toBe(false)
    }
  })
  it('applies the 100ms floor without exempting absolute blocking or zero counters', () => {
    const captures = fixture()
    captures.forEach((c) => {
      if (c.state === 'off') {
        c.window.evidence.x2.listedOwnerMs = 90
        c.window.evidence.x2.listedOwnerMsBounds = { lower: 90, upper: 90 }
        const frames = c.window.evidence.x2.gapCoverage[0].frames
        frames[0].endedAtMs = frames[0].startedAtMs + 90
        frames[1].startedAtMs = frames[0].endedAtMs
      }
    })
    expect(check(captures).ok).toBe(true)
    captures[1].window.evidence.x3.counters.hardBoundFsyncs = 1
    expect(check(captures).ok).toBe(false)
  })
  it('counts residual counters but rejects nonexempt owners in gaps', () => {
    const captures = fixture()
    captures[1].window.evidence.x3.counters.shadowReconcileParses = 10
    expect(check(captures).ok).toBe(true)
    ;(captures[1].window.evidence.x2.nonExemptOwnerGaps as unknown[]).push({ owner: 'tool-detail' })
    expect(check(captures).ok).toBe(false)
  })
})

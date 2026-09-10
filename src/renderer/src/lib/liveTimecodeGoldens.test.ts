import { describe, expect, it } from 'vitest'

import {
  formatRunTimecodeDuration,
  getComposerTimecodePresentation
} from '../components/ComposerTimecodes'
import { formatParticipantWorkingElapsed } from './participantWorkingTelemetryModel'

/**
 * FROZEN FORMATTER GOLDENS — scope is narrow, read this before trusting it.
 *
 * The blob was captured by executing the pre-DOM-direct-ticker implementation,
 * so it is evidence of what these functions returned BEFORE that change rather
 * than a restatement of what they do now, and regenerating it from current code
 * would make the test tautological. Do not regenerate it to silence a failure.
 *
 * BUT it covers only the three PURE functions below. The tick-delivery refactor
 * did not touch them, so this file could not have failed from it and must not
 * be cited as that refactor's equivalence proof: it would stay green if a
 * component rendered an empty div, painted the wrong node, or lost its
 * declarative first paint. The component-level equivalence check is
 * `components/liveTimecodeSsrGoldens.test.tsx`, which freezes real
 * renderToStaticMarkup output including live `running={true}` cases.
 *
 * What this file is still good for: pinning the label vocabulary itself —
 * zero-padding, the DD:HH:MM:SS shape, negative and overflow inputs, and the
 * running/not-running and unparseable-date branches.
 */
const GOLDEN = `
fmt(0) = 00:00:00:00
fmt(1) = 00:00:00:00
fmt(999) = 00:00:00:00
fmt(1000) = 00:00:00:01
fmt(1500) = 00:00:00:01
fmt(59000) = 00:00:00:59
fmt(60000) = 00:00:01:00
fmt(61000) = 00:00:01:01
fmt(3599000) = 00:00:59:59
fmt(3600000) = 00:01:00:00
fmt(3661000) = 00:01:01:01
fmt(86399000) = 00:23:59:59
fmt(86400000) = 01:00:00:00
fmt(90061000) = 01:01:01:01
fmt(8640000000) = 100:00:00:00
fmt(-1) = 00:00:00:00
fmt(-5000) = 00:00:00:00
pres(r=true,s=null,b=0,off=0) = turn=00:00:00:00 total=00:00:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=0,off=1500) = turn=00:00:00:00 total=00:00:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=0,off=61000) = turn=00:00:00:00 total=00:00:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=5000,off=0) = turn=00:00:00:00 total=00:00:00:05 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=5000,off=1500) = turn=00:00:00:00 total=00:00:00:05 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=5000,off=61000) = turn=00:00:00:00 total=00:00:00:05 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=3600000,off=0) = turn=00:00:00:00 total=00:01:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=3600000,off=1500) = turn=00:00:00:00 total=00:01:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=null,b=3600000,off=61000) = turn=00:00:00:00 total=00:01:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=2026-09-10T00:00:00.000Z,b=0,off=0) = turn=00:00:00:00 total=00:00:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=2026-09-10T00:00:00.000Z,b=0,off=1500) = turn=00:00:00:01 total=00:00:00:01 mode=turn vis=00:00:00:01
pres(r=true,s=2026-09-10T00:00:00.000Z,b=0,off=61000) = turn=00:00:01:01 total=00:00:01:01 mode=turn vis=00:00:01:01
pres(r=true,s=2026-09-10T00:00:00.000Z,b=5000,off=0) = turn=00:00:00:00 total=00:00:00:05 mode=turn vis=00:00:00:00
pres(r=true,s=2026-09-10T00:00:00.000Z,b=5000,off=1500) = turn=00:00:00:01 total=00:00:00:06 mode=turn vis=00:00:00:01
pres(r=true,s=2026-09-10T00:00:00.000Z,b=5000,off=61000) = turn=00:00:01:01 total=00:00:01:06 mode=turn vis=00:00:01:01
pres(r=true,s=2026-09-10T00:00:00.000Z,b=3600000,off=0) = turn=00:00:00:00 total=00:01:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=2026-09-10T00:00:00.000Z,b=3600000,off=1500) = turn=00:00:00:01 total=00:01:00:01 mode=turn vis=00:00:00:01
pres(r=true,s=2026-09-10T00:00:00.000Z,b=3600000,off=61000) = turn=00:00:01:01 total=00:01:01:01 mode=turn vis=00:00:01:01
pres(r=true,s=not-a-date,b=0,off=0) = turn=00:00:00:00 total=00:00:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=0,off=1500) = turn=00:00:00:00 total=00:00:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=0,off=61000) = turn=00:00:00:00 total=00:00:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=5000,off=0) = turn=00:00:00:00 total=00:00:00:05 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=5000,off=1500) = turn=00:00:00:00 total=00:00:00:05 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=5000,off=61000) = turn=00:00:00:00 total=00:00:00:05 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=3600000,off=0) = turn=00:00:00:00 total=00:01:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=3600000,off=1500) = turn=00:00:00:00 total=00:01:00:00 mode=turn vis=00:00:00:00
pres(r=true,s=not-a-date,b=3600000,off=61000) = turn=00:00:00:00 total=00:01:00:00 mode=turn vis=00:00:00:00
pres(r=false,s=null,b=0,off=0) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=null,b=0,off=1500) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=null,b=0,off=61000) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=null,b=5000,off=0) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=null,b=5000,off=1500) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=null,b=5000,off=61000) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=null,b=3600000,off=0) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=null,b=3600000,off=1500) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=null,b=3600000,off=61000) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=2026-09-10T00:00:00.000Z,b=0,off=0) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=2026-09-10T00:00:00.000Z,b=0,off=1500) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=2026-09-10T00:00:00.000Z,b=0,off=61000) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=2026-09-10T00:00:00.000Z,b=5000,off=0) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=2026-09-10T00:00:00.000Z,b=5000,off=1500) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=2026-09-10T00:00:00.000Z,b=5000,off=61000) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=2026-09-10T00:00:00.000Z,b=3600000,off=0) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=2026-09-10T00:00:00.000Z,b=3600000,off=1500) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=2026-09-10T00:00:00.000Z,b=3600000,off=61000) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=not-a-date,b=0,off=0) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=not-a-date,b=0,off=1500) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=not-a-date,b=0,off=61000) = turn=00:00:00:00 total=00:00:00:00 mode=total vis=00:00:00:00
pres(r=false,s=not-a-date,b=5000,off=0) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=not-a-date,b=5000,off=1500) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=not-a-date,b=5000,off=61000) = turn=00:00:00:00 total=00:00:00:05 mode=total vis=00:00:00:05
pres(r=false,s=not-a-date,b=3600000,off=0) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=not-a-date,b=3600000,off=1500) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
pres(r=false,s=not-a-date,b=3600000,off=61000) = turn=00:00:00:00 total=00:01:00:00 mode=total vis=00:01:00:00
elapsed(null,+0) = 0s
elapsed(null,+1) = 0s
elapsed(null,+999) = 0s
elapsed(null,+1000) = 0s
elapsed(null,+5000) = 0s
elapsed(null,+59000) = 0s
elapsed(null,+60000) = 0s
elapsed(null,+3600000) = 0s
elapsed(null,+86400000) = 0s
elapsed(2026-09-10T00:00:00.000Z,+0) = 0s
elapsed(2026-09-10T00:00:00.000Z,+1) = 0s
elapsed(2026-09-10T00:00:00.000Z,+999) = 0s
elapsed(2026-09-10T00:00:00.000Z,+1000) = 1s
elapsed(2026-09-10T00:00:00.000Z,+5000) = 5s
elapsed(2026-09-10T00:00:00.000Z,+59000) = 59s
elapsed(2026-09-10T00:00:00.000Z,+60000) = 1m 0s
elapsed(2026-09-10T00:00:00.000Z,+3600000) = 1h 0m 0s
elapsed(2026-09-10T00:00:00.000Z,+86400000) = 1d 0h 0m
elapsed(bad,+0) = 0s
elapsed(bad,+1) = 0s
elapsed(bad,+999) = 0s
elapsed(bad,+1000) = 0s
elapsed(bad,+5000) = 0s
elapsed(bad,+59000) = 0s
elapsed(bad,+60000) = 0s
elapsed(bad,+3600000) = 0s
elapsed(bad,+86400000) = 0s
`.trim()

const BASE = Date.parse('2026-09-10T00:00:00.000Z')
const DURATIONS = [
  0, 1, 999, 1000, 1500, 59_000, 60_000, 61_000, 3_599_000, 3_600_000, 3_661_000, 86_399_000,
  86_400_000, 90_061_000, 8_640_000_000, -1, -5000
]
const ELAPSED_OFFSETS = [0, 1, 999, 1000, 5000, 59_000, 60_000, 3_600_000, 86_400_000]

function renderMatrix(): string {
  const out: string[] = []
  for (const ms of DURATIONS) out.push(`fmt(${ms}) = ${formatRunTimecodeDuration(ms)}`)
  for (const running of [true, false]) {
    for (const startedAt of [null, '2026-09-10T00:00:00.000Z', 'not-a-date']) {
      for (const base of [0, 5000, 3_600_000]) {
        for (const offset of [0, 1500, 61_000]) {
          const p = getComposerTimecodePresentation({
            running,
            startedAt,
            cumulativeBaseMs: base,
            nowMs: BASE + offset
          })
          out.push(
            `pres(r=${running},s=${startedAt},b=${base},off=${offset}) = turn=${p.turnLabel} total=${p.totalLabel} mode=${p.visibleMode} vis=${p.visibleLabel}`
          )
        }
      }
    }
  }
  for (const startedAt of [null, '2026-09-10T00:00:00.000Z', 'bad']) {
    for (const offset of ELAPSED_OFFSETS) {
      out.push(
        `elapsed(${startedAt},+${offset}) = ${formatParticipantWorkingElapsed(startedAt, BASE + offset)}`
      )
    }
  }
  return out.join('\n')
}

describe('live timecode rendering goldens', () => {
  it('renders every label exactly as it did before the tick refactor', () => {
    expect(renderMatrix()).toBe(GOLDEN)
  })

  it('covers a non-trivial matrix (guards against a vacuously empty golden)', () => {
    expect(GOLDEN.split('\n')).toHaveLength(98)
    expect(GOLDEN).toContain('turn=00:00:01:01')
  })
})

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { ComposerThreadTimecodeBar } from './ComposerTimecodes'
import { MemoizedParticipantWorkingTelemetry } from './ParticipantWorkingTelemetry'

/**
 * FROZEN SSR MARKUP, CAPTURED FROM THE PRE-DOM-DIRECT-TICKER IMPLEMENTATION.
 *
 * This is the equivalence proof for moving per-second updates out of React.
 * Unlike `lib/liveTimecodeGoldens.test.ts`, which exercises only the pure
 * formatters and therefore could not fail from a component refactor at all,
 * this blob is the real rendered output of ComposerThreadTimecodeBar and the
 * working chip — including `running={true}` cases carrying a genuine elapsed
 * value rather than a degenerate zero.
 *
 * It was produced by running this exact matrix against a pristine HEAD
 * worktree and remains the unchanged pre-refactor reference. The explicitly
 * accepted round-anchor lifecycle differences are applied below; all other
 * markup must remain byte-identical. It fails if the
 * first paint ever stops being declarative (the ticker cannot run under
 * renderToStaticMarkup — refs never attach and effects never fire), if a value
 * or an aria-label goes missing, or if the DOM shape shifts.
 *
 * DO NOT REGENERATE THIS BLOB TO SILENCE A FAILURE. Regenerating it from
 * current code turns the only component-level equivalence check in this repo
 * into a tautology.
 */
const SSR_GOLDEN = `
BAR {"running":true,"startedAt":"2026-09-10T11:58:13.000Z","cumulativeBaseMs":0}
<div class="composer-thread-timecodes" data-running="true"><span class="composer-thread-timecode composer-thread-timecode--turn" title="Current turn / round elapsed time" aria-label="Current turn elapsed time 00:00:01:47"><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span><span class="composer-thread-timecode-label">Turn</span><span class="composer-thread-timecode-value">00:00:01:47</span></span><div class="composer-thread-timecodes-center"></div><span class="composer-thread-timecode composer-thread-timecode--total" title="Total thread wall time" aria-label="Total thread wall time 00:00:01:47"><span class="composer-thread-timecode-label">Total thread</span><span class="composer-thread-timecode-value">00:00:01:47</span><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span></span></div>

BAR {"running":true,"startedAt":"2026-09-10T11:00:00.000Z","cumulativeBaseMs":3600000}
<div class="composer-thread-timecodes" data-running="true"><span class="composer-thread-timecode composer-thread-timecode--turn" title="Current turn / round elapsed time" aria-label="Current turn elapsed time 00:01:00:00"><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span><span class="composer-thread-timecode-label">Turn</span><span class="composer-thread-timecode-value">00:01:00:00</span></span><div class="composer-thread-timecodes-center"></div><span class="composer-thread-timecode composer-thread-timecode--total" title="Total thread wall time" aria-label="Total thread wall time 00:02:00:00"><span class="composer-thread-timecode-label">Total thread</span><span class="composer-thread-timecode-value">00:02:00:00</span><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span></span></div>

BAR {"running":true,"startedAt":null,"cumulativeBaseMs":5000}
<div class="composer-thread-timecodes" data-running="true"><span class="composer-thread-timecode composer-thread-timecode--turn" title="Current turn / round elapsed time" aria-label="Current turn elapsed time 00:00:00:00"><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span><span class="composer-thread-timecode-label">Turn</span><span class="composer-thread-timecode-value">00:00:00:00</span></span><div class="composer-thread-timecodes-center"></div><span class="composer-thread-timecode composer-thread-timecode--total" title="Total thread wall time" aria-label="Total thread wall time 00:00:00:05"><span class="composer-thread-timecode-label">Total thread</span><span class="composer-thread-timecode-value">00:00:00:05</span><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span></span></div>

BAR {"running":true,"startedAt":"not-a-date","cumulativeBaseMs":0}
<div class="composer-thread-timecodes" data-running="true"><span class="composer-thread-timecode composer-thread-timecode--turn" title="Current turn / round elapsed time" aria-label="Current turn elapsed time 00:00:00:00"><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span><span class="composer-thread-timecode-label">Turn</span><span class="composer-thread-timecode-value">00:00:00:00</span></span><div class="composer-thread-timecodes-center"></div><span class="composer-thread-timecode composer-thread-timecode--total" title="Total thread wall time" aria-label="Total thread wall time 00:00:00:00"><span class="composer-thread-timecode-label">Total thread</span><span class="composer-thread-timecode-value">00:00:00:00</span><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span></span></div>

BAR {"running":false,"startedAt":null,"cumulativeBaseMs":0}
<div class="composer-thread-timecodes" data-running="false"><span class="composer-thread-timecode composer-thread-timecode--turn" title="Current turn / round elapsed time" aria-label="Current turn elapsed time 00:00:00:00"><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span><span class="composer-thread-timecode-label">Turn</span><span class="composer-thread-timecode-value">00:00:00:00</span></span><div class="composer-thread-timecodes-center"></div><span class="composer-thread-timecode composer-thread-timecode--total" title="Total thread wall time" aria-label="Total thread wall time 00:00:00:00"><span class="composer-thread-timecode-label">Total thread</span><span class="composer-thread-timecode-value">00:00:00:00</span><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span></span></div>

BAR {"running":false,"startedAt":"2026-09-10T11:58:13.000Z","cumulativeBaseMs":90061000}
<div class="composer-thread-timecodes" data-running="false"><span class="composer-thread-timecode composer-thread-timecode--turn" title="Current turn / round elapsed time" aria-label="Current turn elapsed time 00:00:00:00"><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span><span class="composer-thread-timecode-label">Turn</span><span class="composer-thread-timecode-value">00:00:00:00</span></span><div class="composer-thread-timecodes-center"></div><span class="composer-thread-timecode composer-thread-timecode--total" title="Total thread wall time" aria-label="Total thread wall time 01:01:01:01"><span class="composer-thread-timecode-label">Total thread</span><span class="composer-thread-timecode-value">01:01:01:01</span><span class="sf-symbol-icon composer-control-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg></span></span></div>

CHIP {"startedAt":"2026-09-10T11:58:13.000Z","avail":true,"state":"available"}
<span class="message-working-telemetry" title="1m 47s elapsed · 285,100 current-context tokens (latest persisted context snapshot)" aria-hidden="true"><span class="message-working-elapsed">1m 47s</span><span class="message-working-telemetry-separator">·</span><span class="message-working-token-count"><span class="digit-odometer"><span class="sr-only">285.1k tokens</span><span class="digit-odometer__visual" aria-hidden="true"><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:54ms"><span class="digit-odometer__cell">2</span></span></span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:36ms"><span class="digit-odometer__cell">8</span></span></span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:18ms"><span class="digit-odometer__cell">5</span></span></span><span class="digit-odometer__decimal">.</span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:0ms"><span class="digit-odometer__cell">1</span></span></span></span></span><span class="message-working-token-suffix">k tokens</span></span></span>

CHIP {"startedAt":null,"avail":false,"state":"unavailable"}
<span class="message-working-telemetry" title="0s elapsed · 285,100 current-context tokens (latest persisted context snapshot)" aria-hidden="true"><span class="message-working-elapsed">0s</span><span class="message-working-telemetry-separator">·</span><span class="message-working-token-count"><span class="digit-odometer"><span class="sr-only">285.1k tokens</span><span class="digit-odometer__visual" aria-hidden="true"><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:54ms"><span class="digit-odometer__cell">2</span></span></span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:36ms"><span class="digit-odometer__cell">8</span></span></span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:18ms"><span class="digit-odometer__cell">5</span></span></span><span class="digit-odometer__decimal">.</span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:0ms"><span class="digit-odometer__cell">1</span></span></span></span></span><span class="message-working-token-suffix">k tokens</span></span></span>

CHIP {"startedAt":"bogus","avail":true,"state":"available"}
<span class="message-working-telemetry" title="0s elapsed · 285,100 current-context tokens (latest persisted context snapshot)" aria-hidden="true"><span class="message-working-elapsed">0s</span><span class="message-working-telemetry-separator">·</span><span class="message-working-token-count"><span class="digit-odometer"><span class="sr-only">285.1k tokens</span><span class="digit-odometer__visual" aria-hidden="true"><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:54ms"><span class="digit-odometer__cell">2</span></span></span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:36ms"><span class="digit-odometer__cell">8</span></span></span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:18ms"><span class="digit-odometer__cell">5</span></span></span><span class="digit-odometer__decimal">.</span><span class="digit-odometer__slot"><span class="digit-odometer__column" style="--digit-odometer-start:-0em;--digit-odometer-target:-0em;--digit-odometer-delay:0ms"><span class="digit-odometer__cell">1</span></span></span></span></span><span class="message-working-token-suffix">k tokens</span></span></span>

CHIP {"startedAt":"2026-09-10T10:00:00.000Z","avail":false,"state":"post-compaction-unknown"}
<span class="message-working-telemetry" title="2h 0m 0s elapsed · post-compaction context unavailable; waiting for the next provider snapshot" aria-hidden="true"><span class="message-working-elapsed">2h 0m 0s</span><span class="message-working-telemetry-separator">·</span><span class="message-working-token-count"><span class="message-working-token-unavailable">— tokens</span></span></span>
`.trim()

const FIXED = Date.parse('2026-09-10T12:00:00.000Z')

const BAR_CASES = [
  { running: true, startedAt: '2026-09-10T11:58:13.000Z', cumulativeBaseMs: 0 },
  { running: true, startedAt: '2026-09-10T11:00:00.000Z', cumulativeBaseMs: 3_600_000 },
  { running: true, startedAt: null, cumulativeBaseMs: 5000 },
  { running: true, startedAt: 'not-a-date', cumulativeBaseMs: 0 },
  { running: false, startedAt: null, cumulativeBaseMs: 0 },
  { running: false, startedAt: '2026-09-10T11:58:13.000Z', cumulativeBaseMs: 90_061_000 }
]

/**
 * b6e06e619 implements the user's round-clock contract: a valid round anchor
 * keeps ticking through a handoff even if the generic run flag drops; clearing
 * that anchor stops the clock even if the flag lags. Keep the historical blob
 * intact and spell out only those three accepted differences, independently
 * of the component/formatter under test. The handoff adds 107 seconds to the
 * captured 90,061-second cumulative base: 90,168 seconds = 01:01:02:48.
 */
function expectedRoundAnchorMatrix(): string {
  return SSR_GOLDEN.split('\n\n')
    .map((block) => {
      const header = block.split('\n', 1)[0]
      if (
        header === `BAR ${JSON.stringify(BAR_CASES[2])}` ||
        header === `BAR ${JSON.stringify(BAR_CASES[3])}`
      ) {
        expect(block).toContain('data-running="true"')
        return block.replace('data-running="true"', 'data-running="false"')
      }
      if (header === `BAR ${JSON.stringify(BAR_CASES[5])}`) {
        expect(block).toContain('data-running="false"')
        expect(block).toContain('00:00:00:00')
        expect(block).toContain('01:01:01:01')
        return block
          .replace('data-running="false"', 'data-running="true"')
          .replaceAll('00:00:00:00', '00:00:01:47')
          .replaceAll('01:01:01:01', '01:01:02:48')
      }
      return block
    })
    .join('\n\n')
}

const CHIP_CASES = [
  { startedAt: '2026-09-10T11:58:13.000Z', avail: true, state: 'available' as const },
  { startedAt: null, avail: false, state: 'unavailable' as const },
  { startedAt: 'bogus', avail: true, state: 'available' as const },
  {
    startedAt: '2026-09-10T10:00:00.000Z',
    avail: false,
    state: 'post-compaction-unknown' as const
  }
]

function renderMatrix(): string {
  const realNow = Date.now
  Date.now = () => FIXED
  const blocks: string[] = []
  try {
    for (const c of BAR_CASES) {
      blocks.push(
        `BAR ${JSON.stringify(c)}\n` +
          renderToStaticMarkup(
            <ComposerThreadTimecodeBar
              running={c.running}
              startedAt={c.startedAt}
              cumulativeBaseMs={c.cumulativeBaseMs}
            />
          )
      )
    }
    for (const c of CHIP_CASES) {
      blocks.push(
        `CHIP ${JSON.stringify(c)}\n` +
          renderToStaticMarkup(
            <MemoizedParticipantWorkingTelemetry
              runId="claude-run"
              startedAt={c.startedAt}
              provider="claude"
              tokenEpochKey="claude:gpt-5.5"
              tokenEpochObservedAt={null}
              contextBaselineTokens={285_100}
              contextBaselineAvailable={c.avail}
              contextState={c.state}
              fallbackTargetTokens={285_100}
              estimatedCurrentTurnTokens={0}
              estimatedToolResultTokens={0}
            />
          )
      )
    }
  } finally {
    Date.now = realNow
  }
  return blocks.join('\n\n')
}

describe('live timecode SSR goldens', () => {
  it('preserves the historical markup with the accepted round-anchor lifecycle', () => {
    expect(renderMatrix()).toBe(expectedRoundAnchorMatrix())
  })

  it('actually exercises a live turn (guards against a degenerate all-zero golden)', () => {
    // A running turn 1m47s in. If the matrix ever collapsed to running={false}
    // only, every label would read 00:00:00:00 and this golden would prove
    // nothing at all.
    expect(SSR_GOLDEN).toContain('00:00:01:47')
    expect(SSR_GOLDEN).toContain('aria-label="Current turn elapsed time 00:00:01:47"')
    expect(SSR_GOLDEN).toContain('message-working-elapsed')
    expect(SSR_GOLDEN.length).toBeGreaterThan(12_000)
  })
})

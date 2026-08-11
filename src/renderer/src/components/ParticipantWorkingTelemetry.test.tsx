import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoizedParticipantWorkingTelemetry } from './ParticipantWorkingTelemetry'
import {
  compactWorkingTokenOdometer,
  formatParticipantWorkingElapsed,
  unreportedWorkingTokenEstimate
} from '../lib/participantWorkingTelemetryModel'

describe('ParticipantWorkingTelemetry', () => {
  it('formats a Claude-style compact elapsed timer', () => {
    expect(
      formatParticipantWorkingElapsed(
        '2026-07-11T18:00:00.000Z',
        Date.parse('2026-07-11T18:27:55.000Z')
      )
    ).toBe('27m 55s')
    expect(
      formatParticipantWorkingElapsed(
        '2026-07-11T18:00:00.000Z',
        Date.parse('2026-07-11T20:01:02.000Z')
      )
    ).toBe('2h 1m 2s')
  })

  it('uses an odometer-friendly compact token representation', () => {
    expect(compactWorkingTokenOdometer(285_100)).toEqual({
      value: 2851,
      decimalPlaces: 1,
      suffix: 'k tokens',
      label: '285.1k tokens'
    })
  })

  it('adds only tool-result tokens observed after a provider snapshot', () => {
    expect(unreportedWorkingTokenEstimate(1_240, 1_000)).toBe(240)
    expect(unreportedWorkingTokenEstimate(900, 1_000)).toBe(0)
  })

  it('renders a visual-only per-turn telemetry readout through DigitOdometer', () => {
    const html = renderToStaticMarkup(
      <MemoizedParticipantWorkingTelemetry
        runId="claude-run"
        startedAt="2026-07-11T18:00:00.000Z"
        tokenAccumulatorBase={285_100}
        fallbackTargetTokens={285_100}
        estimatedCurrentTurnTokens={0}
        estimatedToolResultTokens={0}
      />
    )

    expect(html).toContain('message-working-telemetry')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('digit-odometer')
    expect(html).toContain('digit-odometer__decimal')
    expect(html).toContain('285.1k tokens')
  })

  it('renders unavailable instead of inventing a zero before telemetry arrives', () => {
    const html = renderToStaticMarkup(
      <MemoizedParticipantWorkingTelemetry
        runId="ollama-run"
        startedAt="2026-08-03T02:05:07.000Z"
        tokenAccumulatorBase={0}
        fallbackTargetTokens={0}
        estimatedCurrentTurnTokens={0}
        estimatedToolResultTokens={0}
      />
    )

    expect(html).toContain('current-run token usage unavailable')
    expect(html).toContain('message-working-token-unavailable')
    expect(html).toContain('— tokens')
    expect(html).not.toContain('digit-odometer')
  })
})

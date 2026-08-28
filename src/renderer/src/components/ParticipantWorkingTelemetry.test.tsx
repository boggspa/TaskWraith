import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoizedParticipantWorkingTelemetry } from './ParticipantWorkingTelemetry'
import {
  compactWorkingTokenOdometer,
  formatParticipantWorkingElapsed,
  reconcileWorkingTokenDisplayEpoch,
  unreportedWorkingTokenEstimate,
  workingSnapshotBelongsToTokenEpoch
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
        Date.parse('2026-07-11T19:23:45.000Z')
      )
    ).toBe('1h 23m 45s')
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

  it('accepts only provider context snapshots newer than the compaction epoch', () => {
    const epoch = 1_786_000_000_000
    expect(
      workingSnapshotBelongsToTokenEpoch(
        { provider: 'claude', contextUsage: { observedAt: epoch - 1 } },
        'claude',
        epoch
      )
    ).toBe(false)
    expect(
      workingSnapshotBelongsToTokenEpoch(
        { provider: 'claude', contextUsage: { observedAt: epoch } },
        'claude',
        epoch
      )
    ).toBe(false)
    expect(
      workingSnapshotBelongsToTokenEpoch(
        { provider: 'claude', contextUsage: { observedAt: epoch + 1 } },
        'claude',
        epoch
      )
    ).toBe(true)
    expect(workingSnapshotBelongsToTokenEpoch({ provider: 'codex' }, 'claude', epoch)).toBe(false)
  })

  it('resets the odometer downward only when the token epoch changes', () => {
    const current = { tokenEpochKey: 'claude:gpt-5.5', tokens: 1_001_208 }
    expect(reconcileWorkingTokenDisplayEpoch(current, current.tokenEpochKey, 8_486)).toBe(current)
    expect(
      reconcileWorkingTokenDisplayEpoch(current, 'claude:gpt-5.5:compaction:compact-1', 8_486)
    ).toEqual({
      tokenEpochKey: 'claude:gpt-5.5:compaction:compact-1',
      tokens: 8_486
    })
  })

  it('renders a visual-only per-turn telemetry readout through DigitOdometer', () => {
    const html = renderToStaticMarkup(
      <MemoizedParticipantWorkingTelemetry
        runId="claude-run"
        startedAt="2026-07-11T18:00:00.000Z"
        provider="claude"
        tokenEpochKey="claude:gpt-5.5"
        tokenEpochObservedAt={null}
        contextBaselineTokens={285_100}
        contextBaselineAvailable={true}
        contextState="available"
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
        provider="ollama"
        tokenEpochKey="ollama:unknown"
        tokenEpochObservedAt={null}
        contextBaselineTokens={0}
        contextBaselineAvailable={false}
        contextState="unavailable"
        fallbackTargetTokens={0}
        estimatedCurrentTurnTokens={0}
        estimatedToolResultTokens={0}
      />
    )

    expect(html).toContain('current-context token usage unavailable')
    expect(html).toContain('message-working-token-unavailable')
    expect(html).toContain('— tokens')
    expect(html).not.toContain('digit-odometer')
  })

  it('renders an exact post-compaction zero instead of treating it as missing', () => {
    const html = renderToStaticMarkup(
      <MemoizedParticipantWorkingTelemetry
        runId="claude-run"
        startedAt="2026-08-03T02:05:07.000Z"
        provider="claude"
        tokenEpochKey="claude:compaction:empty"
        tokenEpochObservedAt={1_786_000_000_000}
        contextBaselineTokens={0}
        contextBaselineAvailable={true}
        contextState="available"
        fallbackTargetTokens={0}
        estimatedCurrentTurnTokens={0}
        estimatedToolResultTokens={0}
      />
    )

    expect(html).toContain('0 tokens')
    expect(html).toContain('digit-odometer')
    expect(html).not.toContain('message-working-token-unavailable')
  })

  it('shows a truthful unavailable state when compaction omits post tokens', () => {
    const html = renderToStaticMarkup(
      <MemoizedParticipantWorkingTelemetry
        runId="antigravity-run"
        startedAt="2026-08-03T02:05:07.000Z"
        provider="antigravity"
        tokenEpochKey="antigravity:compaction:unknown"
        tokenEpochObservedAt={1_786_000_000_000}
        contextBaselineTokens={0}
        contextBaselineAvailable={false}
        contextState="post-compaction-unknown"
        fallbackTargetTokens={0}
        estimatedCurrentTurnTokens={0}
        estimatedToolResultTokens={0}
      />
    )

    expect(html).toContain('post-compaction context unavailable')
    expect(html).toContain('— tokens')
    expect(html).not.toContain('digit-odometer')
  })
})

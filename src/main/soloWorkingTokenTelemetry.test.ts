import { describe, expect, it } from 'vitest'
import {
  SoloWorkingTokenTelemetry,
  SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS
} from './soloWorkingTokenTelemetry'

const base = {
  runId: 'run-1',
  chatId: 'chat-1',
  provider: 'claude' as const,
  startedAtMs: Date.parse('2026-07-12T10:00:00.000Z')
}

describe('SoloWorkingTokenTelemetry.report', () => {
  it('emits a snapshot with normalized fields on first non-zero usage', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    const event = telemetry.report({
      ...base,
      stats: { input_tokens: 1200, output_tokens: 340, total_tokens: 1540 },
      nowMs: 0
    })
    expect(event).toEqual({
      type: 'snapshot',
      chatId: 'chat-1',
      roundId: '',
      participantId: '',
      runId: 'run-1',
      startedAt: '2026-07-12T10:00:00.000Z',
      provider: 'claude',
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      estimated: false
    })
  })

  it('returns null when there are no tokens yet', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    expect(telemetry.report({ ...base, stats: {}, nowMs: 0 })).toBeNull()
    expect(
      telemetry.report({ ...base, stats: { input_tokens: 0, output_tokens: 0 }, nowMs: 0 })
    ).toBeNull()
  })

  it('returns null without a run id or a usable stats object', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    expect(
      telemetry.report({ ...base, runId: undefined, stats: { output_tokens: 5 }, nowMs: 0 })
    ).toBeNull()
    expect(telemetry.report({ ...base, stats: null, nowMs: 0 })).toBeNull()
    expect(
      telemetry.report({ ...base, stats: [1, 2, 3] as unknown as Record<string, unknown>, nowMs: 0 })
    ).toBeNull()
  })

  it('throttles repeat emissions inside the min interval, then emits after it', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    expect(telemetry.report({ ...base, stats: { output_tokens: 100 }, nowMs: 0 })).not.toBeNull()
    // Changed value, but still inside the throttle window → suppressed.
    expect(
      telemetry.report({
        ...base,
        stats: { output_tokens: 150 },
        nowMs: SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS - 1
      })
    ).toBeNull()
    // Window elapsed → emits, carrying the latest (throttled) growth.
    const after = telemetry.report({
      ...base,
      stats: { output_tokens: 220 },
      nowMs: SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS
    })
    expect(after?.type === 'snapshot' && after.outputTokens).toBe(220)
  })

  it('is monotonic — a later smaller usage snapshot never lowers the counts', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    telemetry.report({ ...base, stats: { input_tokens: 900, output_tokens: 500 }, nowMs: 0 })
    // A provider re-report with a smaller output (e.g. a fresh sub-message) must
    // not walk the odometer backwards; it stays put and is therefore suppressed.
    const lower = telemetry.report({
      ...base,
      stats: { input_tokens: 900, output_tokens: 120 },
      nowMs: 10_000
    })
    expect(lower).toBeNull()
    const higher = telemetry.report({
      ...base,
      stats: { input_tokens: 900, output_tokens: 640 },
      nowMs: 20_000
    })
    expect(higher?.type === 'snapshot' && higher.outputTokens).toBe(640)
  })

  it('synthesizes total from input + output when the provider omits it', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    const event = telemetry.report({
      ...base,
      stats: { input_tokens: 1000, output_tokens: 250 },
      nowMs: 0
    })
    expect(event?.type === 'snapshot' && event.totalTokens).toBe(1250)
  })

  it('reads camelCase usage keys as a fallback', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    const event = telemetry.report({
      ...base,
      stats: { inputTokens: 10, outputTokens: 20 },
      nowMs: 0
    })
    expect(event?.type === 'snapshot' && event.inputTokens).toBe(10)
    expect(event?.type === 'snapshot' && event.outputTokens).toBe(20)
  })

  it('leaves startedAt empty when no valid start time is supplied', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    const event = telemetry.report({
      ...base,
      startedAtMs: Number.NaN,
      stats: { output_tokens: 5 },
      nowMs: 0
    })
    expect(event?.type === 'snapshot' && event.startedAt).toBe('')
  })
})

describe('SoloWorkingTokenTelemetry.clear', () => {
  it('returns a clear event only for a run this registry actually reported', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    // Never reported → self-gating no-op (so the exit hook ignores ensemble seats).
    expect(telemetry.clear('run-1')).toBeNull()
    expect(telemetry.clear(undefined)).toBeNull()

    telemetry.report({ ...base, stats: { output_tokens: 5 }, nowMs: 0 })
    expect(telemetry.clear('run-1')).toEqual({
      type: 'clear',
      chatId: '',
      roundId: '',
      participantId: '',
      runId: 'run-1'
    })
    // Second clear is a no-op — the record is gone.
    expect(telemetry.clear('run-1')).toBeNull()
  })

  it('re-arms a fresh emission for a reused run id after a clear', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    telemetry.report({ ...base, stats: { output_tokens: 5 }, nowMs: 0 })
    telemetry.clear('run-1')
    // A brand-new turn on the same run id starts a fresh throttle window.
    const event = telemetry.report({ ...base, stats: { output_tokens: 9 }, nowMs: 10 })
    expect(event?.type === 'snapshot' && event.outputTokens).toBe(9)
  })
})

describe('estimated stream snapshots (Grok/Cursor/Kimi-ACP live lane)', () => {
  const estimatedStats = (outputTokens: number) => ({
    input_tokens: 0,
    output_tokens: outputTokens,
    total_tokens: outputTokens,
    _taskwraith_token_count_confidence: 'estimated'
  })

  it('carries the estimated flag so the ≈ marker survives the telemetry lane', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    const event = telemetry.report({ ...base, stats: estimatedStats(40), nowMs: 0 })
    expect(event?.type === 'snapshot' && event.estimated).toBe(true)
  })

  it('flips to authoritative on the first real usage report and never reverts', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    telemetry.report({ ...base, stats: estimatedStats(40), nowMs: 0 })
    // Real terminal usage (Cursor) — flag clears even inside the same maxima.
    const real = telemetry.report({
      ...base,
      stats: { input_tokens: 10, output_tokens: 45, total_tokens: 55 },
      nowMs: SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS + 1
    })
    expect(real?.type === 'snapshot' && real.estimated).toBe(false)
    // A later estimate must not un-authorize the run.
    const late = telemetry.report({
      ...base,
      stats: estimatedStats(60),
      nowMs: 2 * SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS + 2
    })
    expect(late?.type === 'snapshot' && late.estimated).toBe(false)
  })

  it('treats an estimated→authoritative flip as a change even with equal counts', () => {
    const telemetry = new SoloWorkingTokenTelemetry()
    telemetry.report({ ...base, stats: estimatedStats(40), nowMs: 0 })
    const flipped = telemetry.report({
      ...base,
      stats: { output_tokens: 40, total_tokens: 40 },
      nowMs: SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS + 1
    })
    expect(flipped?.type === 'snapshot' && flipped.estimated).toBe(false)
  })
})

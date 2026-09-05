import { describe, expect, it } from 'vitest'
import type { EnsembleWakeupRecord } from '../store/types'
import type { ScheduleWakeupInput } from './EnsembleOrchestratorTypes'
import {
  MAX_WAKEUP_DELAY_MS,
  extractWakeAtFromReason,
  extractWakeupIdFromReason,
  formatWakeupResumePrompt,
  formatWakeupScheduledReason,
  resolveWakeAtMs
} from './EnsembleWakeupFormatting'

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

function wakeup(overrides: Partial<EnsembleWakeupRecord> = {}): EnsembleWakeupRecord {
  return {
    wakeupId: 'wk-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'p1',
    provider: 'codex',
    scheduledAt: '2026-01-01T12:00:00.000Z',
    wakeAt: '2026-01-01T13:00:00.000Z',
    status: 'pending',
    ...overrides
  }
}

function input(overrides: Partial<ScheduleWakeupInput> = {}): ScheduleWakeupInput {
  return { ...overrides }
}

describe('MAX_WAKEUP_DELAY_MS', () => {
  it('caps wakeup delays at exactly seven days', () => {
    expect(MAX_WAKEUP_DELAY_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(MAX_WAKEUP_DELAY_MS).toBe(604800000)
  })

  it('stays under the Node setTimeout clamp', () => {
    // Node silently clamps delays above 2^31-1 ms to 1ms, which would make a
    // far-future wakeup fire immediately. The cap exists to stay below it.
    expect(MAX_WAKEUP_DELAY_MS).toBeLessThan(2 ** 31 - 1)
  })
})

describe('resolveWakeAtMs', () => {
  it('adds an explicit delayMs to now', () => {
    expect(resolveWakeAtMs(input({ delayMs: 5000 }), NOW)).toBe(NOW + 5000)
  })

  it('converts delaySeconds to milliseconds', () => {
    expect(resolveWakeAtMs(input({ delaySeconds: 90 }), NOW)).toBe(NOW + 90000)
  })

  it('prefers delayMs over delaySeconds when both are supplied', () => {
    expect(resolveWakeAtMs(input({ delayMs: 1000, delaySeconds: 90 }), NOW)).toBe(NOW + 1000)
  })

  it('treats a zero delay as an immediate wake rather than an absent delay', () => {
    expect(resolveWakeAtMs(input({ delayMs: 0 }), NOW)).toBe(NOW)
  })

  it('clamps a negative delay to now instead of scheduling in the past', () => {
    expect(resolveWakeAtMs(input({ delayMs: -60000 }), NOW)).toBe(NOW)
    expect(resolveWakeAtMs(input({ delaySeconds: -60 }), NOW)).toBe(NOW)
  })

  it('parses an absolute wakeAt timestamp', () => {
    const wakeAt = '2026-01-02T00:00:00.000Z'
    expect(resolveWakeAtMs(input({ wakeAt }), NOW)).toBe(Date.parse(wakeAt))
  })

  it('falls through to wakeAt when the delay is not finite', () => {
    const wakeAt = '2026-01-02T00:00:00.000Z'
    expect(resolveWakeAtMs(input({ delayMs: Number.NaN, wakeAt }), NOW)).toBe(Date.parse(wakeAt))
    expect(resolveWakeAtMs(input({ delayMs: Number.POSITIVE_INFINITY, wakeAt }), NOW)).toBe(
      Date.parse(wakeAt)
    )
  })

  it('returns NaN for an unparseable wakeAt', () => {
    expect(resolveWakeAtMs(input({ wakeAt: 'not-a-date' }), NOW)).toBeNaN()
  })

  it('returns NaN when no delay or wakeAt is supplied', () => {
    expect(resolveWakeAtMs(input(), NOW)).toBeNaN()
  })
})

describe('formatWakeupScheduledReason', () => {
  it('renders the wakeup marker with the id and wake time', () => {
    expect(formatWakeupScheduledReason(wakeup())).toBe(
      '[wakeup:wk-1 until 2026-01-01T13:00:00.000Z]'
    )
  })

  it('appends the reason only when one was given', () => {
    expect(formatWakeupScheduledReason(wakeup({ reason: 'waiting on CI' }))).toBe(
      '[wakeup:wk-1 until 2026-01-01T13:00:00.000Z] Reason: waiting on CI'
    )
    expect(formatWakeupScheduledReason(wakeup({ reason: '' }))).not.toContain('Reason:')
  })
})

describe('formatWakeupResumePrompt', () => {
  it('keeps the original prompt and appends the scheduled-wakeup block', () => {
    const text = formatWakeupResumePrompt(
      'Carry on.',
      wakeup({ firedAt: '2026-01-01T13:00:01.000Z' })
    )
    expect(text.startsWith('Carry on.\n\n[Scheduled wakeup]')).toBe(true)
    expect(text).toContain('Wakeup id: wk-1')
    expect(text).toContain('Scheduled at: 2026-01-01T12:00:00.000Z')
    expect(text).toContain('Woke at: 2026-01-01T13:00:01.000Z')
    expect(
      text.endsWith('Continue this same Ensemble round from where you intentionally slept.')
    ).toBe(true)
  })

  it('includes the wake reason only when the record carries one', () => {
    expect(formatWakeupResumePrompt('go', wakeup({ reason: 'poll again' }))).toContain(
      '\nWake reason: poll again'
    )
    expect(formatWakeupResumePrompt('go', wakeup())).not.toContain('Wake reason:')
  })

  it('falls back to the current time when the record has no firedAt', () => {
    const text = formatWakeupResumePrompt('go', wakeup())
    expect(text).toMatch(/Woke at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  })
})

describe('wakeup marker round trip', () => {
  it('recovers the wakeup id it formatted', () => {
    const reason = formatWakeupScheduledReason(wakeup())
    expect(extractWakeupIdFromReason(reason)).toBe('wk-1')
  })

  it('recovers the wake time it formatted', () => {
    const reason = formatWakeupScheduledReason(wakeup())
    expect(extractWakeAtFromReason(reason)).toBe('2026-01-01T13:00:00.000Z')
  })

  it('still recovers both fields when a trailing reason is appended', () => {
    const reason = formatWakeupScheduledReason(wakeup({ reason: 'waiting on CI' }))
    expect(extractWakeupIdFromReason(reason)).toBe('wk-1')
    expect(extractWakeAtFromReason(reason)).toBe('2026-01-01T13:00:00.000Z')
  })

  it('stops the id at the first space so it never swallows the wake time', () => {
    expect(extractWakeupIdFromReason('[wakeup:abc until 2026-01-01T00:00:00.000Z]')).toBe('abc')
  })

  it('returns undefined when the text carries no wakeup marker', () => {
    expect(extractWakeupIdFromReason('plain sleeping note')).toBeUndefined()
    expect(extractWakeAtFromReason('plain sleeping note')).toBeUndefined()
  })
})

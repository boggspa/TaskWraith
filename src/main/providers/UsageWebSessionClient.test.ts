import { describe, expect, it } from 'vitest'
import { parseUsageWebSessionReading } from './UsageWebSessionClient'

const CAPTURED_AT = '2026-08-25T20:00:00.000Z'

describe('parseUsageWebSessionReading', () => {
  it('parses a Meta billing balance and billing-period spend', () => {
    expect(
      parseUsageWebSessionReading(
        'meta',
        '<div>Current balance</div><strong>£15.00</strong><div>Spend this billing period £0.42</div>',
        CAPTURED_AT
      )
    ).toEqual({ balance: 15, spend: 0.42, currency: 'GBP', capturedAt: CAPTURED_AT })
  })

  it('parses a Cerebras current balance without inventing spend', () => {
    expect(
      parseUsageWebSessionReading(
        'cerebras',
        'Billing\nAvailable credit USD 11.56\nInvoices',
        CAPTURED_AT
      )
    ).toEqual({ balance: 11.56, currency: 'USD', capturedAt: CAPTURED_AT })
  })

  it('parses Qwen rendered zero usage', () => {
    expect(
      parseUsageWebSessionReading(
        'qwen',
        'Plan Quota\nLast Updated: 2026-08-25 17:31:03\n7-Day Quota\n0% Used\n0% 50% 90% 100%',
        CAPTURED_AT
      )
    ).toEqual({ quotaUsedPercent: 0, capturedAt: CAPTURED_AT })
  })

  it('parses MiMo plan, usage, and UTC validity', () => {
    expect(
      parseUsageWebSessionReading(
        'mimo',
        [
          'Plan usage',
          'Lite Monthly Plan',
          'Auto-Renewal Monthly',
          'Valid until 2026-09-25 23:59:59 (UTC)',
          'Current plan usage',
          '0 / 4,100,000,000 Used 0.0%'
        ].join('\n'),
        CAPTURED_AT
      )
    ).toEqual({
      quotaUsedPercent: 0,
      planName: 'Lite Monthly Plan',
      resetAt: '2026-09-25T23:59:59.000Z',
      capturedAt: CAPTURED_AT
    })
  })

  it('parses the Muse Code subscription meters, weekly reset, and plan name', () => {
    const capturedAt = '2026-09-01T09:00:00.000Z'
    expect(
      parseUsageWebSessionReading(
        'muse',
        [
          'Usage',
          'Muse Code High Usage subscription',
          'Last updated at 10:14',
          'Current usage',
          '37% used',
          'Weekly limit',
          '82% used',
          'Resets 7 Sep at 01:00',
          'Pay as you go',
          'Spend (GBP) £3.84'
        ].join('\n'),
        capturedAt
      )
    ).toEqual({
      currentUsedPercent: 37,
      weeklyUsedPercent: 82,
      planName: 'Muse Code High Usage',
      resetAt: new Date(2026, 8, 7, 1, 0).toISOString(),
      capturedAt
    })
  })

  it('reads zero-percent Muse meters as real readings, not absences', () => {
    const capturedAt = '2026-09-01T09:00:00.000Z'
    expect(
      parseUsageWebSessionReading(
        'muse',
        'Current usage\n0% used\nWeekly limit\n0% used\nResets 7 Sep at 01:00',
        capturedAt
      )
    ).toEqual({
      currentUsedPercent: 0,
      weeklyUsedPercent: 0,
      resetAt: new Date(2026, 8, 7, 1, 0).toISOString(),
      capturedAt
    })
  })

  it('rolls a Muse weekly reset without a year across the Dec→Jan boundary', () => {
    const capturedAt = new Date(2026, 11, 30, 12, 0).toISOString()
    const reading = parseUsageWebSessionReading(
      'muse',
      'Weekly limit\n12% used\nResets 3 Jan at 01:00',
      capturedAt
    )
    expect(reading).toEqual({
      weeklyUsedPercent: 12,
      resetAt: new Date(2027, 0, 3, 1, 0).toISOString(),
      capturedAt
    })
  })

  it('accepts a month-first Muse reset and a meter without any reset', () => {
    const capturedAt = '2026-09-01T09:00:00.000Z'
    expect(
      parseUsageWebSessionReading(
        'muse',
        'Weekly limit\n5% used\nResets Sep 7 at 01:00',
        capturedAt
      )
    ).toEqual({
      weeklyUsedPercent: 5,
      resetAt: new Date(2026, 8, 7, 1, 0).toISOString(),
      capturedAt
    })
    expect(parseUsageWebSessionReading('muse', 'Current usage\n64% used', capturedAt)).toEqual({
      currentUsedPercent: 64,
      capturedAt
    })
  })

  it('rejects signed-out or unpopulated pages', () => {
    expect(parseUsageWebSessionReading('meta', 'Sign in to continue', CAPTURED_AT)).toBeNull()
    expect(parseUsageWebSessionReading('qwen', 'Token Plan loading…', CAPTURED_AT)).toBeNull()
    expect(parseUsageWebSessionReading('muse', 'Log in to continue', CAPTURED_AT)).toBeNull()
    expect(
      parseUsageWebSessionReading(
        'muse',
        'Muse Code High Usage subscription\nLoading…',
        CAPTURED_AT
      )
    ).toBeNull()
  })
})

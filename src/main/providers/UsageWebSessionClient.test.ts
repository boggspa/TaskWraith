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

  it('rejects signed-out or unpopulated pages', () => {
    expect(parseUsageWebSessionReading('meta', 'Sign in to continue', CAPTURED_AT)).toBeNull()
    expect(parseUsageWebSessionReading('qwen', 'Token Plan loading…', CAPTURED_AT)).toBeNull()
  })
})

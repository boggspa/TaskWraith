import { describe, expect, it } from 'vitest'
import {
  buildUsageCreditRows,
  formatUsageCreditValue,
  selectUsageCreditBalance
} from './usageCredits'
import type { ModelUsageAggregate, UsageBalanceAggregate } from './usageAggregateTypes'

const balance = (
  label: string,
  amount: number,
  unit = 'USD',
  subtitle?: string
): UsageBalanceAggregate => ({
  id: label.toLowerCase().replace(/\s+/g, '-'),
  label,
  amount,
  unit,
  subtitle
})

const entry = (
  provider: ModelUsageAggregate['provider'],
  balances: UsageBalanceAggregate[] = []
): ModelUsageAggregate => ({
  provider,
  model: 'usage limits',
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  durationMs: 0,
  windows: [],
  balances
})

describe('selectUsageCreditBalance', () => {
  it('prefers the headline balance by label priority, not source order', () => {
    const picked = selectUsageCreditBalance([
      balance('Granted', 5),
      balance('Prepaid remaining', 2),
      balance('Total available', 7)
    ])
    expect(picked?.label).toBe('Total available')
  })

  it('matches labels case- and whitespace-insensitively', () => {
    expect(selectUsageCreditBalance([balance('  CREDITS REMAINING ', 3, 'credits')])?.amount).toBe(
      3
    )
  })

  it('returns null when no balance carries a credit-like label', () => {
    expect(selectUsageCreditBalance([balance('Payment threshold', 50)])).toBeNull()
    expect(selectUsageCreditBalance([])).toBeNull()
    expect(selectUsageCreditBalance(undefined)).toBeNull()
  })

  it('skips a priority label whose amount is not finite', () => {
    expect(
      selectUsageCreditBalance([
        balance('Total available', Number.NaN),
        balance('Prepaid remaining', 1)
      ])?.label
    ).toBe('Prepaid remaining')
  })
})

describe('formatUsageCreditValue', () => {
  it('renders ISO currencies with their symbol and two decimals', () => {
    expect(formatUsageCreditValue(19.97, 'USD', 'en-US')).toBe('$19.97')
    expect(formatUsageCreditValue(0, 'GBP', 'en-GB')).toBe('£0.00')
    expect(formatUsageCreditValue(6.99, 'EUR', 'en-IE')).toBe('€6.99')
  })

  it('keeps a sub-cent sliver visible instead of rounding it to zero', () => {
    expect(formatUsageCreditValue(0.0042, 'USD', 'en-US')).toBe('$0.0042')
  })

  it('renders credits compactly', () => {
    expect(formatUsageCreditValue(0, 'credits', 'en-US')).toBe('0 credits')
    expect(formatUsageCreditValue(1500, 'credits', 'en-US')).toBe('1.5K credits')
    expect(formatUsageCreditValue(2_000_000, 'credit', 'en-US')).toBe('2M credits')
  })

  it('renders a unit-less amount as a plain number and other units verbatim', () => {
    expect(formatUsageCreditValue(12.5, '', 'en-US')).toBe('12.5')
    expect(formatUsageCreditValue(300, 'quota', 'en-US')).toBe('300 quota')
    expect(formatUsageCreditValue(Number.NaN, 'USD')).toBe('—')
  })
})

describe('buildUsageCreditRows', () => {
  it('yields one accented row per provider with a leading balance, in entry order', () => {
    const rows = buildUsageCreditRows(
      [
        entry('codex', [balance('Credits Remaining', 0, 'credits')]),
        entry('deepseek', [
          balance('Total available', 19.97, 'USD', 'Official DeepSeek API'),
          balance('Granted', 0, 'USD')
        ]),
        entry('kimi', [balance('Total Quota', 400, 'quota')])
      ],
      { locale: 'en-US' }
    )
    expect(rows.map((row) => [row.provider, row.valueText, row.hasValue])).toEqual([
      ['codex', '0 credits', true],
      ['deepseek', '$19.97', true]
    ])
    expect(rows[1].detail).toBe('Total available · Official DeepSeek API')
  })

  it('adds a placeholder row only for the named providers that have no balance', () => {
    const rows = buildUsageCreditRows(
      [entry('claude', [balance('Extra Usage', 3, 'USD')]), entry('cursor', [])],
      { placeholderProviders: ['claude', 'grok'], locale: 'en-US' }
    )
    expect(rows.map((row) => [row.provider, row.valueText, row.hasValue])).toEqual([
      ['claude', '$3.00', true],
      ['grok', '—', false]
    ])
    expect(rows[1].detail).toContain('Grok reports subscription credits')
  })

  it('keeps two accounts of one provider as two rows, each with its label', () => {
    const rows = buildUsageCreditRows(
      [
        entry('codex', [balance('Credits Remaining', 0, 'credits')]),
        {
          ...entry('codex', [balance('Credits Remaining', 12, 'credits')]),
          accountId: 'codex-second',
          accountLabel: 'Second'
        }
      ],
      { locale: 'en-US' }
    )
    expect(rows.map((row) => [row.provider, row.accountLabel, row.valueText])).toEqual([
      ['codex', undefined, '0 credits'],
      ['codex', 'Second', '12 credits']
    ])
    expect(rows[1].accountId).toBe('codex-second')
  })

  it('lets a later entry with a balance replace an earlier placeholder for the same provider', () => {
    const rows = buildUsageCreditRows(
      [entry('claude', []), entry('claude', [balance('Usage Credits', 1.25, 'GBP')])],
      { placeholderProviders: ['claude'], locale: 'en-GB' }
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].valueText).toBe('£1.25')
  })
})

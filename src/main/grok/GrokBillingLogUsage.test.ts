import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseGrokUsage } from './GrokUsage'
import {
  coalesceGrokUsageToActivePeriod,
  parseGrokBillingLogUsage,
  readGrokBillingLogUsage
} from './GrokBillingLogUsage'

function row(input: {
  ts: string
  used?: number
  start: string
  end: string
  tier: string
  type?: string
}): string {
  return JSON.stringify({
    ts: input.ts,
    msg: 'billing: fetched credits config',
    ctx: {
      config: {
        ...(input.used === undefined ? {} : { creditUsagePercent: input.used }),
        currentPeriod: {
          type: input.type ?? 'USAGE_PERIOD_TYPE_WEEKLY',
          start: input.start,
          end: input.end
        },
        billingPeriodStart: input.start,
        billingPeriodEnd: input.end
      },
      subscriptionTier: input.tier
    }
  })
}

describe('parseGrokBillingLogUsage', () => {
  it('coalesces a transient omission only within the active account period', () => {
    const start = '2026-08-20T17:04:15.560820Z'
    const end = '2026-08-27T17:04:15.560820Z'
    const snapshot = parseGrokBillingLogUsage(
      [
        row({ ts: '2026-08-22T10:00:00Z', used: 12, start, end, tier: 'X Premium' }),
        row({ ts: '2026-08-22T10:05:00Z', start, end, tier: 'X Premium' })
      ].join('\n'),
      new Date('2026-08-22T10:06:00Z')
    )

    expect(snapshot).toMatchObject({
      source: 'grok-cli-billing-log',
      usageKind: 'weekly_limit',
      creditsUsedPercent: 12,
      creditsUsedDisplay: '12%',
      planLabel: 'X Premium',
      periodStartAt: '2026-08-20T17:04:15.560Z',
      resetAt: '2026-08-27T17:04:15.560Z'
    })
  })

  it('treats an omitted percentage in a newly-active upgrade period as zero', () => {
    const snapshot = parseGrokBillingLogUsage(
      [
        row({
          ts: '2026-08-20T16:54:49Z',
          used: 99,
          start: '2026-08-13T17:04:15Z',
          end: '2026-08-20T17:04:15Z',
          tier: 'SuperGrok'
        }),
        row({
          ts: '2026-08-20T17:27:36Z',
          start: '2026-08-20T17:04:15Z',
          end: '2026-08-27T17:04:15Z',
          tier: 'X Premium'
        })
      ].join('\n'),
      new Date('2026-08-20T18:00:00Z')
    )

    expect(snapshot?.creditsUsedPercent).toBe(0)
    expect(snapshot?.planLabel).toBe('X Premium')
    expect(snapshot?.periodStartAt).toBe('2026-08-20T17:04:15.000Z')
  })

  it('does not borrow usage across conflicting billing periods', () => {
    const snapshot = parseGrokBillingLogUsage(
      [
        row({
          ts: '2026-08-20T16:54:49Z',
          used: 99,
          start: '2026-08-13T17:04:15Z',
          end: '2026-08-20T17:04:15Z',
          tier: 'SuperGrok'
        }),
        row({
          ts: '2026-10-01T00:00:00Z',
          start: '2026-09-01T00:00:00Z',
          end: '2026-10-01T00:00:00Z',
          tier: 'SuperGrok',
          type: 'USAGE_PERIOD_TYPE_MONTHLY'
        })
      ].join('\n'),
      new Date('2026-10-02T00:00:00Z')
    )

    expect(snapshot?.creditsUsedPercent).toBe(99)
    expect(snapshot?.periodStartAt).toBe('2026-08-13T17:04:15.000Z')
  })

  it('ignores malformed and unrelated log rows', () => {
    expect(parseGrokBillingLogUsage('not json\n{"msg":"something else"}')).toBeNull()
  })
})

describe('readGrokBillingLogUsage', () => {
  it('reads a bounded local billing-log file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-grok-billing-'))
    const logs = join(root, 'logs')
    await mkdir(logs)
    const path = join(logs, 'unified.jsonl')
    await writeFile(
      path,
      row({
        ts: '2026-08-22T10:00:00Z',
        used: 12,
        start: '2026-08-20T17:04:15Z',
        end: '2026-08-27T17:04:15Z',
        tier: 'X Premium'
      })
    )

    await expect(
      readGrokBillingLogUsage(path, new Date('2026-08-22T10:06:00Z'))
    ).resolves.toMatchObject({
      creditsUsedPercent: 12,
      planLabel: 'X Premium'
    })
  })
})

describe('coalesceGrokUsageToActivePeriod', () => {
  it('uses the newer active log period when the TUI is unavailable during an upgrade', () => {
    const tui = parseGrokUsage('', '2026-08-20T17:30:00Z')
    const log = parseGrokBillingLogUsage(
      row({
        ts: '2026-08-20T17:27:36Z',
        start: '2026-08-20T17:04:15Z',
        end: '2026-08-27T17:04:15Z',
        tier: 'X Premium'
      }),
      new Date('2026-08-20T18:00:00Z')
    )

    expect(
      coalesceGrokUsageToActivePeriod(tui, log, new Date('2026-08-20T18:00:00Z'))
    ).toMatchObject({ confidence: 'observed', creditsUsedPercent: 0, planLabel: 'X Premium' })
  })

  it('keeps a live TUI reading when the log belongs to an expired period', () => {
    const tui = parseGrokUsage(
      'Weekly limit: 15%\nNext reset: August 27, 09:04 PT',
      '2026-08-25T12:00:00Z'
    )
    const log = parseGrokBillingLogUsage(
      row({
        ts: '2026-08-20T16:54:49Z',
        used: 99,
        start: '2026-08-13T17:04:15Z',
        end: '2026-08-20T17:04:15Z',
        tier: 'SuperGrok'
      }),
      new Date('2026-08-20T16:55:00Z')
    )

    expect(
      coalesceGrokUsageToActivePeriod(tui, log, new Date('2026-08-25T12:00:00Z'))
    ).toMatchObject({ source: 'grok-cli-usage', creditsUsedPercent: 15 })
  })
})

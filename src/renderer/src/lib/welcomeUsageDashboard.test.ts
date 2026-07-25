import { describe, expect, it } from 'vitest'

import type { UsageRecord } from '../../../main/store/types'

import {
  HEATMAP_DAY_COUNT,
  HEATMAP_HOUR_COUNT,
  buildWelcomeUsageDashboardData,
  formatDashboardDuration,
  mixProviderColors
} from './welcomeUsageDashboard'

const baseRecord = (overrides: Partial<UsageRecord>): UsageRecord => ({
  id: 'rec',
  provider: 'codex',
  timestamp: 0,
  workspaceId: 'ws-1',
  chatId: 'chat-1',
  runId: 'run-1',
  model: 'gpt-5-codex',
  inputTokens: 100,
  outputTokens: 200,
  totalTokens: 300,
  durationMs: 1000,
  usageKind: 'run',
  ...overrides
})

describe('buildWelcomeUsageDashboardData hourly grid', () => {
  it('emits HEATMAP_DAY_COUNT × HEATMAP_HOUR_COUNT cells anchored on the current hour', () => {
    const now = new Date(2026, 4, 15, 14, 30).getTime()
    const data = buildWelcomeUsageDashboardData([], [], 'all', now)
    expect(data.hourlyHeatmap).toHaveLength(HEATMAP_DAY_COUNT * HEATMAP_HOUR_COUNT)
    const last = data.hourlyHeatmap[data.hourlyHeatmap.length - 1]
    expect(last.isCurrentHour).toBe(true)
    expect(last.hour).toBe(14)
    // Cells are chronological; the first is the oldest.
    const first = data.hourlyHeatmap[0]
    const expectedStart =
      new Date(2026, 4, 15, 14).getTime() -
      (HEATMAP_DAY_COUNT * HEATMAP_HOUR_COUNT - 1) * 60 * 60 * 1000
    const firstDate = new Date(expectedStart)
    expect(first.hour).toBe(firstDate.getHours())
  })

  it('buckets usage tokens by local hour and tracks provider totals', () => {
    const now = new Date(2026, 4, 15, 14, 0).getTime()
    const sameHour = new Date(2026, 4, 15, 12, 25).getTime()
    const records: UsageRecord[] = [
      baseRecord({ id: 'a', timestamp: sameHour, provider: 'codex', totalTokens: 200 }),
      baseRecord({ id: 'b', timestamp: sameHour + 60_000, provider: 'gemini', totalTokens: 400 })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], 'all', now)
    const hourCell = data.hourlyHeatmap.find(
      (cell) => cell.hour === 12 && cell.dayKey === '2026-05-15'
    )
    expect(hourCell).toBeDefined()
    expect(hourCell!.totalTokens).toBe(600)
    expect(hourCell!.providerTotals.codex).toBe(200)
    expect(hourCell!.providerTotals.gemini).toBe(400)
    expect(hourCell!.providerTotals.claude).toBe(0)
    expect(hourCell!.providerTotals.kimi).toBe(0)
    expect(hourCell!.level).toBeGreaterThanOrEqual(1)
    expect(hourCell!.level).toBeLessThanOrEqual(4)
  })

  it('scales level intensity 0..4 by hourly maximum', () => {
    const now = new Date(2026, 4, 15, 14, 0).getTime()
    const records: UsageRecord[] = [
      baseRecord({ id: 'low', timestamp: new Date(2026, 4, 15, 10, 0).getTime(), totalTokens: 10 }),
      baseRecord({
        id: 'high',
        timestamp: new Date(2026, 4, 15, 11, 0).getTime(),
        totalTokens: 4000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], 'all', now)
    const lowCell = data.hourlyHeatmap.find(
      (cell) => cell.hour === 10 && cell.dayKey === '2026-05-15'
    )
    const highCell = data.hourlyHeatmap.find(
      (cell) => cell.hour === 11 && cell.dayKey === '2026-05-15'
    )
    expect(lowCell!.level).toBe(1)
    expect(highCell!.level).toBe(4)
  })

  it('treats usage records without explicit token counts as a single unit', () => {
    const now = new Date(2026, 4, 15, 14, 0).getTime()
    const record = baseRecord({
      id: 'no-tokens',
      timestamp: new Date(2026, 4, 15, 9, 30).getTime(),
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      provider: 'claude'
    })
    const data = buildWelcomeUsageDashboardData([record], [], 'all', now)
    const cell = data.hourlyHeatmap.find((c) => c.hour === 9 && c.dayKey === '2026-05-15')
    expect(cell!.totalTokens).toBe(1)
    expect(cell!.providerTotals.claude).toBe(1)
  })
})

describe('buildWelcomeUsageDashboardData model breakdown — range scoping (Welcome L4)', () => {
  // Anchor "now" so cutoff math is deterministic.
  const NOW = new Date(2026, 4, 22, 12, 0).getTime() // 2026-05-22 12:00 local
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR

  it('uses cache-inclusive input and fallback totals in dashboard aggregates', () => {
    const data = buildWelcomeUsageDashboardData(
      [
        baseRecord({
          timestamp: NOW - HOUR,
          provider: 'claude',
          model: 'claude-sonnet-4-7',
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 0,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 10
        })
      ],
      [],
      '24h',
      NOW
    )

    expect(data.totalTokens).toBe(75)
    expect(data.tokens24h).toBe(75)
    expect(data.providerCostBreakdown.find((row) => row.provider === 'claude')?.tokens).toBe(75)
    expect(data.modelBreakdown[0]).toMatchObject({
      inputTokens: 70,
      outputTokens: 5,
      totalTokens: 75
    })
  })

  it('computes model percentages against the selected range, not the lifetime aggregate', () => {
    // Two records: gpt-5-codex 90 days ago (200k tokens), gemini-flash today (50k tokens).
    // Under `'all'` the older gpt entry dominates the percentages.
    // Under `'7d'` only the gemini entry survives the cutoff and the
    // breakdown becomes single-model 100%.
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old-codex',
        timestamp: NOW - 90 * DAY,
        provider: 'codex',
        model: 'gpt-5-codex',
        inputTokens: 100_000,
        outputTokens: 100_000,
        totalTokens: 200_000
      }),
      baseRecord({
        id: 'recent-gemini',
        timestamp: NOW - 30 * 60_000, // 30 minutes ago
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        inputTokens: 30_000,
        outputTokens: 20_000,
        totalTokens: 50_000
      })
    ]

    const allData = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    expect(allData.modelBreakdown).toHaveLength(2)
    // Older codex entry has 4x tokens → larger percent share under lifetime.
    const codexAll = allData.modelBreakdown.find((m) => m.model === 'gpt-5-codex')
    const geminiAll = allData.modelBreakdown.find((m) => m.model === 'gemini-3-flash-preview')
    expect(codexAll!.percent).toBeGreaterThan(geminiAll!.percent)
    // Sum of percents is ~100.
    expect(codexAll!.percent + geminiAll!.percent).toBeCloseTo(100, 0)

    const dayData = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    expect(dayData.modelBreakdown).toHaveLength(1)
    expect(dayData.modelBreakdown[0].model).toBe('gemini-3-flash-preview')
    expect(dayData.modelBreakdown[0].percent).toBeCloseTo(100, 0)

    const weekData = buildWelcomeUsageDashboardData(records, [], '7d', NOW)
    expect(weekData.modelBreakdown).toHaveLength(1)
    expect(weekData.modelBreakdown[0].model).toBe('gemini-3-flash-preview')

    const monthData = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    // Still only the gemini entry — the 90-day-old codex run is outside 30d.
    expect(monthData.modelBreakdown).toHaveLength(1)
    expect(monthData.modelBreakdown[0].model).toBe('gemini-3-flash-preview')
  })

  it('drops models with zero in-range tokens entirely (not 0%)', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old-claude',
        timestamp: NOW - 60 * DAY,
        provider: 'claude',
        model: 'sonnet-4-6',
        totalTokens: 10_000
      }),
      baseRecord({
        id: 'recent-codex',
        timestamp: NOW - 1 * HOUR,
        provider: 'codex',
        model: 'gpt-5-codex',
        totalTokens: 5_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    expect(data.modelBreakdown.map((m) => m.model)).toEqual(['gpt-5-codex'])
    // No 0% claude entry — model breakdown derives from filtered runRecords.
    expect(data.modelBreakdown.find((m) => m.model === 'sonnet-4-6')).toBeUndefined()
  })

  it('reports zero models + 0 totalTokens when the selected window has no activity', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old-only',
        timestamp: NOW - 60 * DAY,
        provider: 'kimi',
        model: 'kimi-k2.6',
        totalTokens: 12_345
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    expect(data.modelBreakdown).toEqual([])
    expect(data.totalTokens).toBe(0)
    expect(data.hasActivity).toBe(false)
    expect(data.favoriteModel).toBe('n/a')
  })

  it('reports lifetimeHasActivity=true even when the selected window is empty (Welcome L6)', () => {
    // Same shape as the previous test but check the L6 flag: when the
    // user has historical activity but nothing in the selected range,
    // lifetimeHasActivity must stay true so the renderer keeps the
    // dashboard + range-toggle mounted.
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old-only',
        timestamp: NOW - 60 * DAY,
        provider: 'kimi',
        model: 'kimi-k2.6',
        totalTokens: 12_345
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    expect(data.hasActivity).toBe(false)
    expect(data.lifetimeHasActivity).toBe(true)

    // And conversely: when there is literally no data anywhere, both
    // flags read false and the renderer hides the dashboard entirely.
    const dryData = buildWelcomeUsageDashboardData([], [], 'all', NOW)
    expect(dryData.hasActivity).toBe(false)
    expect(dryData.lifetimeHasActivity).toBe(false)
  })

  it('uses messageCount on summary-only chat list items for lifetimeHasActivity', () => {
    const summaryChat = {
      appChatId: 'chat-summary',
      title: 'Indexed Thread',
      summaryOnly: true as const,
      messageCount: 3,
      runCount: 1,
      messages: [],
      runs: [],
      createdAt: NOW,
      updatedAt: NOW
    }
    const data = buildWelcomeUsageDashboardData([], [summaryChat as any], 'all', NOW)
    expect(data.lifetimeHasActivity).toBe(true)

    const emptySummary = { ...summaryChat, messageCount: 0, runCount: 0 }
    const dryData = buildWelcomeUsageDashboardData([], [emptySummary as any], 'all', NOW)
    expect(dryData.lifetimeHasActivity).toBe(false)
  })
})

describe('buildWelcomeUsageDashboardData headline stats — range scoping (Welcome L5)', () => {
  // Anchor "now" so cutoff math is deterministic.
  const NOW = new Date(2026, 4, 22, 12, 0).getTime() // 2026-05-22 12:00 local
  const DAY = 24 * 60 * 60 * 1000

  it('range-scopes sessions / messages / activeDays / peakHour / favoriteModel', () => {
    // Two windows of activity: a big burst 60 days ago (a 5-day streak,
    // 3 sessions, codex-dominant) and a single tiny entry today
    // (gemini). A 24h window should only see today's activity.
    const records: UsageRecord[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        baseRecord({
          id: `burst-${i}`,
          timestamp: NOW - (60 - i) * DAY + 14 * 60 * 60 * 1000,
          provider: 'codex',
          model: 'gpt-5-codex',
          chatId: `burst-chat-${i % 3}`, // 3 distinct sessions in burst
          totalTokens: 100_000
        })
      ),
      baseRecord({
        id: 'today',
        timestamp: NOW - 30 * 60_000, // 30 min ago
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        chatId: 'recent-chat',
        totalTokens: 1_000
      })
    ]

    const all = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    expect(all.sessions).toBe(4) // 3 burst chats + 1 recent
    expect(all.activeDays).toBe(6) // 5-day burst + today
    // 1.0.5-EW50 — `favoriteModel` now flows through the shared
    // `humaniseModelId` resolver, so a known id becomes its
    // canonical display name. `gpt-5-codex` isn't in the known
    // mapping table (the canonical Codex ids start at gpt-5.2),
    // so it falls back to the raw id — keeping this assertion
    // intact while documenting the contract for future Codex
    // entries.
    expect(all.favoriteModel).toBe('gpt-5-codex')

    const day = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    expect(day.sessions).toBe(1) // just the recent-chat
    expect(day.activeDays).toBe(1) // just today
    // 1.0.5-EW50 — `gemini-3-flash-preview` IS in the known
    // mapping table, so the favorite-model chip now reads as
    // "Gemini 3 Flash Preview" rather than the raw CLI id.
    expect(day.favoriteModel).toBe('Gemini 3 Flash Preview')
  })

  it('keeps current + longest streak ON THE LIFETIME calendar regardless of range', () => {
    // Records span: a 5-day streak 30+ days ago, a 2-day streak today/yesterday.
    // Lifetime longest streak = 5. Current streak = 2.
    // A 24h range view must STILL show longestStreak=5, currentStreak=2 —
    // not collapse them to whatever the 24h slice contains.
    const burstStart = NOW - 30 * DAY
    const records: UsageRecord[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        baseRecord({
          id: `burst-${i}`,
          timestamp: burstStart - (4 - i) * DAY + 10 * 60 * 60 * 1000,
          provider: 'gemini',
          totalTokens: 1_000
        })
      ),
      baseRecord({
        // Yesterday at 09:00 — 27 hours before NOW (May 22 12:00), so
        // outside the 24h cutoff but inside the 7d cutoff.
        id: 'yesterday',
        timestamp: new Date(2026, 4, 21, 9, 0).getTime(),
        provider: 'gemini',
        totalTokens: 500
      }),
      baseRecord({
        id: 'today',
        timestamp: NOW - 30 * 60_000,
        provider: 'gemini',
        totalTokens: 500
      })
    ]

    const all = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    expect(all.currentStreak).toBe(2)
    expect(all.longestStreak).toBe(5)

    const day = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    // Sessions / activeDays narrow but streaks stay lifetime.
    expect(day.activeDays).toBe(1) // only today in-window
    expect(day.currentStreak).toBe(2)
    expect(day.longestStreak).toBe(5)

    const week = buildWelcomeUsageDashboardData(records, [], '7d', NOW)
    expect(week.activeDays).toBe(2) // today + yesterday
    expect(week.currentStreak).toBe(2)
    expect(week.longestStreak).toBe(5)
  })

  it('peakHour reflects the selected range (not lifetime)', () => {
    // Two records at different hours; the 24h view should pick the
    // recent one's hour, all-time picks whichever has more tokens.
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old-3am',
        timestamp: new Date(2026, 3, 22, 3, 0).getTime(), // 30 days ago at 03:00
        provider: 'codex',
        totalTokens: 500_000
      }),
      baseRecord({
        id: 'recent-noon',
        timestamp: NOW - 30 * 60_000, // 11:30 same day
        provider: 'gemini',
        totalTokens: 1_000
      })
    ]
    const all = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    // Lifetime: the 500k-token 03:00 burst dominates the hour totals
    // (formatter renders as "3 AM").
    expect(all.peakHour).toBe('3 AM')
    const day = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    // 24h: only the 11:30 record survives the cutoff — peak hour
    // shifts to the noon-ish bucket and definitely isn't 3 AM.
    expect(day.peakHour).not.toBe('3 AM')
  })
})

describe('buildWelcomeUsageDashboardData model-breakdown filter (Welcome L8)', () => {
  const NOW = new Date(2026, 4, 22, 12, 0).getTime()

  it('drops `default` model entries across every provider', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'a',
        timestamp: NOW - 60_000,
        provider: 'claude',
        model: 'default',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'b',
        timestamp: NOW - 90_000,
        provider: 'kimi',
        model: 'default',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'c',
        timestamp: NOW - 120_000,
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        totalTokens: 5_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    expect(data.modelBreakdown.map((m) => m.model)).toEqual(['gemini-3-flash-preview'])
    // The `default` runs still contribute to total tokens + active days
    // because they happened — only the per-model breakdown filter is
    // narrower than the rest of the stats.
    expect(data.totalTokens).toBeGreaterThan(5_000)
  })

  it('keeps canonical K2.7 Coding and K3 plus legacy K2.6 variants and relabels them', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'k3',
        timestamp: NOW - 15_000,
        provider: 'kimi',
        model: 'kimi-k3',
        totalTokens: 3_000
      }),
      baseRecord({
        id: 'k27',
        timestamp: NOW - 30_000,
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        totalTokens: 2_000
      }),
      baseRecord({
        id: 'a',
        timestamp: NOW - 60_000,
        provider: 'kimi',
        model: 'kimi-k2.6',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'b',
        timestamp: NOW - 90_000,
        provider: 'kimi',
        model: 'kimi-k2-thinking',
        totalTokens: 500
      }),
      baseRecord({
        id: 'c',
        timestamp: NOW - 120_000,
        provider: 'kimi',
        model: 'kimi-latest',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'd',
        timestamp: NOW - 150_000,
        provider: 'kimi',
        model: 'kimi-k2.5',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'e',
        timestamp: NOW - 180_000,
        provider: 'kimi',
        model: 'kimi-k2',
        totalTokens: 1_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    expect(data.modelBreakdown.map((m) => m.label)).toEqual([
      'K3',
      'K2.7 Coding',
      'Kimi K2.6',
      'Kimi K2.6 Thinking'
    ])
  })

  it('repairs stale Grok/Cursor Gemini fallback model ids into current provider defaults', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'grok-stale',
        timestamp: NOW - 60_000,
        provider: 'grok',
        model: 'flash-lite',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150
      }),
      baseRecord({
        id: 'grok-real',
        timestamp: NOW - 90_000,
        provider: 'grok',
        model: 'grok-build',
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300
      }),
      baseRecord({
        id: 'cursor-stale',
        timestamp: NOW - 120_000,
        provider: 'cursor',
        model: 'gemini-3.1-flash-lite',
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500
      }),
      baseRecord({
        id: 'cursor-real',
        timestamp: NOW - 150_000,
        provider: 'cursor',
        model: 'composer-2.5-fast',
        inputTokens: 2_000,
        outputTokens: 1_000,
        totalTokens: 3_000
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)

    expect(data.modelBreakdown.map((m) => [m.provider, m.model, m.label, m.totalTokens])).toEqual([
      ['cursor', 'composer-2.5-fast', 'Composer 2.5 Fast', 4_500],
      ['grok', 'grok-4.5', 'Grok 4.5 Fast', 450]
    ])
  })

  it('treats bare GPT OSS model names as local Ollama usage', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'gpt-oss-local',
        provider: undefined,
        timestamp: NOW - 90_000,
        model: 'gpt-oss',
        inputTokens: 2_000,
        outputTokens: 500,
        totalTokens: 2_500
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)

    expect(data.modelBreakdown.map((m) => [m.provider, m.model, m.label])).toEqual([
      ['ollama', 'gpt-oss:20b', 'GPT OSS (20B Param)']
    ])
  })

  it('treats bare Fable model names as Claude usage', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'fable-legacy',
        provider: undefined,
        timestamp: NOW - 90_000,
        model: 'fable',
        inputTokens: 2_000,
        outputTokens: 500,
        totalTokens: 2_500
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)

    expect(data.modelBreakdown.map((m) => [m.provider, m.model, m.label, m.colorClass])).toEqual([
      ['claude', 'fable', 'Claude Fable', 'provider-claude']
    ])
  })

  it('treats bare Gemma model names as local Ollama usage', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'gemma-local',
        provider: undefined,
        timestamp: NOW - 90_000,
        model: 'gemma4:12b',
        inputTokens: 2_000,
        outputTokens: 500,
        totalTokens: 2_500
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)

    expect(data.modelBreakdown.map((m) => [m.provider, m.model, m.label])).toEqual([
      ['ollama', 'gemma4:12b', 'Gemma 4 (12B Param)']
    ])
  })

  it('treats bare Qwen 3.5 model names as local Ollama usage', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'qwen35-local',
        provider: undefined,
        timestamp: NOW - 90_000,
        model: 'qwen3.5:9b',
        inputTokens: 2_000,
        outputTokens: 500,
        totalTokens: 2_500
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)

    expect(data.modelBreakdown.map((m) => [m.provider, m.model, m.label])).toEqual([
      ['ollama', 'qwen3.5:9b', 'Qwen 3.5 (9B Param)']
    ])
  })

  it('treats bare Ornith model names as local Ollama usage', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'ornith-local',
        provider: undefined,
        timestamp: NOW - 90_000,
        model: 'ornith:35b',
        inputTokens: 2_000,
        outputTokens: 500,
        totalTokens: 2_500
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)

    expect(data.modelBreakdown.map((m) => [m.provider, m.model, m.label])).toEqual([
      ['ollama', 'ornith:35b', 'Ornith 1.0 (35B Param)']
    ])
  })

  it('maps Ollama display brands to their spoofed brand hue class', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'qwen-brand',
        provider: 'ollama',
        timestamp: NOW - 90_000,
        model: 'qwen3.5:9b',
        inputTokens: 4_000,
        outputTokens: 1_000,
        totalTokens: 5_000
      }),
      baseRecord({
        id: 'gemma-brand',
        provider: 'ollama',
        timestamp: NOW - 80_000,
        model: 'gemma4:12b',
        inputTokens: 2_000,
        outputTokens: 500,
        totalTokens: 2_500
      }),
      baseRecord({
        id: 'gptoss-brand',
        provider: 'ollama',
        timestamp: NOW - 70_000,
        model: 'gpt-oss:20b',
        inputTokens: 1_000,
        outputTokens: 200,
        totalTokens: 1_200
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    const byModel = new Map(data.modelBreakdown.map((m) => [m.model, m.colorClass]))

    expect(byModel.get('qwen3.5:9b')).toBe('provider-alibaba')
    expect(byModel.get('gemma4:12b')).toBe('provider-google')
    expect(byModel.get('gpt-oss:20b')).toBe('provider-openai')
  })

  it('falls back to the runtime provider hue class for non-brand models', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'claude-row',
        provider: 'claude',
        timestamp: NOW - 90_000,
        model: 'claude-opus-4-8',
        inputTokens: 4_000,
        outputTokens: 1_000,
        totalTokens: 5_000
      })
    ]

    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    expect(data.modelBreakdown[0]?.colorClass).toBe('provider-claude')
  })

  it('percentages are computed against kept-model tokens, not the lifetime aggregate', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'kept',
        timestamp: NOW - 60_000,
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'dropped',
        timestamp: NOW - 90_000,
        provider: 'claude',
        model: 'default',
        totalTokens: 1_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    // Without rebalancing, this would read ~50%. With the L8 rebalanced
    // denominator (kept-tokens only), the surviving entry reads 100%.
    expect(data.modelBreakdown).toHaveLength(1)
    expect(data.modelBreakdown[0].percent).toBeCloseTo(100, 0)
    expect(data.totalTokens).toBeGreaterThan(1_500) // still counts both runs
  })
})

describe('buildWelcomeUsageDashboardData tokens24h (Welcome L9 hero chip)', () => {
  const NOW = new Date(2026, 4, 22, 12, 0).getTime()

  it('sums tokens only for records within the trailing 24h window', () => {
    const records: UsageRecord[] = [
      // Within window: 2h ago.
      baseRecord({
        id: 'recent',
        timestamp: NOW - 2 * 60 * 60_000,
        provider: 'codex',
        totalTokens: 1_000
      }),
      // Outside window: 25h ago.
      baseRecord({
        id: 'stale',
        timestamp: NOW - 25 * 60 * 60_000,
        provider: 'codex',
        totalTokens: 9_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.tokens24h).toBe(1_000)
  })

  it('is range-independent: same value regardless of dashboard cutoff', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'a',
        timestamp: NOW - 60 * 60_000, // 1h ago
        provider: 'gemini',
        totalTokens: 500
      })
    ]
    const day = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    const week = buildWelcomeUsageDashboardData(records, [], '7d', NOW)
    const all = buildWelcomeUsageDashboardData(records, [], 'all', NOW)
    expect(day.tokens24h).toBe(500)
    expect(week.tokens24h).toBe(500)
    expect(all.tokens24h).toBe(500)
  })

  it('is zero when no records fall inside the trailing 24h window', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old',
        timestamp: NOW - 48 * 60 * 60_000,
        provider: 'claude',
        totalTokens: 4_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.tokens24h).toBe(0)
  })
})

describe('buildWelcomeUsageDashboardData favoriteProject (Welcome L9 hero chip)', () => {
  const NOW = new Date(2026, 4, 22, 12, 0).getTime()
  const workspaces = [
    { id: 'ws-a', displayName: 'Chill-Q' },
    { id: 'ws-b', displayName: 'Guitar Cabs' },
    { id: 'ws-c', displayName: 'TaskWraith' }
  ]

  it('picks the workspace with the most tokens in-window and resolves its displayName', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'a1',
        timestamp: NOW - 60_000,
        workspaceId: 'ws-a',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'b1',
        timestamp: NOW - 90_000,
        workspaceId: 'ws-b',
        totalTokens: 9_000
      }),
      baseRecord({
        id: 'c1',
        timestamp: NOW - 120_000,
        workspaceId: 'ws-c',
        totalTokens: 500
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW, workspaces)
    expect(data.favoriteProject).toBe('Guitar Cabs')
  })

  it('returns "n/a" when no records carry a workspaceId', () => {
    const records: UsageRecord[] = [
      // Override the default workspaceId so the record has no workspace.
      baseRecord({
        id: 'a',
        timestamp: NOW - 60_000,
        workspaceId: undefined as unknown as string,
        totalTokens: 1_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW, workspaces)
    expect(data.favoriteProject).toBe('n/a')
  })

  it('returns "n/a" when the favorite workspaceId is not in the workspaces list', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'a',
        timestamp: NOW - 60_000,
        workspaceId: 'ws-orphan',
        totalTokens: 1_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW, workspaces)
    expect(data.favoriteProject).toBe('n/a')
  })

  it('ignores records outside the dashboard range', () => {
    const records: UsageRecord[] = [
      // Stale (40 days ago): would dominate ws-a if range-unaware.
      baseRecord({
        id: 'stale',
        timestamp: NOW - 40 * 24 * 60 * 60_000,
        workspaceId: 'ws-a',
        totalTokens: 100_000
      }),
      // Recent: small but in-window.
      baseRecord({
        id: 'recent',
        timestamp: NOW - 60_000,
        workspaceId: 'ws-b',
        totalTokens: 500
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW, workspaces)
    expect(data.favoriteProject).toBe('Guitar Cabs')
  })

  it('degrades to "n/a" when called without a workspaces list', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'a',
        timestamp: NOW - 60_000,
        workspaceId: 'ws-a',
        totalTokens: 1_000
      })
    ]
    // No workspaces arg → backstop default `[]` → lookup misses.
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.favoriteProject).toBe('n/a')
  })
})

describe('mixProviderColors', () => {
  const palette = {
    gemini: '#346EEC',
    codex: '#705AFF',
    claude: '#B16105',
    kimi: '#0073E6',
    grok: '#757575',
    cursor: '#8D7312',
    ollama: '#1A8562',
    antigravity: '#308713',
    pi: '#C25E4C'
  } as const

  it('returns empty string when no provider has weight', () => {
    expect(
      mixProviderColors(
        { gemini: 0, codex: 0, claude: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0, pi: 0 },
        palette
      )
    ).toBe('')
  })

  it('returns the single provider color when only one contributes', () => {
    expect(
      mixProviderColors(
        { gemini: 0, codex: 50, claude: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0, pi: 0 },
        palette
      )
    ).toBe('#705AFF')
  })

  it('builds a nested color-mix() expression that references both providers when two contribute', () => {
    const result = mixProviderColors(
      { gemini: 30, codex: 70, claude: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0, pi: 0 },
      palette
    )
    expect(result).toContain('color-mix(in srgb,')
    expect(result).toContain('#346EEC')
    expect(result).toContain('#705AFF')
  })

  it('weights the dominant provider with a higher percentage in the color-mix expression', () => {
    const dominantCodex = mixProviderColors(
      { gemini: 10, codex: 90, claude: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0, pi: 0 },
      palette
    )
    // color-mix(in srgb, <gemini> 10%, <codex> 90%) → codex weight should appear with a high number.
    expect(dominantCodex).toMatch(/#705AFF 9[0-9]%/)
  })
})

describe('formatDashboardDuration (1.0.5-EW44)', () => {
  // The dashboard's stat chip needs a duration formatter that
  // scales smoothly from a sub-second tick all the way to a multi-
  // day cumulative. Verify each tier of the scale + the boundary
  // behaviour that keeps chips reading cleanly.
  it('returns 0s for zero / negative / non-finite inputs', () => {
    expect(formatDashboardDuration(0)).toBe('0s')
    expect(formatDashboardDuration(-100)).toBe('0s')
    expect(formatDashboardDuration(Number.NaN)).toBe('0s')
    expect(formatDashboardDuration(Number.POSITIVE_INFINITY)).toBe('0s')
  })

  it('emits <1s for sub-second durations (avoids misleading "0s")', () => {
    expect(formatDashboardDuration(1)).toBe('<1s')
    expect(formatDashboardDuration(400)).toBe('<1s')
    expect(formatDashboardDuration(999)).toBe('<1s')
  })

  it('emits seconds in the [1s, 1m) range', () => {
    expect(formatDashboardDuration(1000)).toBe('1s')
    expect(formatDashboardDuration(32 * 1000)).toBe('32s')
    expect(formatDashboardDuration(59 * 1000)).toBe('59s')
  })

  it('rolls up to minutes at 60s', () => {
    expect(formatDashboardDuration(60 * 1000)).toBe('1m')
  })

  it('emits "Xm Ys" in the [1m, 1h) range, hiding the seconds tail when it would be zero', () => {
    expect(formatDashboardDuration(12 * 60_000 + 34 * 1000)).toBe('12m 34s')
    expect(formatDashboardDuration(5 * 60_000)).toBe('5m')
    expect(formatDashboardDuration(59 * 60_000 + 59 * 1000)).toBe('59m 59s')
  })

  it('rolls up to hours at 60m', () => {
    expect(formatDashboardDuration(60 * 60_000)).toBe('1h')
  })

  it('emits "Xh Ym" in the [1h, 24h) range, hiding the minutes tail when it would be zero', () => {
    expect(formatDashboardDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m')
    expect(formatDashboardDuration(2 * 3_600_000)).toBe('2h')
    expect(formatDashboardDuration(23 * 3_600_000 + 59 * 60_000)).toBe('23h 59m')
  })

  it('rolls up to days at 24h', () => {
    expect(formatDashboardDuration(24 * 3_600_000)).toBe('1d')
  })

  it('emits "Xd Yh" for multi-day durations, hiding the hours tail when it would be zero', () => {
    expect(formatDashboardDuration(5 * 86_400_000 + 3 * 3_600_000)).toBe('5d 3h')
    expect(formatDashboardDuration(7 * 86_400_000)).toBe('7d')
    // Cumulative-wall-time grows large; verify the formatter handles
    // a realistic upper bound (≈ a year of continuous use).
    expect(formatDashboardDuration(365 * 86_400_000)).toBe('365d')
  })
})

describe('buildWelcomeUsageDashboardData longest-thread + cumulative-wall-time (1.0.5-EW44)', () => {
  const NOW = new Date(2026, 4, 15, 14, 30).getTime()

  it('returns zero for both metrics when there are no usage records', () => {
    const data = buildWelcomeUsageDashboardData([], [], '30d', NOW)
    expect(data.longestThreadMs).toBe(0)
    expect(data.totalWallTimeMs).toBe(0)
  })

  it('picks the maximum durationMs across all records as longestThreadMs', () => {
    const records: UsageRecord[] = [
      baseRecord({ id: 'r1', timestamp: NOW - 1_000_000, durationMs: 5_000 }),
      baseRecord({ id: 'r2', timestamp: NOW - 2_000_000, durationMs: 42_000 }),
      baseRecord({ id: 'r3', timestamp: NOW - 3_000_000, durationMs: 17_000 })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.longestThreadMs).toBe(42_000)
  })

  it('sums durationMs across all records for totalWallTimeMs', () => {
    const records: UsageRecord[] = [
      baseRecord({ id: 'r1', timestamp: NOW - 1_000_000, durationMs: 5_000 }),
      baseRecord({ id: 'r2', timestamp: NOW - 2_000_000, durationMs: 42_000 }),
      baseRecord({ id: 'r3', timestamp: NOW - 3_000_000, durationMs: 17_000 })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.totalWallTimeMs).toBe(5_000 + 42_000 + 17_000)
  })

  it('always uses the LIFETIME record set, never the range-scoped subset (matches longest-streak semantics)', () => {
    // One record well outside the 24h window; if longestThread
    // were range-scoped it would miss this.
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old-marathon',
        timestamp: NOW - 30 * 24 * 3_600_000, // 30 days ago
        durationMs: 10 * 60_000 // 10 minute run
      }),
      baseRecord({ id: 'recent-tiny', timestamp: NOW - 60_000, durationMs: 2_000 })
    ]
    const data24h = buildWelcomeUsageDashboardData(records, [], '24h', NOW)
    expect(data24h.longestThreadMs).toBe(10 * 60_000)
    expect(data24h.totalWallTimeMs).toBe(10 * 60_000 + 2_000)
  })

  it('ignores reset_hint records', () => {
    const records: UsageRecord[] = [
      baseRecord({ id: 'r1', durationMs: 5_000 }),
      baseRecord({
        id: 'reset',
        usageKind: 'reset_hint',
        durationMs: 999_999 // would dominate if not filtered
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.longestThreadMs).toBe(5_000)
    expect(data.totalWallTimeMs).toBe(5_000)
  })

  it('skips records with missing / non-finite / non-positive durationMs', () => {
    const records: UsageRecord[] = [
      baseRecord({ id: 'r1', durationMs: 5_000 }),
      baseRecord({ id: 'r2', durationMs: 0 }),
      baseRecord({ id: 'r3', durationMs: Number.NaN as unknown as number }),
      baseRecord({ id: 'r4', durationMs: -100 as unknown as number })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.longestThreadMs).toBe(5_000)
    // Only the valid 5_000ms contributes — invalid entries don't
    // poison the sum with NaN or shrink it via negative values.
    expect(data.totalWallTimeMs).toBe(5_000)
  })
})

describe('buildWelcomeUsageDashboardData EW49 new stats + global reset', () => {
  const NOW = new Date(2026, 4, 15, 14, 30).getTime()

  it('returns zero for the three new stats when there are no usage records', () => {
    const data = buildWelcomeUsageDashboardData([], [], '30d', NOW)
    expect(data.totalCostUsd).toBe(0)
    expect(data.avgSessionMs).toBe(0)
    expect(data.tokensPerSession).toBe(0)
  })

  it('sums explicitCostUsd across records into totalCostUsd', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        timestamp: NOW - 1_000_000,

        explicitCostUsd: 0.42 as any
      } as never),
      baseRecord({
        id: 'r2',
        timestamp: NOW - 2_000_000,

        explicitCostUsd: 1.58 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.totalCostUsd).toBeCloseTo(2.0, 5)
  })

  it('computes avgSessionMs as totalWallTimeMs / sessions', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        timestamp: NOW - 60_000,
        chatId: 'chat-A',
        durationMs: 10_000
      }),
      baseRecord({
        id: 'r2',
        timestamp: NOW - 30_000,
        chatId: 'chat-B',
        durationMs: 30_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.sessions).toBe(2)
    expect(data.totalWallTimeMs).toBe(40_000)
    expect(data.avgSessionMs).toBe(20_000)
  })

  it('computes tokensPerSession as totalTokens / sessions', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        timestamp: NOW - 60_000,
        chatId: 'chat-A',
        totalTokens: 1_000
      }),
      baseRecord({
        id: 'r2',
        timestamp: NOW - 30_000,
        chatId: 'chat-B',
        totalTokens: 3_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.sessions).toBe(2)
    expect(data.totalTokens).toBe(4_000)
    expect(data.tokensPerSession).toBe(2_000)
  })

  it('avoids divide-by-zero — avgSessionMs and tokensPerSession are 0 when sessions is 0', () => {
    const data = buildWelcomeUsageDashboardData([], [], '30d', NOW)
    expect(data.sessions).toBe(0)
    expect(data.avgSessionMs).toBe(0)
    expect(data.tokensPerSession).toBe(0)
  })

  it('global statResetAt filters records older than the cutoff out of EVERY stat', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old',
        timestamp: NOW - 7 * 24 * 3_600_000,
        chatId: 'chat-old',
        totalTokens: 100_000,
        durationMs: 60_000
      }),
      baseRecord({
        id: 'recent',
        timestamp: NOW - 60_000,
        chatId: 'chat-recent',
        totalTokens: 5_000,
        durationMs: 10_000
      })
    ]
    // Reset 3 days ago → old record dropped, recent kept.
    const resetAt = NOW - 3 * 24 * 3_600_000
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW, [], resetAt)
    expect(data.sessions).toBe(1) // only chat-recent
    expect(data.totalTokens).toBe(5_000)
    expect(data.totalWallTimeMs).toBe(10_000)
    expect(data.longestThreadMs).toBe(10_000)
  })

  it('statResetAt = 0 (or omitted) is the back-compat "include all history" path', () => {
    const records: UsageRecord[] = [
      baseRecord({ id: 'r1', timestamp: NOW - 1_000_000, totalTokens: 100 }),
      baseRecord({ id: 'r2', timestamp: NOW - 2_000_000, totalTokens: 200 })
    ]
    const noReset = buildWelcomeUsageDashboardData(records, [], '30d', NOW, [], 0)
    const omitted = buildWelcomeUsageDashboardData(records, [], '30d', NOW, [])
    expect(noReset.totalTokens).toBe(300)
    expect(omitted.totalTokens).toBe(300)
  })

  it('statResetAt of a future timestamp drops every record (defensive, no NaN)', () => {
    const records: UsageRecord[] = [
      baseRecord({ id: 'r1', timestamp: NOW - 60_000, totalTokens: 1_000 })
    ]
    const data = buildWelcomeUsageDashboardData(
      records,
      [],
      '30d',
      NOW,
      [],
      NOW + 1_000_000 // future cutoff
    )
    expect(data.sessions).toBe(0)
    expect(data.totalTokens).toBe(0)
    expect(data.lifetimeHasActivity).toBe(false)
  })
})

describe('buildWelcomeUsageDashboardData EW51 workspace breakdown + cost chart', () => {
  const NOW = new Date(2026, 4, 15, 14, 30).getTime()
  const DAY = 24 * 60 * 60 * 1000

  it('returns an empty workspace list when there are no records', () => {
    const data = buildWelcomeUsageDashboardData([], [], '30d', NOW)
    expect(data.workspaceCostBreakdown).toEqual([])
  })

  it('groups records by workspaceId + sums tokens and cost', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        timestamp: NOW - 1 * DAY,
        workspaceId: 'ws-A',
        totalTokens: 10_000,

        explicitCostUsd: 0.4 as any
      } as never),
      baseRecord({
        id: 'r2',
        timestamp: NOW - 2 * DAY,
        workspaceId: 'ws-A',
        totalTokens: 5_000,

        explicitCostUsd: 0.1 as any
      } as never),
      baseRecord({
        id: 'r3',
        timestamp: NOW - 3 * DAY,
        workspaceId: 'ws-B',
        totalTokens: 2_000,

        explicitCostUsd: 0.05 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.workspaceCostBreakdown).toHaveLength(2)
    const wsA = data.workspaceCostBreakdown.find((ws) => ws.workspaceId === 'ws-A')
    expect(wsA?.tokens).toBe(15_000)
    expect(wsA?.costUsd).toBeCloseTo(0.5, 5)
    const wsB = data.workspaceCostBreakdown.find((ws) => ws.workspaceId === 'ws-B')
    expect(wsB?.tokens).toBe(2_000)
    expect(wsB?.costUsd).toBeCloseTo(0.05, 5)
  })

  it('sorts workspaces DESC by cost with tokens as tiebreaker', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        workspaceId: 'small-cost',
        totalTokens: 50_000,

        explicitCostUsd: 0.01 as any
      } as never),
      baseRecord({
        id: 'r2',
        workspaceId: 'big-cost',
        totalTokens: 1_000,

        explicitCostUsd: 5.0 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.workspaceCostBreakdown[0].workspaceId).toBe('big-cost')
    expect(data.workspaceCostBreakdown[1].workspaceId).toBe('small-cost')
  })

  it('resolves displayName from the workspaces input or falls back to "No workspace" / raw id', () => {
    const records: UsageRecord[] = [
      baseRecord({ id: 'r1', workspaceId: 'ws-known', totalTokens: 100 }),
      baseRecord({ id: 'r2', workspaceId: 'ws-unknown', totalTokens: 200 }),
      baseRecord({ id: 'r3', workspaceId: undefined as unknown as string, totalTokens: 300 })
    ]
    const workspaces = [{ id: 'ws-known', displayName: 'Known Repo' }]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW, workspaces)
    const known = data.workspaceCostBreakdown.find((ws) => ws.workspaceId === 'ws-known')
    const unknown = data.workspaceCostBreakdown.find((ws) => ws.workspaceId === 'ws-unknown')
    const none = data.workspaceCostBreakdown.find((ws) => ws.workspaceId === '__no_workspace')
    expect(known?.displayName).toBe('Known Repo')
    expect(unknown?.displayName).toBe('ws-unknown')
    expect(none?.displayName).toBe('No workspace')
  })

  it('humanises the __taskwraith_global_chats__ sentinel as "General Chat"', () => {
    // 1.0.5-EW51 follow-up. The internal sentinel workspaceId
    // for global-scope runs (used by GeminiApiProvider +
    // AppStore.recordUsage) shouldn't leak through to the
    // user-facing card. This test pins the contract so a
    // future rename of the sentinel would fail loudly.
    const records: UsageRecord[] = [
      baseRecord({
        id: 'global-1',
        workspaceId: '__taskwraith_global_chats__',
        totalTokens: 5_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    const row = data.workspaceCostBreakdown.find(
      (ws) => ws.workspaceId === '__taskwraith_global_chats__'
    )
    expect(row?.displayName).toBe('General Chat')
  })

  it('humanises AGBench-era global chat sentinels as "Legacy Global Chats"', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'legacy-global-1',
        workspaceId: '__agentbench_global_chats__',
        totalTokens: 5_000
      }),
      baseRecord({
        id: 'legacy-global-2',
        workspaceId: '_agentbench_global_chats_',
        totalTokens: 4_000
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    const doubleUnderscoreRow = data.workspaceCostBreakdown.find(
      (ws) => ws.workspaceId === '__agentbench_global_chats__'
    )
    const singleUnderscoreRow = data.workspaceCostBreakdown.find(
      (ws) => ws.workspaceId === '_agentbench_global_chats_'
    )
    expect(doubleUnderscoreRow?.displayName).toBe('Legacy Global Chats')
    expect(singleUnderscoreRow?.displayName).toBe('Legacy Global Chats')
  })

  it('computes shareOfTotalCost as a percentage of all-workspace cost (or 0 when totalCost is 0)', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        workspaceId: 'ws-A',

        explicitCostUsd: 0.6 as any
      } as never),
      baseRecord({
        id: 'r2',
        workspaceId: 'ws-B',

        explicitCostUsd: 0.4 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    const wsA = data.workspaceCostBreakdown.find((ws) => ws.workspaceId === 'ws-A')
    const wsB = data.workspaceCostBreakdown.find((ws) => ws.workspaceId === 'ws-B')
    expect(wsA?.shareOfTotalCost).toBeCloseTo(60, 1)
    expect(wsB?.shareOfTotalCost).toBeCloseTo(40, 1)

    // Zero-total case: every entry has 0 share rather than NaN.
    const noneCostRecord = baseRecord({
      id: 'rZ',
      workspaceId: 'ws-A',
      totalTokens: 1_000
      // no explicitCostUsd
    })
    const noCostData = buildWelcomeUsageDashboardData([noneCostRecord], [], '30d', NOW)
    expect(noCostData.workspaceCostBreakdown[0].shareOfTotalCost).toBe(0)
  })

  it('emits exactly 30 daily-cost buckets in chronological order (oldest first)', () => {
    const data = buildWelcomeUsageDashboardData([], [], '30d', NOW)
    expect(data.dailyCostBreakdown).toHaveLength(30)
    // First entry should be ~29 days ago; last entry is today.
    const firstDay = new Date(data.dailyCostBreakdown[0].dayKey + 'T00:00:00').getTime()
    const lastDay = new Date(
      data.dailyCostBreakdown[data.dailyCostBreakdown.length - 1].dayKey + 'T00:00:00'
    ).getTime()
    expect(lastDay).toBeGreaterThan(firstDay)
    // ~29 days between first and last
    const diffDays = Math.round((lastDay - firstDay) / DAY)
    expect(diffDays).toBe(29)
  })

  it('zero-fills days with no activity', () => {
    const records: UsageRecord[] = [
      // Single record today only.
      baseRecord({
        id: 'r1',
        timestamp: NOW,
        totalTokens: 1_000,

        explicitCostUsd: 0.05 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    const today = data.dailyCostBreakdown[data.dailyCostBreakdown.length - 1]
    expect(today.tokens).toBe(1_000)
    expect(today.costUsd).toBeCloseTo(0.05, 5)
    // Every other day in the window is zeroed.
    for (let i = 0; i < data.dailyCostBreakdown.length - 1; i++) {
      expect(data.dailyCostBreakdown[i].tokens).toBe(0)
      expect(data.dailyCostBreakdown[i].costUsd).toBe(0)
    }
  })

  it('drops records older than 30 days from the daily chart (but still contributes to workspace lifetime totals)', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'old',
        timestamp: NOW - 60 * DAY,
        workspaceId: 'ws-A',
        totalTokens: 100_000,

        explicitCostUsd: 5.0 as any
      } as never),
      baseRecord({
        id: 'recent',
        timestamp: NOW - 5 * DAY,
        workspaceId: 'ws-A',
        totalTokens: 1_000,

        explicitCostUsd: 0.1 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    // Workspace tally includes both records.
    const wsA = data.workspaceCostBreakdown[0]
    expect(wsA.tokens).toBe(101_000)
    expect(wsA.costUsd).toBeCloseTo(5.1, 5)
    // Daily chart only sees the recent record.
    const chartTotal = data.dailyCostBreakdown.reduce((sum, day) => sum + day.costUsd, 0)
    expect(chartTotal).toBeCloseTo(0.1, 5)
  })
})

describe('buildWelcomeUsageDashboardData EW52 provider breakdown + 24H wall time', () => {
  const NOW = new Date(2026, 4, 15, 14, 30).getTime()
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR

  it('always emits 9 canonical providers in cost breakdown, even with no records', () => {
    const data = buildWelcomeUsageDashboardData([], [], '30d', NOW)
    expect(data.providerCostBreakdown).toHaveLength(9)
    const providers = data.providerCostBreakdown.map((entry) => entry.provider).sort()
    expect(providers).toEqual([
      'antigravity',
      'claude',
      'codex',
      'cursor',
      'gemini',
      'grok',
      'kimi',
      'ollama',
      'pi'
    ])
    // Zero-token / zero-cost providers still appear with the canonical
    // display name and 0 share so the card list is a stable roster.
    for (const entry of data.providerCostBreakdown) {
      expect(entry.tokens).toBe(0)
      expect(entry.costUsd).toBe(0)
      expect(entry.shareOfTotalCost).toBe(0)
      expect(entry.shareOfTotalTokens).toBe(0)
    }
  })

  it('sums tokens + cost per provider from records', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        provider: 'codex',
        totalTokens: 12_000,

        explicitCostUsd: 0.6 as any
      } as never),
      baseRecord({
        id: 'r2',
        provider: 'codex',
        totalTokens: 4_000,

        explicitCostUsd: 0.2 as any
      } as never),
      baseRecord({
        id: 'r3',
        provider: 'claude',
        totalTokens: 8_000,

        explicitCostUsd: 0.3 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    const codex = data.providerCostBreakdown.find((p) => p.provider === 'codex')
    const claude = data.providerCostBreakdown.find((p) => p.provider === 'claude')
    const gemini = data.providerCostBreakdown.find((p) => p.provider === 'gemini')
    expect(codex?.tokens).toBe(16_000)
    expect(codex?.costUsd).toBeCloseTo(0.8, 5)
    expect(claude?.tokens).toBe(8_000)
    expect(claude?.costUsd).toBeCloseTo(0.3, 5)
    // Gemini sees no records this run — still in the roster at 0.
    expect(gemini?.tokens).toBe(0)
    expect(gemini?.costUsd).toBe(0)
  })

  it('includes Grok and Cursor records in provider breakdown totals', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'grok',
        provider: 'grok',
        totalTokens: 1_500,
        explicitCostUsd: 0.003 as any
      } as never),
      baseRecord({
        id: 'cursor',
        provider: 'cursor',
        totalTokens: 2_500,
        explicitCostUsd: 0.004 as any
      } as never)
    ]

    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)

    expect(data.providerCostBreakdown.find((p) => p.provider === 'grok')?.tokens).toBe(1_500)
    expect(data.providerCostBreakdown.find((p) => p.provider === 'cursor')?.tokens).toBe(2_500)
  })

  it('sorts provider breakdown DESC by tokens (cost as tiebreaker)', () => {
    // EW52 follow-up — Sort key flipped from cost-first to
    // tokens-first to match the under-card meter, which now
    // shows token share. Cost stays as the tiebreaker so two
    // providers with identical token totals get a stable order.
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        provider: 'gemini',
        totalTokens: 92_000_000,

        explicitCostUsd: 0 as any
      } as never),
      baseRecord({
        id: 'r2',
        provider: 'kimi',
        totalTokens: 1_300_000,

        explicitCostUsd: 1.2 as any
      } as never),
      baseRecord({
        id: 'r3',
        provider: 'codex',
        totalTokens: 6_700_000,

        explicitCostUsd: 0.4 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    // Sorted DESC by tokens: gemini (92M) > codex (6.7M) > kimi (1.3M) > zero-token providers.
    // Even though Kimi has the highest cost, Gemini's much larger
    // token total puts it on top — this matches the visual meter.
    expect(data.providerCostBreakdown[0].provider).toBe('gemini')
    expect(data.providerCostBreakdown[1].provider).toBe('codex')
    expect(data.providerCostBreakdown[2].provider).toBe('kimi')
    expect(data.providerCostBreakdown[3].provider).toBe('antigravity')
    expect(data.providerCostBreakdown[4].provider).toBe('claude')
  })

  it('computes shareOfTotalTokens as a percentage of all-provider tokens (drives the under-card meter)', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        provider: 'gemini',
        totalTokens: 90_000_000,

        explicitCostUsd: 0 as any
      } as never),
      baseRecord({
        id: 'r2',
        provider: 'codex',
        totalTokens: 10_000_000,

        explicitCostUsd: 5 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    const gemini = data.providerCostBreakdown.find((p) => p.provider === 'gemini')
    const codex = data.providerCostBreakdown.find((p) => p.provider === 'codex')
    const claude = data.providerCostBreakdown.find((p) => p.provider === 'claude')
    // Gemini has 0 cost but 90% of tokens — meter should reflect
    // 90%, NOT the 0% it would show under share-of-cost.
    expect(gemini?.shareOfTotalTokens).toBeCloseTo(90, 1)
    expect(gemini?.shareOfTotalCost).toBe(0)
    expect(codex?.shareOfTotalTokens).toBeCloseTo(10, 1)
    // Zero-token providers stay at 0% share.
    expect(claude?.shareOfTotalTokens).toBe(0)
  })

  it('computes shareOfTotalCost as a percentage of all-provider cost (or 0 when total is 0)', () => {
    const records: UsageRecord[] = [
      baseRecord({
        id: 'r1',
        provider: 'codex',

        explicitCostUsd: 0.75 as any
      } as never),
      baseRecord({
        id: 'r2',
        provider: 'claude',

        explicitCostUsd: 0.25 as any
      } as never)
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    const codex = data.providerCostBreakdown.find((p) => p.provider === 'codex')
    const claude = data.providerCostBreakdown.find((p) => p.provider === 'claude')
    expect(codex?.shareOfTotalCost).toBeCloseTo(75, 1)
    expect(claude?.shareOfTotalCost).toBeCloseTo(25, 1)
    // Zero-cost providers share = 0.
    const gemini = data.providerCostBreakdown.find((p) => p.provider === 'gemini')
    expect(gemini?.shareOfTotalCost).toBe(0)
  })

  it('sums wallTime24hMs from durationMs within the rolling 24-hour window', () => {
    const records: UsageRecord[] = [
      // Inside the 24h window — counted.
      baseRecord({
        id: 'recent-1',
        timestamp: NOW - 2 * HOUR,
        durationMs: 90_000 // 1m 30s
      }),
      baseRecord({
        id: 'recent-2',
        timestamp: NOW - 12 * HOUR,
        durationMs: 30_000 // 30s
      }),
      // Outside the 24h window — NOT counted, even though it's still
      // within the 30-day chart window.
      baseRecord({
        id: 'old',
        timestamp: NOW - 5 * DAY,
        durationMs: 600_000 // 10m, should not count
      })
    ]
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW)
    expect(data.wallTime24hMs).toBe(120_000) // 90s + 30s
  })

  it('uses raw record timestamps for the 24h window even when statResetAt is later (24h is a rolling slice, not a personal-best metric)', () => {
    // The reset cutoff applies to lifetime-from-reset stats (cost
    // breakdown, totals), but the 24h wall-time timecode is meant
    // as a "what happened in the last 24h" pulse — so it's
    // independent of the reset.
    const records: UsageRecord[] = [
      baseRecord({
        id: 'pre-reset-but-recent',
        timestamp: NOW - 1 * HOUR,
        durationMs: 60_000
      })
    ]
    const RESET_AT = NOW - 30 * 60 * 1000 // reset 30 min ago
    const data = buildWelcomeUsageDashboardData(records, [], '30d', NOW, [], RESET_AT)
    // Record is older than the reset, so workspace / provider
    // breakdowns drop it, but wallTime24hMs still picks it up.
    expect(data.wallTime24hMs).toBe(60_000)
  })

  it('emits 0 wallTime24hMs and zeroed provider breakdown when no records exist', () => {
    const data = buildWelcomeUsageDashboardData([], [], '30d', NOW)
    expect(data.wallTime24hMs).toBe(0)
    for (const entry of data.providerCostBreakdown) {
      expect(entry.tokens).toBe(0)
      expect(entry.costUsd).toBe(0)
    }
  })
})

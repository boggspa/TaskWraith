import { describe, expect, it } from 'vitest'
import type { ChatRecord, UsageRecord } from '../../../main/store/types'
import {
  MODEL_USAGE_PROVIDER_ORDER,
  MODEL_USAGE_WINDOW_MS,
  MODEL_USAGE_WINDOW_ORDER,
  buildModelUsageTable,
  buildModelUsageTableForSettings,
  buildModelUsageWorkspaceMatrix,
  sumModelUsageProviderTotals,
  type ModelUsageTableOptions
} from './modelUsageTable'
import { HEATMAP_PROVIDER_COLOR_HEX } from './UsageHeatmap'
import { getFxRatesPerUsd, setFxRatesPerUsd } from './formatCost'
import type { RendererProviderRates } from './providerRateEstimate'

// Fixed reference clock so every window boundary is exact.
const NOW = new Date('2026-06-13T12:00:00.000Z').getTime()

// $1/M in, $10/M out for codex; $5/M in, $25/M out for claude — round numbers
// make the cost assertions obvious. Cursor ships no public rate.
const RATES: RendererProviderRates = {
  codex: [{ modelId: 'gpt-5.5', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }],
  claude: [{ modelId: 'opus', inputUsdPerMillion: 5, outputUsdPerMillion: 25 }],
  cursor: [{ modelId: 'composer-2.5-fast', inputUsdPerMillion: 3, outputUsdPerMillion: 15 }]
}

function makeChat(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    id: overrides.appChatId || 'chat-1',
    appChatId: overrides.appChatId || 'chat-1',
    title: 'Chat',
    provider: 'codex',
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    scope: 'workspace',
    chatKind: 'single',
    workspaceId: 'ws-1',
    workspacePath: '/repo/alpha',
    ...overrides
  } as ChatRecord
}

function makeRecord(overrides: Partial<UsageRecord> & { timestamp: number }): UsageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    workspaceId: 'ws-1',
    chatId: 'chat-1',
    runId: 'run-1',
    model: 'gpt-5.5',
    provider: 'codex',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  } as UsageRecord
}

/** Always force USD so conversion tests don't depend on a hot-swapped FX map. */
const USD: ModelUsageTableOptions = { currency: 'USD' }

// Readable relative-timestamp helpers.
function HOURS(n: number): number {
  return n * 60 * 60 * 1000
}
function DAYS(n: number): number {
  return n * 24 * 60 * 60 * 1000
}

describe('MODEL_USAGE_PROVIDER_ORDER', () => {
  // This list is an `allowed` FILTER — a provider missing from it has its
  // records dropped, so drift here makes real spend invisible rather than
  // merely misordered (antigravity and pi were both silently absent). The
  // colour map is Record<ProviderId, string>, so the compiler keeps it
  // complete; anchoring to it makes a tenth provider fail here.
  const ALL_PROVIDER_IDS = Object.keys(HEATMAP_PROVIDER_COLOR_HEX)

  it('covers every provider except ollama, the one deliberate exclusion', () => {
    const covered = [...MODEL_USAGE_PROVIDER_ORDER, 'ollama'].sort()
    expect(covered).toEqual([...ALL_PROVIDER_IDS].sort())
  })

  it('excludes ollama, which is reported as RAM rows rather than token spend', () => {
    expect(MODEL_USAGE_PROVIDER_ORDER).not.toContain('ollama')
  })

  it('lists each provider exactly once', () => {
    expect(new Set(MODEL_USAGE_PROVIDER_ORDER).size).toBe(MODEL_USAGE_PROVIDER_ORDER.length)
  })

  // Regression: both were outside the allowed set, so these records produced no
  // group at all — spend invisible rather than merely unpriced.
  it.each([
    ['antigravity', 'gemini-api:gemini-2.5-flash'],
    ['pi', 'deepseek/deepseek-v4-flash']
  ] as const)('surfaces %s usage as a priced group', (provider, model) => {
    const groups = buildModelUsageTable(
      [
        makeRecord({
          timestamp: NOW - HOURS(1),
          provider,
          model,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000
        })
      ],
      [],
      { [provider]: [{ modelId: model, inputUsdPerMillion: 2, outputUsdPerMillion: 4 }] },
      USD,
      NOW
    )

    const group = groups.find((entry) => entry.provider === provider)
    expect(group).toBeDefined()
    expect(group?.models[0].model).toBe(model)
    expect(group?.models[0].windows.h24.totalTokens).toBe(2_000_000)
    expect(group?.models[0].windows.h24.costUsd).toBeCloseTo(6, 6)
  })
})

describe('buildModelUsageTable — empty / zero / exclusions', () => {
  it('returns an empty array when there are no records', () => {
    expect(buildModelUsageTable([], [], RATES, USD, NOW)).toEqual([])
  })

  it('omits ollama from the token/cost roster (handled via RAM aggregation)', () => {
    const records = [
      makeRecord({ provider: 'ollama', timestamp: NOW - 1000, inputTokens: 1000 })
    ]
    expect(buildModelUsageTable(records, [], RATES, USD, NOW)).toEqual([])
  })

  it('includes grok token runs in the priced roster', () => {
    const records = [
      makeRecord({
        provider: 'grok',
        model: 'grok-build',
        timestamp: NOW - 1000,
        inputTokens: 1000,
        outputTokens: 500
      })
    ]
    const [grok] = buildModelUsageTable(records, [], RATES, USD, NOW)
    expect(grok.provider).toBe('grok')
    expect(grok.totals.d90.totalTokens).toBe(1500)
  })

  it('skips reset_hint records entirely', () => {
    const records = [
      makeRecord({ timestamp: NOW - 1000, inputTokens: 5000, usageKind: 'reset_hint' })
    ]
    expect(buildModelUsageTable(records, [], RATES, USD, NOW)).toEqual([])
  })

  it('projects Cursor cost via the Composer 2.5 Fast proxy rate', () => {
    const records = [
      makeRecord({
        provider: 'cursor',
        model: 'composer',
        timestamp: NOW - 1000,
        inputTokens: 10_000,
        outputTokens: 5000
      })
    ]
    const [cursor] = buildModelUsageTable(records, [], RATES, USD, NOW)
    expect(cursor.provider).toBe('cursor')
    expect(cursor.models).toHaveLength(1)
    expect(cursor.models[0].model).toBe('composer-2.5-fast')
    expect(cursor.models[0].windows.h1.totalTokens).toBe(15_000)
    expect(cursor.models[0].windows.h1.costUsd).toBeCloseTo(0.105, 6)
    expect(cursor.models[0].windows.h1.costDisplay).toBe('$0.11')
    expect(cursor.totals.h1.totalTokens).toBe(15_000)
    expect(cursor.totals.h1.costDisplay).toBe('$0.11')
  })

  it('buckets a blank model id under a provider-named fallback row', () => {
    const records = [
      makeRecord({ provider: 'codex', model: '', timestamp: NOW - 1000, inputTokens: 1_000_000 })
    ]
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    expect(codex.models).toHaveLength(1)
    expect(codex.models[0].model).toBe('codex')
  })
})

describe('buildModelUsageTable — window bucketing at exact boundaries (injected now)', () => {
  it('counts a record exactly at each window boundary inclusively', () => {
    // One record sitting exactly on each window's lower edge.
    const records = MODEL_USAGE_WINDOW_ORDER.map((key) =>
      makeRecord({ timestamp: NOW - MODEL_USAGE_WINDOW_MS[key], inputTokens: 1 })
    )
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    const row = codex.models[0].windows
    // h1 boundary record only lands in every window (it's the freshest);
    // each wider window also captures all the records at/after its edge.
    // Count expectations: h1=1 (only the 1H-edge record),
    // h24=2 (1H + 24H edges), d7=3, d30=4, d90=5.
    expect(row.h1.runs).toBe(1)
    expect(row.h24.runs).toBe(2)
    expect(row.d7.runs).toBe(3)
    expect(row.d30.runs).toBe(4)
    expect(row.d90.runs).toBe(5)
  })

  it('drops a record one ms older than the 1H boundary from the 1H column only', () => {
    const records = [
      makeRecord({ timestamp: NOW - MODEL_USAGE_WINDOW_MS.h1 - 1, inputTokens: 1_000_000 })
    ]
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    const row = codex.models[0].windows
    expect(row.h1.runs).toBe(0)
    expect(row.h1.totalTokens).toBe(0)
    expect(row.h24.runs).toBe(1)
    expect(row.d90.runs).toBe(1)
  })

  it('counts a record exactly at the 24H boundary in 24H+ but not 1H', () => {
    const records = [
      makeRecord({ timestamp: NOW - MODEL_USAGE_WINDOW_MS.h24, inputTokens: 1_000_000 })
    ]
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    const row = codex.models[0].windows
    expect(row.h1.runs).toBe(0)
    expect(row.h24.runs).toBe(1)
    expect(row.d7.runs).toBe(1)
    expect(row.d90.runs).toBe(1)
  })

  it('counts a record exactly at the 90D boundary in 90D only', () => {
    const records = [
      makeRecord({ timestamp: NOW - MODEL_USAGE_WINDOW_MS.d90, inputTokens: 3_000_000 })
    ]
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    const row = codex.models[0].windows
    expect(row.h1.runs).toBe(0)
    expect(row.h24.runs).toBe(0)
    expect(row.d7.runs).toBe(0)
    expect(row.d30.runs).toBe(0)
    expect(row.d90.runs).toBe(1)
    expect(row.d90.tokensIn).toBe(3_000_000)
  })

  it('drops a record one ms older than the 90D boundary from every window', () => {
    const records = [
      makeRecord({ timestamp: NOW - MODEL_USAGE_WINDOW_MS.d90 - 1, inputTokens: 9_000_000 })
    ]
    expect(buildModelUsageTable(records, [], RATES, USD, NOW)).toEqual([])
  })

  it('drops future-dated (clock-skew) records', () => {
    const records = [makeRecord({ timestamp: NOW + 60_000, inputTokens: 1_000_000 })]
    expect(buildModelUsageTable(records, [], RATES, USD, NOW)).toEqual([])
  })
})

describe('buildModelUsageTable — per-model grouping', () => {
  it('splits one provider into separate rows per model, busiest first', () => {
    const records = [
      // gpt-5.5: 1M in fresh
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - HOURS(2),
        inputTokens: 1_000_000
      }),
      // gpt-5.5-mini: 5M in fresh (busier on the d90 axis)
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5-mini',
        timestamp: NOW - HOURS(2),
        inputTokens: 5_000_000
      })
    ]
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    expect(codex.models.map((m) => m.model)).toEqual(['gpt-5.5-mini', 'gpt-5.5'])
    // Provider roll-up sums both models.
    expect(codex.totals.h24.tokensIn).toBe(6_000_000)
    expect(codex.totals.h24.runs).toBe(2)
  })

  it('sums multiple runs of the same model into one row across the right windows', () => {
    const records = [
      makeRecord({ timestamp: NOW - HOURS(2), inputTokens: 1_000_000 }), // 24h..90d
      makeRecord({ timestamp: NOW - DAYS(3), inputTokens: 2_000_000 }), // 7d..90d
      makeRecord({ timestamp: NOW - DAYS(45), inputTokens: 4_000_000 }) // 90d only
    ]
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    expect(codex.models).toHaveLength(1)
    const row = codex.models[0].windows
    expect(row.h1.runs).toBe(0) // 2h-old run is past the 1H edge
    expect(row.h24.costUsd).toBeCloseTo(1, 6)
    expect(row.d7.costUsd).toBeCloseTo(3, 6) // $1 + $2
    expect(row.d30.costUsd).toBeCloseTo(3, 6) // 45d run not in 30d
    expect(row.d90.costUsd).toBeCloseTo(7, 6) // $1 + $2 + $4
    expect(row.d90.runs).toBe(3)
  })

  it('returns providers in canonical order with independent windows', () => {
    const records = [
      makeRecord({
        provider: 'claude',
        model: 'opus',
        timestamp: NOW - HOURS(1),
        outputTokens: 1_000_000 // $25
      }),
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - HOURS(1),
        inputTokens: 1_000_000 // $1
      })
    ]
    const result = buildModelUsageTable(records, [], RATES, USD, NOW)
    // Canonical: gemini, codex, claude, kimi, cursor → codex before claude.
    expect(result.map((g) => g.provider)).toEqual(['codex', 'claude'])
    const claude = result.find((g) => g.provider === 'claude')!
    expect(claude.models[0].windows.h24.costUsd).toBeCloseTo(25, 6)
    expect(claude.models[0].windows.h24.tokensOut).toBe(1_000_000)
  })
})

describe('buildModelUsageTable — cost math + token flooring', () => {
  it('prices input + output via the rate table and formats the display', () => {
    // 2M in * $1/M = $2 ; 0.5M out * $10/M = $5 ; total $7.
    const records = [
      makeRecord({ timestamp: NOW - 1000, inputTokens: 2_000_000, outputTokens: 500_000 })
    ]
    const [codex] = buildModelUsageTable(records, [], RATES, USD, NOW)
    const row = codex.models[0].windows.h1
    expect(row.costUsd).toBeCloseTo(7, 6)
    expect(row.tokensIn).toBe(2_000_000)
    expect(row.tokensOut).toBe(500_000)
    expect(row.totalTokens).toBe(2_500_000)
    expect(row.costDisplay).toBe('$7.00')
  })

  it('prefers an explicit cost over the rate estimate when present', () => {
    const record = makeRecord({ timestamp: NOW - 1000, inputTokens: 1_000_000 })
    ;(record as unknown as Record<string, unknown>).explicitCostUsd = 42
    const [codex] = buildModelUsageTable([record], [], RATES, USD, NOW)
    expect(codex.models[0].windows.h1.costUsd).toBe(42)
  })

  it('floors negative / NaN token counts to zero on a record that still has usage', () => {
    const [codex] = buildModelUsageTable(
      [makeRecord({ timestamp: NOW - 1000, inputTokens: -5 as number, outputTokens: 1_000_000 })],
      [],
      RATES,
      USD,
      NOW
    )
    const row = codex.models[0].windows.h1
    expect(row.tokensIn).toBe(0) // -5 floored to 0
    expect(row.tokensOut).toBe(1_000_000)
  })

  it('drops a record whose tokens all floor to zero (no-usage, like a scanner marker)', () => {
    const empty = buildModelUsageTable(
      [
        makeRecord({
          timestamp: NOW - 1000,
          inputTokens: -5 as number,
          outputTokens: NaN as number
        })
      ],
      [],
      RATES,
      USD,
      NOW
    )
    expect(empty).toEqual([])
  })
})

describe('buildModelUsageWorkspaceMatrix', () => {
  it('selects the seven busiest workspaces and groups model rows by provider', () => {
    const records = Array.from({ length: 8 }, (_, index) =>
      makeRecord({
        id: `r-${index}`,
        workspaceId: `ws-${index}`,
        chatId: `chat-${index}`,
        runId: `run-${index}`,
        timestamp: NOW - 1000,
        inputTokens: (index + 1) * 1000,
        outputTokens: 0
      })
    )
    const chats = records.map((record) =>
      makeChat({
        appChatId: record.chatId,
        workspaceId: record.workspaceId,
        workspacePath: `/workspaces/project-${record.workspaceId}`
      })
    )
    const matrix = buildModelUsageWorkspaceMatrix(records, [], chats, RATES, USD, NOW)

    expect(matrix.workspaces).toHaveLength(7)
    expect(matrix.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      'ws-7',
      'ws-6',
      'ws-5',
      'ws-4',
      'ws-3',
      'ws-2',
      'ws-1'
    ])
    expect(matrix.workspaces[0].label).toBe('project-ws-7')
    expect(matrix.groups.map((group) => group.provider)).toEqual(['codex'])
    expect(matrix.groups[0].models[0].model).toBe('gpt-5.5')
    expect(matrix.groups[0].models[0].workspaces['ws-7'].totalTokens).toBe(8000)
  })

  it('joins chat run diffs into changed-file counts for matching usage records', () => {
    const records = [
      makeRecord({
        workspaceId: 'ws-alpha',
        chatId: 'chat-alpha',
        runId: 'run-alpha',
        timestamp: NOW - 1000,
        inputTokens: 1000,
        outputTokens: 500
      })
    ]
    const chats = [
      makeChat({
        appChatId: 'chat-alpha',
        workspaceId: 'ws-alpha',
        workspacePath: '/repo/alpha',
        runs: [
          {
            runId: 'run-alpha',
            startedAt: new Date(NOW - 2000).toISOString(),
            runDiff: {
              runId: 'run-alpha',
              preSnapshot: { capturedAt: 't', isGitRepo: true },
              createdFiles: [
                { path: 'a.ts', status: 'created', previewKind: 'git_diff' }
              ],
              modifiedFiles: [
                { path: 'b.ts', status: 'modified', previewKind: 'git_diff' }
              ],
              deletedFiles: [],
              preExistingFiles: []
            }
          }
        ]
      })
    ]

    const matrix = buildModelUsageWorkspaceMatrix(records, [], chats, RATES, USD, NOW)
    expect(matrix.workspaces[0]).toMatchObject({
      workspaceId: 'ws-alpha',
      label: 'alpha',
      changedFiles: 2,
      runs: 1,
      totalTokens: 1500
    })
    expect(matrix.groups[0].models[0].workspaces['ws-alpha']).toMatchObject({
      changedFiles: 2,
      runs: 1,
      totalTokens: 1500
    })
  })

  it('dedupes cache-blind external Cursor activity while displaying processed input', () => {
    const ts = NOW - HOURS(1)
    const internal = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        workspaceId: 'ws-alpha',
        timestamp: ts,
        inputTokens: 8_129,
        cacheReadInputTokens: 29_056,
        cacheCreationInputTokens: 12,
        outputTokens: 834,
        totalTokens: 38_031
      })
    ]
    const external = [
      makeRecord({
        id: 'external-cursor-dup',
        provider: 'cursor',
        model: 'composer-2.5-fast',
        workspaceId: 'external',
        timestamp: ts + 30_000,
        inputTokens: 8_129,
        outputTokens: 834,
        totalTokens: 8_963
      })
    ]
    const chats = [
      makeChat({
        appChatId: 'chat-1',
        workspaceId: 'ws-alpha',
        workspacePath: '/repo/alpha'
      })
    ]

    const matrix = buildModelUsageWorkspaceMatrix(
      internal,
      external,
      chats,
      RATES,
      { ...USD, includeExternal: true },
      NOW
    )

    expect(matrix.workspaces).toHaveLength(1)
    expect(matrix.workspaces[0]).toMatchObject({
      workspaceId: 'ws-alpha',
      runs: 1,
      totalTokens: 38_031
    })
  })

  it('keeps private-home TaskWraith Codex usage alongside external Codex activity', () => {
    const internal = [
      makeRecord({
        workspaceId: 'ws-alpha',
        timestamp: NOW - HOURS(1),
        inputTokens: 1_000_000
      })
    ]
    const external = [
      makeRecord({
        id: 'external-codex',
        workspaceId: 'external',
        chatId: '',
        runId: '',
        timestamp: NOW - HOURS(2),
        inputTokens: 2_000_000
      })
    ]
    const chats = [
      makeChat({
        appChatId: 'chat-1',
        workspaceId: 'ws-alpha',
        workspacePath: '/repo/alpha'
      })
    ]

    const matrix = buildModelUsageWorkspaceMatrix(
      internal,
      external,
      chats,
      RATES,
      { ...USD, includeExternal: true },
      NOW
    )

    expect(matrix.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      'external',
      'ws-alpha'
    ])
    const codex = matrix.groups.find((group) => group.provider === 'codex')!
    expect(codex.totals.external.totalTokens).toBe(2_000_000)
    expect(codex.totals['ws-alpha'].totalTokens).toBe(1_000_000)
  })
})

describe('buildModelUsageTable — currency conversion + overestimate', () => {
  it('converts USD to the display currency at the FX rate', () => {
    const before = getFxRatesPerUsd()
    setFxRatesPerUsd({ GBP: 0.8 })
    try {
      const records = [makeRecord({ timestamp: NOW - 1000, inputTokens: 10_000_000 })] // $10
      const [codex] = buildModelUsageTable(records, [], RATES, { currency: 'GBP' }, NOW)
      const row = codex.models[0].windows.h1
      expect(row.costUsd).toBeCloseTo(10, 6) // raw stays USD
      expect(row.costDisplay).toBe('£8.00') // 10 * 0.8
    } finally {
      setFxRatesPerUsd(before)
    }
  })

  it('applies the overestimate multiplier before FX conversion, clamped to 25%', () => {
    const before = getFxRatesPerUsd()
    setFxRatesPerUsd({ USD: 1 })
    try {
      const records = [makeRecord({ timestamp: NOW - 1000, inputTokens: 10_000_000 })] // $10
      const [codex] = buildModelUsageTable(
        records,
        [],
        RATES,
        { currency: 'USD', overestimatePercent: 999 },
        NOW
      )
      const row = codex.models[0].windows.h1
      expect(row.costUsd).toBeCloseTo(10, 6) // raw unbiased
      expect(row.costDisplay).toBe('$12.50') // 999% clamps to 25% → $12.50
    } finally {
      setFxRatesPerUsd(before)
    }
  })
})

describe('buildModelUsageTable — External Usage switches source (no double-count)', () => {
  const internal = [
    makeRecord({
      provider: 'codex',
      model: 'gpt-5.5',
      timestamp: NOW - HOURS(2),
      inputTokens: 1_000_000 // $1
    })
  ]
  const external = [
    // The SAME run TaskWraith executed, ALSO captured by the external CLI-
    // session scan (we spawn the real codex CLI). Summing would double-count it.
    makeRecord({
      id: 'external-codex-dup',
      provider: 'codex',
      model: 'gpt-5.5',
      timestamp: NOW - HOURS(2),
      inputTokens: 1_000_000 // $1 (the duplicate)
    }),
    // A provider-wide run that never went through TaskWraith.
    makeRecord({
      id: 'external-codex-2',
      provider: 'codex',
      model: 'gpt-5.5',
      timestamp: NOW - HOURS(3),
      inputTokens: 2_000_000 // $2
    }),
    // A model only seen externally → its own provider section.
    makeRecord({
      id: 'external-claude-1',
      provider: 'claude',
      model: 'opus',
      timestamp: NOW - HOURS(4),
      outputTokens: 1_000_000 // $25
    })
  ]

  it('uses TaskWraith runs only when includeExternal is off (default)', () => {
    const result = buildModelUsageTable(internal, external, RATES, USD, NOW)
    expect(result.map((g) => g.provider)).toEqual(['codex'])
    expect(result[0].models[0].windows.h24.tokensIn).toBe(1_000_000)
    expect(result[0].models[0].windows.h24.runs).toBe(1)
    expect(result[0].models[0].windows.h24.costUsd).toBeCloseTo(1, 6)
  })

  it('uses the provider-wide external set ONLY when includeExternal is on (never sums)', () => {
    const result = buildModelUsageTable(
      internal,
      external,
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )
    expect(result.map((g) => g.provider)).toEqual(['codex', 'claude'])
    const codex = result.find((g) => g.provider === 'codex')!
    // External-only: the two external codex runs ($1 dup + $2), NOT the internal
    // $1 added on top. A naive internal+external merge would read 3 runs / $4.
    expect(codex.models).toHaveLength(1)
    const codexRow = codex.models[0].windows.h24
    expect(codexRow.runs).toBe(2)
    expect(codexRow.tokensIn).toBe(3_000_000)
    expect(codexRow.costUsd).toBeCloseTo(3, 6)
    // Claude appears only because of the external dataset.
    const claude = result.find((g) => g.provider === 'claude')!
    expect(claude.models[0].windows.h24.costUsd).toBeCloseTo(25, 6)
  })

  it('drops out-of-roster + future-dated records on the external-only path', () => {
    const noisyExternal = [
      makeRecord({ provider: 'grok', timestamp: NOW - HOURS(1), inputTokens: 5_000_000 }),
      makeRecord({ provider: 'ollama', timestamp: NOW - HOURS(1), inputTokens: 5_000_000 }),
      makeRecord({ provider: 'codex', timestamp: NOW + 60_000, inputTokens: 5_000_000 }),
      // The one valid provider-wide record.
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - HOURS(1),
        inputTokens: 2_000_000
      })
    ]
    const result = buildModelUsageTable(
      internal,
      noisyExternal,
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )
    // Internal is NOT counted (external is on); ollama stays off the token roster.
    expect(result.map((g) => g.provider)).toEqual(['codex', 'grok'])
    const codex = result.find((group) => group.provider === 'codex')!
    expect(codex.totals.h24.tokensIn).toBe(2_000_000)
    expect(codex.totals.h24.runs).toBe(1)
  })

  it('does not count zero-token marker records as runs', () => {
    const withMarkers = [
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - HOURS(1),
        inputTokens: 1_000_000
      }),
      // Synthetic markers the external scanner emits (0 tokens, no cost).
      makeRecord({ id: 'm1', provider: 'codex', model: 'gpt-5.5', timestamp: NOW - HOURS(1) }),
      makeRecord({ id: 'm2', provider: 'cursor', model: 'cursor', timestamp: NOW - HOURS(1) })
    ]
    const result = buildModelUsageTable(
      [],
      withMarkers,
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )
    // Only the codex run with real tokens; the cursor marker creates no section.
    expect(result.map((g) => g.provider)).toEqual(['codex'])
    expect(result[0].models[0].windows.h24.runs).toBe(1)
  })
})

describe('buildModelUsageTableForSettings — private-home supplements when external is on', () => {
  const externalCodex = makeRecord({
    id: 'external-codex',
    provider: 'codex',
    model: 'gpt-5.5',
    timestamp: NOW - HOURS(1),
    inputTokens: 2_000_000
  })

  it('combines private-home TaskWraith Codex runs with external Codex activity', () => {
    const internal = [
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - HOURS(1),
        inputTokens: 1_000_000
      })
    ]
    const result = buildModelUsageTableForSettings(
      internal,
      [externalCodex],
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )

    const codex = result.find((group) => group.provider === 'codex')!
    expect(codex.totals.h24.tokensIn).toBe(3_000_000)
    expect(codex.totals.h24.runs).toBe(2)
  })

  it('folds internal grok runs into the external-only table', () => {
    const internal = [
      makeRecord({
        provider: 'grok',
        model: 'grok-build',
        timestamp: NOW - HOURS(1),
        inputTokens: 1_000_000,
        outputTokens: 500_000
      })
    ]
    const result = buildModelUsageTableForSettings(
      internal,
      [externalCodex],
      { ...RATES, grok: [{ modelId: 'grok-build', inputUsdPerMillion: 2, outputUsdPerMillion: 10 }] },
      { currency: 'USD', includeExternal: true },
      NOW
    )
    expect(result.map((g) => g.provider)).toEqual(['codex', 'grok'])
    const grok = result.find((g) => g.provider === 'grok')!
    expect(grok.totals.h24.totalTokens).toBe(1_500_000)
    const codex = result.find((g) => g.provider === 'codex')!
    expect(codex.totals.h24.tokensIn).toBe(2_000_000)
  })

  it('supplements cursor from internal only when external has no cursor section', () => {
    const internal = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: NOW - HOURS(1),
        inputTokens: 10_000,
        outputTokens: 5_000
      })
    ]
    const result = buildModelUsageTableForSettings(
      internal,
      [externalCodex],
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )
    expect(result.map((g) => g.provider)).toEqual(['codex', 'cursor'])
    expect(result.find((g) => g.provider === 'cursor')!.totals.h24.totalTokens).toBe(15_000)
  })

  it('merges internal and external cursor usage additively by canonical model id', () => {
    const internal = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: NOW - HOURS(1),
        inputTokens: 10_000,
        outputTokens: 5_000
      })
    ]
    const external = [
      externalCodex,
      makeRecord({
        id: 'external-cursor',
        provider: 'cursor',
        model: 'composer-2.5',
        timestamp: NOW - HOURS(2),
        inputTokens: 20_000,
        outputTokens: 10_000
      })
    ]
    const result = buildModelUsageTableForSettings(
      internal,
      external,
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )
    const cursor = result.find((g) => g.provider === 'cursor')!
    expect(cursor.totals.h24.totalTokens).toBe(45_000)
    expect(cursor.models).toHaveLength(2)
  })

  it('dedupes external cursor rows that mirror an internal TaskWraith Cursor record', () => {
    const ts = NOW - HOURS(1)
    const internal = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: ts,
        inputTokens: 10_000,
        outputTokens: 5_000
      })
    ]
    const external = [
      makeRecord({
        id: 'external-cursor-dup',
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: ts + 30_000,
        inputTokens: 10_500,
        outputTokens: 4_800
      })
    ]
    const result = buildModelUsageTableForSettings(
      internal,
      external,
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )
    const cursor = result.find((g) => g.provider === 'cursor')!
    expect(cursor.totals.h24.totalTokens).toBe(15_000)
    expect(cursor.totals.h24.runs).toBe(1)
  })

  it('dedupes a cache-inclusive internal Cursor run against cache-blind external activity', () => {
    const ts = NOW - HOURS(1)
    const internal = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: ts,
        inputTokens: 8_129,
        cacheReadInputTokens: 29_056,
        cacheCreationInputTokens: 12,
        outputTokens: 834,
        totalTokens: 38_031
      })
    ]
    const external = [
      makeRecord({
        id: 'external-cursor-cache-dup',
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: ts + 30_000,
        inputTokens: 8_129,
        outputTokens: 834,
        totalTokens: 8_963
      })
    ]
    const result = buildModelUsageTableForSettings(
      internal,
      external,
      RATES,
      { currency: 'USD', includeExternal: true },
      NOW
    )
    const cursor = result.find((group) => group.provider === 'cursor')!
    expect(cursor.totals.h24.tokensIn).toBe(37_197)
    expect(cursor.totals.h24.totalTokens).toBe(38_031)
    expect(cursor.totals.h24.runs).toBe(1)
  })

  it('collapses duplicate cursor model ids that only differ by display label', () => {
    const records = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: NOW - HOURS(1),
        inputTokens: 10_000,
        outputTokens: 5_000
      }),
      makeRecord({
        provider: 'cursor',
        model: 'Composer 2.5 Fast',
        timestamp: NOW - HOURS(2),
        inputTokens: 4_000,
        outputTokens: 1_000
      })
    ]
    const [cursor] = buildModelUsageTable(records, [], RATES, USD, NOW)
    expect(cursor.models).toHaveLength(1)
    expect(cursor.totals.h24.totalTokens).toBe(20_000)
  })

  it('matches buildModelUsageTable when external is off', () => {
    const internal = [
      makeRecord({
        provider: 'grok',
        model: 'grok-build',
        timestamp: NOW - HOURS(1),
        inputTokens: 1_000_000
      })
    ]
    const off = buildModelUsageTable(internal, [], RATES, USD, NOW)
    const settingsOff = buildModelUsageTableForSettings(internal, [], RATES, USD, NOW)
    expect(settingsOff).toEqual(off)
  })
})

describe('sumModelUsageProviderTotals', () => {
  it('sums provider roll-ups across the priced roster', () => {
    const groups = buildModelUsageTable(
      [
        makeRecord({
          provider: 'codex',
          model: 'gpt-5.5',
          timestamp: NOW - HOURS(1),
          inputTokens: 1_000_000
        }),
        makeRecord({
          provider: 'claude',
          model: 'opus',
          timestamp: NOW - HOURS(1),
          outputTokens: 1_000_000
        })
      ],
      [],
      RATES,
      USD,
      NOW
    )
    const totals = sumModelUsageProviderTotals(groups, USD)
    expect(totals.h24.totalTokens).toBe(2_000_000)
    expect(totals.h24.runs).toBe(2)
    expect(totals.h24.costUsd).toBeCloseTo(26, 6)
    expect(totals.h24.costDisplay).toBe('$26.00')
  })
})

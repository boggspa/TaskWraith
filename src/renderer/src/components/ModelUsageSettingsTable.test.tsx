import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ModelContextLengthsSettingsTable,
  ModelUsageOllamaTableBlock,
  ModelUsageProviderTableBlock,
  ModelUsageSettingsTable,
  ModelUsageTableTotalsFooter,
  ModelUsageWorkspaceMatrixTable,
  ProviderApiRatesTableBlock
} from './ModelUsageSettingsTable'
import {
  buildModelUsageTable,
  buildModelUsageWorkspaceMatrix,
  sumModelUsageProviderTotals
} from '../lib/modelUsageTable'
import { buildOllamaMemoryModelTable } from '../lib/ollamaMemoryAggregation'
import { buildProviderApiRateGroups } from '../lib/providerApiRatesTable'
import type { RendererProviderRates } from '../lib/providerRateEstimate'
import type { UsageRecord } from '../../../main/store/types'

const NOW = new Date('2026-06-13T12:00:00.000Z').getTime()

const RATES: RendererProviderRates = {
  codex: [{ modelId: 'gpt-5.5', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }],
  claude: [{ modelId: 'opus', inputUsdPerMillion: 5, outputUsdPerMillion: 25 }]
}

function makeRecord(overrides: Partial<UsageRecord> & { timestamp: number }): UsageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    chatId: 'c',
    runId: 'run',
    model: 'gpt-5.5',
    provider: 'codex',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  } as UsageRecord
}

describe('ModelUsageSettingsTable (SSR — effects do not fire)', () => {
  it('renders the empty state when no records have loaded yet', () => {
    // Under renderToStaticMarkup the getUsage/getExternalUsage effects never
    // run, so the aggregator sees empty record sets → honest empty state.
    const html = renderToStaticMarkup(<ModelUsageSettingsTable currency="USD" />)
    expect(html).toContain('No tracked usage in the last 90 days')
    // The "this app only" empty-state copy (toggle defaults OFF).
    expect(html).toContain('turn on External Usage')
  })

  it('renders the External Usage toggle, unchecked by default', () => {
    const html = renderToStaticMarkup(<ModelUsageSettingsTable currency="USD" />)
    expect(html).toContain('External Usage')
    expect(html).toContain('this app only')
    // Default OFF → checkbox not checked.
    expect(html).not.toContain('checked=""')
  })

  it('seeds the toggle ON from the persisted default and shows provider-wide copy', () => {
    const html = renderToStaticMarkup(
      <ModelUsageSettingsTable currency="USD" externalUsageDefault />
    )
    expect(html).toContain('checked=""')
    expect(html).toContain('provider-wide')
    // Empty-state copy switches to the external-on variant.
    expect(html).toContain('use a provider CLI')
  })

  it('always badges cost as estimated, never billed (header + footnote framing)', () => {
    const html = renderToStaticMarkup(<ModelUsageSettingsTable currency="USD" />)
    // Subtitle present even in the empty state — frames cost as estimated.
    expect(html).toContain('estimated API-equivalent cost · not billed')
  })

  it('renders a manual refresh control beside the External Usage toggle', () => {
    const html = renderToStaticMarkup(<ModelUsageSettingsTable currency="USD" />)
    expect(html).toContain('model-usage-table-refresh-button')
    expect(html).toContain('Refresh usage data')
    expect(html).toContain('↻')
  })
})

describe('ModelUsageProviderTableBlock (populated render)', () => {
  it('renders a provider summary row + per-model rows with ~-badged costs across 5 windows', () => {
    const records: UsageRecord[] = [
      // gpt-5.5 fresh: 2M in ($2) + 0.5M out ($5) = $7
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - 60_000,
        inputTokens: 2_000_000,
        outputTokens: 500_000,
        totalTokens: 2_500_000
      }),
      // A second model for the same provider, older (45d → 90d only).
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5-mini',
        timestamp: NOW - 45 * 24 * 60 * 60 * 1000,
        inputTokens: 1_000_000,
        totalTokens: 1_000_000
      })
    ]
    const [group] = buildModelUsageTable(records, [], RATES, { currency: 'USD' }, NOW)
    const html = renderToStaticMarkup(
      <table>
        <ModelUsageProviderTableBlock group={group} />
      </table>
    )

    // Provider heading + model-count chip.
    expect(html).toContain('Codex')
    expect(html).toContain('2 models')
    // Both model rows present (humanised label falls back to raw id).
    expect(html).toContain('gpt-5.5')
    // Cost is badged with ~ and the fresh model's 1H cost is $7.00.
    expect(html).toContain('~$7.00')
    // Token chips rendered.
    expect(html).toContain('tok')
  })

  it('projects Cursor cost via the Composer 2.5 Fast proxy rate', () => {
    const ratesWithCursor: RendererProviderRates = {
      ...RATES,
      cursor: [{ modelId: 'composer-2.5-fast', inputUsdPerMillion: 3, outputUsdPerMillion: 15 }]
    }
    const records: UsageRecord[] = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: NOW - 60_000,
        inputTokens: 10_000,
        outputTokens: 5_000,
        totalTokens: 15_000
      })
    ]
    const [group] = buildModelUsageTable(records, [], ratesWithCursor, { currency: 'USD' }, NOW)
    const html = renderToStaticMarkup(
      <table>
        <ModelUsageProviderTableBlock group={group} />
      </table>
    )
    expect(html).toContain('Cursor')
    expect(html).toContain('tok')
    expect(html).toContain('~$0.11')
  })
})

describe('ModelUsageOllamaTableBlock (populated render)', () => {
  it('renders GPT OSS memory aliases as one model row', () => {
    const group = buildOllamaMemoryModelTable(
      [
        {
          ...makeRecord({
            provider: 'ollama',
            model: 'gpt-oss:20b',
            timestamp: NOW - 60_000
          }),
          ollamaMemoryPeakRssGb: 16,
          ollamaMemorySampleCount: 10
        },
        {
          ...makeRecord({
            provider: 'ollama',
            model: 'gpt-oss:latest',
            timestamp: NOW - 30_000
          }),
          ollamaMemoryPeakRssGb: 18,
          ollamaMemorySampleCount: 18
        }
      ],
      NOW
    )
    const html = renderToStaticMarkup(
      <table>
        {group ? <ModelUsageOllamaTableBlock group={group} /> : null}
      </table>
    )
    expect(html).toContain('GPT OSS (20B Param)')
    expect(html).toContain('1 model')
    expect(html.match(/model-usage-table-model-row/g)).toHaveLength(1)
    expect(html).toContain('17GB')
    expect(html).toContain('14 avg')
  })
})

describe('ModelUsageTableTotalsFooter (populated render)', () => {
  it('renders API token/cost and Ollama RAM total rows', () => {
    const groups = buildModelUsageTable(
      [
        makeRecord({
          provider: 'codex',
          model: 'gpt-5.5',
          timestamp: NOW - 60_000,
          inputTokens: 2_000_000,
          outputTokens: 500_000,
          totalTokens: 2_500_000
        })
      ],
      [],
      RATES,
      { currency: 'USD' },
      NOW
    )
    const ollamaGroup = buildOllamaMemoryModelTable([
      {
        ...makeRecord({
          provider: 'ollama',
          model: 'qwen3:4b-instruct',
          timestamp: NOW - 60_000
        }),
        ollamaMemoryPeakRssGb: 12,
        ollamaMemorySampleCount: 8
      }
    ])
    const html = renderToStaticMarkup(
      <table>
        <ModelUsageTableTotalsFooter
          tokenTotals={sumModelUsageProviderTotals(groups, { currency: 'USD' })}
          ollamaTotals={ollamaGroup?.totals ?? null}
        />
      </table>
    )
    expect(html).toContain('Token / cost total')
    expect(html).toContain('Ollama RAM total')
    expect(html).toContain('~$7.00')
    expect(html).toContain('12GB')
    expect(html).toContain('8 avg')
  })
})

describe('ModelUsageWorkspaceMatrixTable (populated render)', () => {
  it('renders workspace columns with changed files, tokens, and estimated cost', () => {
    const records: UsageRecord[] = [
      makeRecord({
        workspaceId: 'ws-alpha',
        chatId: 'chat-alpha',
        runId: 'run-alpha',
        timestamp: NOW - 60_000,
        inputTokens: 2_000_000,
        outputTokens: 500_000,
        totalTokens: 2_500_000
      })
    ]
    const matrix = buildModelUsageWorkspaceMatrix(
      records,
      [],
      [
        {
          id: 'chat-alpha',
          appChatId: 'chat-alpha',
          title: 'Alpha',
          provider: 'codex',
          messages: [],
          runs: [
            {
              runId: 'run-alpha',
              startedAt: new Date(NOW - 60_000).toISOString(),
              message: 'run',
              timestamp: new Date(NOW).toISOString(),
              runDiff: {
                runId: 'run-alpha',
                preSnapshot: { capturedAt: 't', isGitRepo: true },
                createdFiles: [
                  { path: 'src/new.ts', status: 'created', previewKind: 'git_diff' }
                ],
                modifiedFiles: [
                  { path: 'src/app.ts', status: 'modified', previewKind: 'git_diff' }
                ],
                deletedFiles: [],
                preExistingFiles: []
              }
            }
          ],
          createdAt: 1,
          updatedAt: 1,
          scope: 'workspace',
          chatKind: 'single',
          workspaceId: 'ws-alpha',
          workspacePath: '/repo/alpha'
        } as any
      ],
      RATES,
      { currency: 'USD' },
      NOW
    )

    const html = renderToStaticMarkup(<ModelUsageWorkspaceMatrixTable matrix={matrix} />)
    expect(html).toContain('Models by workspace')
    expect(html).toContain('alpha')
    expect(html).toContain('2 files')
    expect(html).toContain('2.5M tok')
    expect(html).toContain('~$7.00')
    expect(html).toContain('estimated cost')
  })
})

describe('ProviderApiRatesTableBlock (populated render)', () => {
  it('renders provider/model API rates with cached input and source status', () => {
    const [group] = buildProviderApiRateGroups({
      rateTableVersion: '2026-06-23',
      baseline: {
        codex: {
          provider: 'codex',
          pricingUrl: 'https://openai.com/api/pricing',
          models: [
            {
              modelId: 'gpt-5.5',
              inputUsdPerMillion: 5,
              cachedInputUsdPerMillion: 0.5,
              outputUsdPerMillion: 30,
              sourceUrl: 'https://openai.com/api/pricing',
              lastVerified: '2026-06-23',
              notes: 'Codex CLI projected API-equivalent.'
            }
          ]
        }
      },
      probe: {
        runAt: '2026-06-23T10:00:00.000Z',
        results: {
          codex: {
            provider: 'codex',
            pricingUrl: 'https://openai.com/api/pricing',
            models: [
              {
                modelId: 'gpt-5.5',
                status: 'verified',
                baseline: {
                  inputUsdPerMillion: 5,
                  outputUsdPerMillion: 30,
                  confidence: 'baked-in'
                }
              }
            ]
          }
        }
      }
    })
    const html = renderToStaticMarkup(
      <table>
        <ProviderApiRatesTableBlock group={group} />
      </table>
    )

    expect(html).toContain('Codex')
    expect(html).toContain('rate table 2026-06-23')
    expect(html).toContain('$5')
    expect(html).toContain('$0.50')
    expect(html).toContain('$30')
    expect(html).toContain('verified')
    expect(html).toContain('https://openai.com/api/pricing')
  })

  it('badges Gemini as a historic provider in the rates group row', () => {
    const [group] = buildProviderApiRateGroups({
      rateTableVersion: '2026-06-23',
      baseline: {
        gemini: {
          provider: 'gemini',
          pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
          models: [
            {
              modelId: 'gemini-3.1-pro',
              inputUsdPerMillion: 1.25,
              outputUsdPerMillion: 10,
              sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
              lastVerified: '2026-06-23'
            }
          ]
        }
      }
    })
    const html = renderToStaticMarkup(
      <table>
        <ProviderApiRatesTableBlock group={group} />
      </table>
    )

    expect(html).toContain('Gemini')
    expect(html).toContain('historic provider')
    expect(html).toContain('source')
  })
})

describe('ModelContextLengthsSettingsTable (SSR — static data, no effects)', () => {
  it('renders the heading and subtitle', () => {
    const html = renderToStaticMarkup(<ModelContextLengthsSettingsTable />)
    expect(html).toContain('Model Context Lengths')
    expect(html).toContain('Official maximum context window per model')
  })

  it('contains a Claude provider name', () => {
    const html = renderToStaticMarkup(<ModelContextLengthsSettingsTable />)
    expect(html).toContain('Claude')
  })

  it('contains a model cell with Opus 4.8 substring', () => {
    const html = renderToStaticMarkup(<ModelContextLengthsSettingsTable />)
    expect(html).toContain('Opus 4.8')
  })

  it('contains the formatted window 1.0M for claude-opus-4-8-1m', () => {
    const html = renderToStaticMarkup(<ModelContextLengthsSettingsTable />)
    expect(html).toContain('1.0M')
  })

  it('shows each K3 route as its own fixed window, with the range display retired', () => {
    // The K3 split (d19931eb8 / f661ac2a1) made 'kimi-k3' the concrete 1M
    // route and 'kimi-k3-256k' the fixed 256k one, so the old plan-dependent
    // '256k–1.0M' single-row range must no longer render anywhere.
    const html = renderToStaticMarkup(<ModelContextLengthsSettingsTable />)
    expect(html).toContain('K3 (1M)')
    expect(html).toContain('K3 (256K)')
    expect(html).toContain('>256k<')
    expect(html).not.toContain('256k–1.0M')
    expect(html).not.toContain('1.0M–1.0M')
    expect(html).not.toContain('plan-dependent')
  })

  it('is currency-free — does not contain ~ cost badge or $ symbol', () => {
    const html = renderToStaticMarkup(<ModelContextLengthsSettingsTable />)
    expect(html).not.toContain('~')
    expect(html).not.toContain('$')
  })

  it('includes both Gemini and local Ollama models', () => {
    const html = renderToStaticMarkup(<ModelContextLengthsSettingsTable />)
    // Settings variant keeps the full provider set (unlike the sidebar).
    expect(html).toContain('Gemini')
    expect(html).toContain('Ollama')
  })
})

import { describe, expect, it } from 'vitest'
import {
  aggregatePromptCacheDiagnosticsFromChats,
  buildPromptCacheCapabilitySummary,
  normalizePromptCacheSettings
} from './PromptCachePolicy'

describe('PromptCachePolicy', () => {
  it('normalizes persisted policy while dropping unknown providers and modes', () => {
    expect(
      normalizePromptCacheSettings({
        enabled: false,
        providers: {
          claude: {
            mode: 'explicit',
            minStablePrefixTokens: 1234.8,
            diagnosticsEnabled: true
          },
          codex: { mode: 'turbo' },
          unknown: { mode: 'auto' }
        }
      })
    ).toEqual({
      enabled: false,
      providers: {
        claude: {
          mode: 'explicit',
          minStablePrefixTokens: 1234,
          diagnosticsEnabled: true
        },
        codex: { mode: 'auto' },
        kimi: { mode: 'off' },
        grok: { mode: 'off' },
        cursor: { mode: 'off' },
        ollama: { mode: 'off' },
        gemini: { mode: 'off' }
      }
    })
  })

  it('returns honest provider capability tiers for settings UI', () => {
    const summary = buildPromptCacheCapabilitySummary(
      { promptCache: { enabled: true, providers: { claude: { mode: 'explicit' } } } },
      new Date('2026-07-05T12:00:00.000Z')
    )

    expect(summary.generatedAt).toBe('2026-07-05T12:00:00.000Z')
    expect(summary.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          guaranteeTier: 'automatic-observed',
          controllable: false
        }),
        expect.objectContaining({
          provider: 'claude',
          guaranteeTier: 'best-effort',
          supportsModeControl: true,
          defaultMode: 'explicit'
        }),
        expect.objectContaining({
          provider: 'kimi',
          guaranteeTier: 'best-effort',
          supportsModeControl: true
        }),
        expect.objectContaining({
          provider: 'gemini',
          guaranteeTier: 'unsupported',
          retired: true,
          defaultMode: 'off'
        })
      ])
    )
  })

  it('aggregates prompt cache diagnostics from recent live-provider runs', () => {
    const rows = aggregatePromptCacheDiagnosticsFromChats(
      [
        {
          provider: 'claude',
          runs: [
            {
              runId: 'run-1',
              provider: 'claude',
              startedAt: '2026-07-05T10:00:00.000Z',
              endedAt: '2026-07-05T10:01:00.000Z',
              stats: {
                input_tokens: 100,
                cache_read_input_tokens: 12,
                cache_creation_input_tokens: 3
              }
            },
            {
              runId: 'run-2',
              provider: 'claude',
              startedAt: '2026-07-05T11:00:00.000Z',
              stats: {
                inputTokens: 50,
                cacheReadInputTokens: 8
              }
            }
          ]
        },
        {
          provider: 'gemini',
          runs: [
            {
              runId: 'legacy-gemini',
              provider: 'gemini',
              startedAt: '2026-07-05T12:00:00.000Z',
              stats: { input_tokens: 999, cache_read_input_tokens: 999 }
            }
          ]
        },
        {
          provider: 'codex',
          runs: [
            {
              runId: 'codex-run',
              provider: 'codex',
              startedAt: '2026-07-04T12:00:00.000Z',
              stats: { input_tokens: 25, cachedInputTokens: 5 }
            }
          ]
        }
      ] as any,
      { nowMs: Date.parse('2026-07-05T12:00:00.000Z') }
    )

    expect(rows).toEqual([
      {
        provider: 'claude',
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 3,
        inputTokens: 150,
        lastRunAt: Date.parse('2026-07-05T11:00:00.000Z'),
        runCount: 2
      },
      {
        provider: 'codex',
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        inputTokens: 25,
        lastRunAt: Date.parse('2026-07-04T12:00:00.000Z'),
        runCount: 1
      }
    ])
  })

  it('bounds prompt cache diagnostics scans to newest runs', () => {
    const rows = aggregatePromptCacheDiagnosticsFromChats(
      [
        {
          provider: 'claude',
          runs: [
            {
              runId: 'old',
              provider: 'claude',
              startedAt: '2026-07-01T00:00:00.000Z',
              stats: { input_tokens: 100, cache_read_input_tokens: 100 }
            },
            {
              runId: 'new',
              provider: 'claude',
              startedAt: '2026-07-02T00:00:00.000Z',
              stats: { input_tokens: 10, cache_read_input_tokens: 10 }
            }
          ]
        }
      ] as any,
      { maxRuns: 1, nowMs: Date.parse('2026-07-05T12:00:00.000Z') }
    )

    expect(rows).toEqual([
      expect.objectContaining({
        provider: 'claude',
        cacheReadInputTokens: 10,
        inputTokens: 10,
        runCount: 1
      })
    ])
  })
})

import { describe, expect, it } from 'vitest'
import {
  aggregatePromptCacheDiagnosticsFromUsage,
  buildPromptCacheCapabilitySummary,
  normalizePromptCacheSettings
} from './PromptCachePolicy'
import type { UsageRecord } from './store/types'

function usage(
  overrides: Partial<UsageRecord> & Pick<UsageRecord, 'id' | 'timestamp'>
): UsageRecord {
  return {
    workspaceId: 'ws',
    chatId: 'chat',
    runId: overrides.id,
    model: 'model',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  }
}

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
        gemini: { mode: 'off' },
        antigravity: { mode: 'off' },
        pi: { mode: 'off' }
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
          provider: 'cursor',
          guaranteeTier: 'best-effort',
          retired: undefined,
          defaultMode: 'off',
          detail: expect.stringContaining('opaque cursor-agent CLI transport')
        }),
        expect.objectContaining({
          provider: 'gemini',
          guaranteeTier: 'unsupported',
          retired: true,
          defaultMode: 'off'
        }),
        // The provider ships two transports; the table has to name it, and the
        // weaker lane sets the tier.
        expect.objectContaining({
          provider: 'antigravity',
          guaranteeTier: 'automatic-observed',
          controllable: false,
          supportsModeControl: false,
          retired: undefined
        })
      ])
    )
  })

  it('aggregates prompt cache diagnostics from recent live-provider usage records', () => {
    const rows = aggregatePromptCacheDiagnosticsFromUsage(
      [
        usage({
          id: 'run-1',
          provider: 'claude',
          timestamp: Date.parse('2026-07-05T10:01:00.000Z'),
          inputTokens: 100,
          cacheReadInputTokens: 12,
          cacheCreationInputTokens: 3
        }),
        usage({
          id: 'run-2',
          provider: 'claude',
          timestamp: Date.parse('2026-07-05T11:00:00.000Z'),
          inputTokens: 50,
          cacheReadInputTokens: 8
        }),
        // Retired providers never surface, however much cache they reported.
        usage({
          id: 'legacy-gemini',
          provider: 'gemini',
          timestamp: Date.parse('2026-07-05T12:00:00.000Z'),
          inputTokens: 999,
          cacheReadInputTokens: 999
        }),
        // Quota hints are not runs.
        usage({
          id: 'claude-reset-hint',
          provider: 'claude',
          usageKind: 'reset_hint',
          timestamp: Date.parse('2026-07-05T11:30:00.000Z'),
          inputTokens: 777,
          cacheReadInputTokens: 777
        }),
        // Older than the 30-day window.
        usage({
          id: 'claude-ancient',
          provider: 'claude',
          timestamp: Date.parse('2026-05-01T00:00:00.000Z'),
          inputTokens: 555,
          cacheReadInputTokens: 555
        }),
        // A provider-less row cannot be attributed.
        usage({
          id: 'orphan',
          provider: undefined,
          timestamp: Date.parse('2026-07-05T11:45:00.000Z'),
          inputTokens: 333,
          cacheReadInputTokens: 333
        }),
        usage({
          id: 'codex-run',
          provider: 'codex',
          timestamp: Date.parse('2026-07-04T12:00:00.000Z'),
          inputTokens: 25,
          cacheReadInputTokens: 5
        })
      ],
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

  it('bounds prompt cache diagnostics scans to newest usage records', () => {
    const rows = aggregatePromptCacheDiagnosticsFromUsage(
      [
        usage({
          id: 'old',
          provider: 'claude',
          timestamp: Date.parse('2026-07-01T00:00:00.000Z'),
          inputTokens: 100,
          cacheReadInputTokens: 100
        }),
        usage({
          id: 'new',
          provider: 'claude',
          timestamp: Date.parse('2026-07-02T00:00:00.000Z'),
          inputTokens: 10,
          cacheReadInputTokens: 10
        })
      ],
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

  it('counts folded time-bucket usage rows by their runCount', () => {
    const rows = aggregatePromptCacheDiagnosticsFromUsage(
      [
        usage({
          id: 'bucket',
          provider: 'codex',
          timestamp: Date.parse('2026-07-05T09:00:00.000Z'),
          inputTokens: 40,
          cacheReadInputTokens: 30,
          runCount: 4
        })
      ],
      { nowMs: Date.parse('2026-07-05T12:00:00.000Z') }
    )

    expect(rows).toEqual([
      expect.objectContaining({ provider: 'codex', cacheReadInputTokens: 30, runCount: 4 })
    ])
  })
})

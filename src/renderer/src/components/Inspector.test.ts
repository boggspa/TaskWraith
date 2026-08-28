import { describe, expect, it } from 'vitest'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import { inferProviderFromRawLogContent, scopeRawLogsToRound } from './Inspector'

/* The Inspector's Invocations, Invocation Timeline, Live Invocations, Safety and
 * Capabilities tabs were removed — provider status, permissions and tooling live
 * in Settings, and invocation detail is already in the transcript. The rendering
 * tests for those five tabs went with them, along with the buildDelegationTree
 * suite whose module no longer exists. Diff Studio, Commits, Raw Events and
 * Prompt are what the Inspector renders now. */

describe('inferProviderFromRawLogContent', () => {
  it('recognizes every live and retired provider id in JSON and text forms', () => {
    for (const provider of [...LIVE_SELECTABLE_PROVIDER_IDS, 'gemini']) {
      expect(inferProviderFromRawLogContent(JSON.stringify({ provider }))).toBe(provider)
      expect(inferProviderFromRawLogContent(`targetProvider: '${provider}'`)).toBe(provider)
    }
  })

  it('returns null for unknown provider tokens', () => {
    expect(inferProviderFromRawLogContent(JSON.stringify({ provider: 'skynet' }))).toBeNull()
    expect(inferProviderFromRawLogContent('provider: skynet')).toBeNull()
    expect(inferProviderFromRawLogContent('no provider here')).toBeNull()
  })
})

describe('scopeRawLogsToRound', () => {
  const logs = [
    { type: 'stderr' as const, content: 'old Grok error', timestamp: '2026-08-28T17:37:15Z' },
    { type: 'info' as const, content: 'current start', timestamp: '2026-08-28T17:38:35Z' },
    { type: 'tool' as const, content: 'current tool', timestamp: '2026-08-28T17:39:00Z' },
    { type: 'stdout' as const, content: 'untagged historical event' }
  ]

  it('defaults to timestamped events from the current round', () => {
    expect(scopeRawLogsToRound(logs, '2026-08-28T17:38:35Z', 'round')).toEqual([logs[1], logs[2]])
  })

  it('restores the complete chat-wide buffer for All rounds', () => {
    expect(scopeRawLogsToRound(logs, '2026-08-28T17:38:35Z', 'all')).toBe(logs)
    expect(scopeRawLogsToRound(logs, undefined, 'round')).toBe(logs)
  })
})

import { describe, expect, it } from 'vitest'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import { inferProviderFromRawLogContent } from './Inspector'

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

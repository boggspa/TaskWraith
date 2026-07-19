import { describe, expect, it } from 'vitest'
import { normalizeBrokerParentProvider } from './McpBridgeRuntime'

describe('normalizeBrokerParentProvider', () => {
  it('rejects Cursor and preserves Grok provider stamps for broker-routed MCP calls', () => {
    expect(normalizeBrokerParentProvider('cursor')).toBe('gemini')
    expect(normalizeBrokerParentProvider('grok')).toBe('grok')
  })

  it('falls back to Gemini for unknown provider stamps', () => {
    expect(normalizeBrokerParentProvider('unknown')).toBe('gemini')
  })
})

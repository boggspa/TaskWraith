import { describe, expect, it } from 'vitest'
import {
  supportsTaskWraithToolGrants,
  taskWraithToolGrantUnsupportedReason
} from './providerToolGrantSupport'

describe('TaskWraith Tool Grant support', () => {
  it('excludes Cursor Path-B while keeping mediated providers grantable', () => {
    expect(supportsTaskWraithToolGrants('cursor')).toBe(false)
    expect(taskWraithToolGrantUnsupportedReason('cursor')).toMatch(/native tools/i)

    for (const provider of ['codex', 'claude', 'kimi', 'grok', 'ollama', 'gemini'] as const) {
      expect(supportsTaskWraithToolGrants(provider)).toBe(true)
      expect(taskWraithToolGrantUnsupportedReason(provider)).toBeNull()
    }
  })
})

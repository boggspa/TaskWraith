import { describe, expect, it } from 'vitest'
import {
  CODEX_HARNESS_TW_ONLY_NOTE,
  CURSOR_HARNESS_SUPPRESS_DISCLOSURE,
  DEFAULT_PROVIDER_HARNESS_POSTURES,
  claudeUsesEmptySettingSources,
  kimiShouldEmptySkillsDir,
  mergeProviderHarnessPosture,
  normalizeProviderHarnessPosture,
  normalizeProviderHarnessPostureMap,
  piShouldPassNoSkills,
  resolveProviderHarnessPosture
} from './providerHarnessPosture'

describe('providerHarnessPosture defaults', () => {
  it('suppresses Claude, Pi, and Kimi skills and hooks', () => {
    for (const provider of ['claude', 'pi', 'kimi'] as const) {
      expect(DEFAULT_PROVIDER_HARNESS_POSTURES[provider]).toEqual({
        skills: 'suppress',
        hooks: 'suppress'
      })
    }
  })

  it('allows Cursor native skills and hooks by default', () => {
    expect(DEFAULT_PROVIDER_HARNESS_POSTURES.cursor).toEqual({
      skills: 'allow-native',
      hooks: 'allow-native'
    })
  })

  it('keeps Codex and other providers on tw-only', () => {
    expect(DEFAULT_PROVIDER_HARNESS_POSTURES.codex).toEqual({
      skills: 'tw-only',
      hooks: 'tw-only'
    })
    for (const provider of ['gemini', 'grok', 'ollama', 'antigravity', 'mistral'] as const) {
      expect(DEFAULT_PROVIDER_HARNESS_POSTURES[provider]).toEqual({
        skills: 'tw-only',
        hooks: 'tw-only'
      })
    }
  })

  it('documents Cursor suppress limits and Codex private home', () => {
    expect(CURSOR_HARNESS_SUPPRESS_DISCLOSURE).toMatch(/cannot fully suppress/i)
    expect(CODEX_HARNESS_TW_ONLY_NOTE).toMatch(/CODEX_HOME/i)
  })
})

describe('normalize / merge / resolve', () => {
  it('merges partial overrides onto a base posture', () => {
    expect(
      mergeProviderHarnessPosture(
        { skills: 'suppress', hooks: 'suppress' },
        { skills: 'allow-native' }
      )
    ).toEqual({ skills: 'allow-native', hooks: 'suppress' })
  })

  it('drops invalid modes and unknown providers from stored maps', () => {
    const normalized = normalizeProviderHarnessPostureMap({
      claude: { skills: 'allow-native', hooks: 'nope' },
      notAProvider: { skills: 'suppress', hooks: 'suppress' },
      cursor: { skills: 'suppress', hooks: 'suppress' }
    })
    expect(normalized.claude).toEqual({ skills: 'allow-native', hooks: 'suppress' })
    expect(normalized.cursor).toEqual({ skills: 'suppress', hooks: 'suppress' })
    expect((normalized as Record<string, unknown>).notAProvider).toBeUndefined()
  })

  it('resolves stored overrides over defaults', () => {
    expect(resolveProviderHarnessPosture('claude')).toEqual({
      skills: 'suppress',
      hooks: 'suppress'
    })
    expect(
      resolveProviderHarnessPosture('claude', {
        claude: { skills: 'allow-native', hooks: 'allow-native' }
      })
    ).toEqual({ skills: 'allow-native', hooks: 'allow-native' })
  })

  it('normalizes a single posture against a fallback', () => {
    expect(
      normalizeProviderHarnessPosture(undefined, { skills: 'tw-only', hooks: 'tw-only' })
    ).toEqual({ skills: 'tw-only', hooks: 'tw-only' })
    expect(
      normalizeProviderHarnessPosture(
        { skills: 'allow-native' },
        { skills: 'suppress', hooks: 'suppress' }
      )
    ).toEqual({ skills: 'allow-native', hooks: 'suppress' })
  })
})

describe('launch containment helpers', () => {
  it('keeps Claude empty setting-sources unless both channels allow-native', () => {
    expect(claudeUsesEmptySettingSources({ skills: 'suppress', hooks: 'suppress' })).toBe(true)
    expect(claudeUsesEmptySettingSources({ skills: 'tw-only', hooks: 'tw-only' })).toBe(true)
    expect(claudeUsesEmptySettingSources({ skills: 'allow-native', hooks: 'suppress' })).toBe(true)
    expect(claudeUsesEmptySettingSources({ skills: 'allow-native', hooks: 'allow-native' })).toBe(
      false
    )
  })

  it('omits Pi --no-skills only for allow-native skills', () => {
    expect(piShouldPassNoSkills({ skills: 'suppress' })).toBe(true)
    expect(piShouldPassNoSkills({ skills: 'tw-only' })).toBe(true)
    expect(piShouldPassNoSkills({ skills: 'allow-native' })).toBe(false)
  })

  it('empties Kimi skills dir unless allow-native', () => {
    expect(kimiShouldEmptySkillsDir({ skills: 'suppress' })).toBe(true)
    expect(kimiShouldEmptySkillsDir({ skills: 'tw-only' })).toBe(true)
    expect(kimiShouldEmptySkillsDir({ skills: 'allow-native' })).toBe(false)
  })
})

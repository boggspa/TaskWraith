import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  collectProviderSets,
  evaluateProviderIntent,
  parseSwiftLiveSet,
  parseTsProviderSets,
  validateIntent
} = require('./provider-intent-guard.cjs') as {
  collectProviderSets: (options?: { repoRoot?: string; intentPath?: string }) => {
    intentIds: string[]
    tsLive: string[]
    tsRetired: string[]
    swiftLive: string[]
  }
  evaluateProviderIntent: (input: {
    intentIds: string[]
    tsLive: string[]
    tsRetired: string[]
    swiftLive: string[]
  }) => string[]
  parseSwiftLiveSet: (source: string, filePath?: string) => string[]
  parseTsProviderSets: (source: string, filePath?: string) => { live: string[]; retired: string[] }
  validateIntent: (intent: unknown) => void
}

const INTENT = ['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama']

function tsFixture(liveLiteral: string, retiredLiteral = "new Set<string>(['gemini'])"): string {
  return [
    `export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = ${retiredLiteral}`,
    `export const LIVE_SELECTABLE_PROVIDER_IDS = ${liveLiteral} as const`
  ].join('\n')
}

function swiftFixture(setBody: string): string {
  return `
public enum TWTheme {
    public static let retiredProviderIds: Set<String> = ["gemini"]

    public static let liveSelectableProviderIds: Set<String> = [${setBody}]

    public static func isLiveSelectableProvider(_ provider: String?) -> Bool {
        guard let provider else { return false }
        return liveSelectableProviderIds.contains(provider.lowercased())
    }
}
`
}

describe('provider-intent guard', () => {
  it('passes against the working tree: code matches the user-approved intent', () => {
    const sets = collectProviderSets()
    expect(sets.intentIds.length).toBeGreaterThan(0)
    expect(sets.tsRetired.length).toBeGreaterThan(0)
    expect(evaluateProviderIntent(sets)).toEqual([])
  })

  describe('TypeScript source parsing', () => {
    it('extracts the live and retired sets through the as-const literal', () => {
      const parsed = parseTsProviderSets(tsFixture("['codex', 'claude']"))
      expect(parsed.live).toEqual(['codex', 'claude'])
      expect(parsed.retired).toEqual(['gemini'])
    })

    it('refuses to pass vacuously when LIVE_SELECTABLE_PROVIDER_IDS is missing', () => {
      const source =
        "export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set<string>(['gemini'])"
      expect(() => parseTsProviderSets(source)).toThrow(
        /LIVE_SELECTABLE_PROVIDER_IDS declaration not found/
      )
    })

    it('refuses to pass vacuously when RETIRED_PROVIDER_IDS is missing', () => {
      const source = "export const LIVE_SELECTABLE_PROVIDER_IDS = ['codex'] as const"
      expect(() => parseTsProviderSets(source)).toThrow(
        /RETIRED_PROVIDER_IDS declaration not found/
      )
    })

    it('rejects a live set that is no longer a plain string-literal array', () => {
      expect(() => parseTsProviderSets(tsFixture("[...BASE_IDS, 'codex']"))).toThrow(
        /non-literal element/
      )
      expect(() =>
        parseTsProviderSets(
          "export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set<string>(['gemini'])\nexport const LIVE_SELECTABLE_PROVIDER_IDS = buildLiveSet()"
        )
      ).toThrow(/not a plain array literal/)
    })

    it('rejects duplicate live-set entries', () => {
      expect(() => parseTsProviderSets(tsFixture("['codex', 'codex']"))).toThrow(/duplicate/)
    })
  })

  describe('Swift source parsing', () => {
    it('extracts the hand-mirrored iOS live set despite formatting and usage sites', () => {
      const source = swiftFixture(
        '\n        "codex", "claude", "kimi", // trailing comment\n        "cursor",\n    '
      )
      expect(parseSwiftLiveSet(source)).toEqual(['codex', 'claude', 'kimi', 'cursor'])
    })

    it('fails loudly when the declaration is absent instead of passing vacuously', () => {
      expect(() => parseSwiftLiveSet('public enum TWTheme {}')).toThrow(/declaration not found/)
    })

    it('fails loudly when the name exists but the literal declaration shape is gone', () => {
      const source =
        'public enum TWTheme {\n    public static let liveSelectableProviderIds: Set<String> = baseIds.union(["codex"])\n}'
      expect(() => parseSwiftLiveSet(source)).toThrow(
        /no.*declaration parses|refusing to pass vacuously/
      )
    })

    it('rejects non-literal content inside the set body', () => {
      expect(() => parseSwiftLiveSet(swiftFixture('"codex", extraIds'))).toThrow(
        /non-literal content/
      )
    })

    it('rejects an emptied set instead of treating it as parsed', () => {
      expect(() => parseSwiftLiveSet(swiftFixture(''))).toThrow(/parsed as empty/)
    })
  })

  describe('intent evaluation', () => {
    const aligned = {
      intentIds: INTENT,
      tsLive: [...INTENT],
      tsRetired: ['gemini'],
      swiftLive: [...INTENT]
    }

    it('returns no failures when all three sets agree', () => {
      expect(evaluateProviderIntent(aligned)).toEqual([])
    })

    it('flags capability narrowing with the AGENTS.md governance message (2026-07-19 class)', () => {
      const withoutCursor = INTENT.filter((id) => id !== 'cursor')
      const failures = evaluateProviderIntent({
        ...aligned,
        tsLive: withoutCursor,
        swiftLive: withoutCursor
      })
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain('removed from the live set (capability narrowing): cursor')
      expect(failures[0]).toContain('AGENTS.md')
      expect(failures[0]).toContain('user approving that exact narrowing in the current session')
      expect(failures[0]).toContain('scripts/provider-intent.json')
    })

    it('asserts exact equality, not subset: unapproved additions fail', () => {
      const failures = evaluateProviderIntent({
        ...aligned,
        tsLive: [...INTENT, 'newprov'],
        swiftLive: [...INTENT, 'newprov']
      })
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain('added to the live set without user approval: newprov')
    })

    it('keeps deliberately retired gemini out of the live set', () => {
      const failures = evaluateProviderIntent({
        ...aligned,
        tsLive: [...INTENT, 'gemini'],
        swiftLive: [...INTENT, 'gemini']
      })
      expect(
        failures.some((failure) =>
          failure.includes('added to the live set without user approval: gemini')
        )
      ).toBe(true)
      expect(failures.some((failure) => failure.includes('RETIRED_PROVIDER_IDS'))).toBe(true)
    })

    it('flags iOS mirror drift (build-81 Cursor-lockout class)', () => {
      const failures = evaluateProviderIntent({
        ...aligned,
        swiftLive: INTENT.filter((id) => id !== 'cursor')
      })
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain('Theme.swift')
      expect(failures[0]).toContain('missing on iOS: cursor')
      expect(failures[0]).toContain('build 81')
    })
  })

  describe('intent file validation', () => {
    it('accepts the tracked schema', () => {
      expect(() =>
        validateIntent({ schemaVersion: 1, liveSelectableProviderIds: ['codex'] })
      ).not.toThrow()
    })

    it('rejects wrong schema, empty lists, non-slug ids, and duplicates', () => {
      expect(() => validateIntent({ liveSelectableProviderIds: ['codex'] })).toThrow(
        /schemaVersion/
      )
      expect(() => validateIntent({ schemaVersion: 1, liveSelectableProviderIds: [] })).toThrow(
        /non-empty/
      )
      expect(() =>
        validateIntent({ schemaVersion: 1, liveSelectableProviderIds: ['Codex'] })
      ).toThrow(/non-canonical/)
      expect(() =>
        validateIntent({ schemaVersion: 1, liveSelectableProviderIds: ['codex', 'codex'] })
      ).toThrow(/duplicate/)
    })
  })
})

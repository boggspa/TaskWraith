import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveContextWindow } from './contextWindows'

interface ParsedEntry {
  key: string
  value: number
}

const typescriptSource = readFileSync(join(process.cwd(), 'src/shared/contextWindows.ts'), 'utf8')
const swiftSource = readFileSync(
  join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithKit/ContextWindows.swift'),
  'utf8'
)

function extractBlock(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)
  expect(match, `${label} table must remain a static literal`).toBeTruthy()
  return match?.[1] ?? ''
}

function parseTypeScriptEntries(block: string, label: string): ParsedEntry[] {
  const entries = [
    ...block.matchAll(/^\s*(?:'([^']+)'|([A-Za-z0-9_-]+)):\s*([0-9_]+),?\s*(?:\/\/.*)?$/gm)
  ].map((match) => ({
    key: match[1] ?? match[2],
    value: Number(match[3].replaceAll('_', ''))
  }))
  expect(entries.length, `${label} TypeScript table must not be empty`).toBeGreaterThan(0)
  return entries
}

function parseSwiftEntries(block: string, label: string): ParsedEntry[] {
  const entries = [...block.matchAll(/^\s*"([^"]+)":\s*([0-9_]+),/gm)].map((match) => ({
    key: match[1],
    value: Number(match[2].replaceAll('_', ''))
  }))
  expect(entries.length, `${label} Swift table must not be empty`).toBeGreaterThan(0)
  return entries
}

function sorted(entries: ParsedEntry[]): ParsedEntry[] {
  return entries.toSorted((left, right) => left.key.localeCompare(right.key))
}

function expectUnique(entries: ParsedEntry[], label: string): void {
  expect(new Set(entries.map((entry) => entry.key)).size, `${label} contains duplicate keys`).toBe(
    entries.length
  )
}

describe('ContextWindows.swift drift guard', () => {
  const typescriptModels = parseTypeScriptEntries(
    extractBlock(
      typescriptSource,
      /const CONTEXT_WINDOWS_BY_MODEL[^=]*=\s*\{([\s\S]*?)\n\}/,
      'CONTEXT_WINDOWS_BY_MODEL'
    ),
    'CONTEXT_WINDOWS_BY_MODEL'
  )
  const swiftModels = parseSwiftEntries(
    extractBlock(swiftSource, /static let byModel[^=]*=\s*\[([\s\S]*?)\n\s*\]/, 'byModel'),
    'byModel'
  )
  const typescriptFallbacks = parseTypeScriptEntries(
    extractBlock(
      typescriptSource,
      /const PROVIDER_FALLBACK_WINDOW[^=]*=\s*\{([\s\S]*?)\n\}/,
      'PROVIDER_FALLBACK_WINDOW'
    ),
    'PROVIDER_FALLBACK_WINDOW'
  )
  const swiftFallbacks = parseSwiftEntries(
    extractBlock(
      swiftSource,
      /static let providerFallback[^=]*=\s*\[([\s\S]*?)\n\s*\]/,
      'providerFallback'
    ),
    'providerFallback'
  )

  it('keeps every model window synchronized', () => {
    expectUnique(typescriptModels, 'CONTEXT_WINDOWS_BY_MODEL')
    expectUnique(swiftModels, 'ContextWindows.byModel')
    expect(sorted(swiftModels)).toEqual(sorted(typescriptModels))
  })

  it('keeps every provider fallback synchronized', () => {
    expectUnique(typescriptFallbacks, 'PROVIDER_FALLBACK_WINDOW')
    expectUnique(swiftFallbacks, 'ContextWindows.providerFallback')
    expect(sorted(swiftFallbacks)).toEqual(sorted(typescriptFallbacks))
  })
})

describe('resolveContextWindow provider-specific Grok windows', () => {
  it('keeps both Muse Spark routes on the explicit conservative window', () => {
    expect(resolveContextWindow('muse', 'muse-spark-1.2')).toBe(200_000)
    expect(resolveContextWindow('muse', 'muse-spark-1.2-contributor')).toBe(200_000)
  })

  it('falls the Devin ACP seat back to its 262K provider window', () => {
    expect(resolveContextWindow('devin', 'devin-1')).toBe(262_144)
  })

  it('uses Kimi K3 long-context window for the K3 (1M) model', () => {
    expect(resolveContextWindow('kimi', 'kimi-k3')).toBe(1_048_576)
    expect(resolveContextWindow('kimi', 'kimi-k3-256k')).toBe(262_144)
  })

  it('uses the direct Grok 4.6 500K window', () => {
    expect(resolveContextWindow('grok', 'grok-4.6')).toBe(500_000)
  })

  it.each([
    'grok-4.6',
    'cursor-grok-4.6-low',
    'cursor-grok-4.6-low-fast',
    'cursor-grok-4.6-medium',
    'cursor-grok-4.6-medium-fast',
    'cursor-grok-4.6-high',
    'cursor-grok-4.6-high-fast',
    'cursor-grok-4.6-xhigh',
    'cursor-grok-4.6-xhigh-fast'
  ])('uses the Cursor-hosted 256K Grok 4.6 window for %s', (modelId) => {
    expect(resolveContextWindow('cursor', modelId)).toBe(256_000)
  })

  it('keeps explicit run stats ahead of provider-specific overrides', () => {
    expect(resolveContextWindow('cursor', 'grok-4.6', 384_000)).toBe(384_000)
  })

  it('keeps live Ollama limits ahead of the global model table', () => {
    expect(resolveContextWindow('ollama', 'grok-4.5', undefined, 192_000)).toBe(192_000)
  })
})

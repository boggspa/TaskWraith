import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
    ...block.matchAll(
      /^\s*(?:'([^']+)'|([A-Za-z0-9_-]+)):\s*([0-9_]+),?\s*(?:\/\/.*)?$/gm
    )
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

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_ACTIVITY_SCANNER_PROVIDER_IDS,
  EXTERNAL_ACTIVITY_SCANNER_PROVIDERS,
  isTaskWraithOnlyProvider
} from './externalActivityScannerProviders'

const REPO_ROOT = join(__dirname, '..', '..')

/**
 * Read a hand-written provider set out of a renderer module's source.
 *
 * Deliberately textual rather than an import: these are runtime RENDERER
 * modules, and `guard:architecture` admits no renderer edge from shared code.
 * A test may read the file; the shipped module may not import it.
 */
function providerSetFromSource(relativePath: string, constantName: string): string[] {
  const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8')
  const declaration = new RegExp(`${constantName}[^=]*=[^[]*\\[([^\\]]*)\\]`, 's').exec(source)
  if (!declaration) throw new Error(`Could not find ${constantName} in ${relativePath}`)
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

describe('external activity scanner providers', () => {
  it('exposes the set and the id list consistently', () => {
    expect([...EXTERNAL_ACTIVITY_SCANNER_PROVIDERS].sort()).toEqual(
      [...EXTERNAL_ACTIVITY_SCANNER_PROVIDER_IDS].sort()
    )
  })

  it('treats a provider with no scanner lane as TaskWraith-only', () => {
    expect(isTaskWraithOnlyProvider('ollama')).toBe(true)
    expect(isTaskWraithOnlyProvider('mistral')).toBe(true)
    expect(isTaskWraithOnlyProvider('antigravity')).toBe(true)
    expect(isTaskWraithOnlyProvider(undefined)).toBe(true)
  })

  it('treats a scanned provider as external-only', () => {
    for (const provider of EXTERNAL_ACTIVITY_SCANNER_PROVIDER_IDS) {
      expect(isTaskWraithOnlyProvider(provider)).toBe(false)
    }
  })

  // Drift between these copies is a known defect class: when the Settings
  // model-usage tables fell out of step, Pi/Mistral/AntiGravity rows silently
  // vanished for anyone with External Usage on. Adding a scanner lane has to
  // update every copy, and this is what says so out loud.
  it('matches the renderer presentation copy', () => {
    expect(
      providerSetFromSource(
        'src/renderer/src/lib/externalActivityPresentation.ts',
        'EXTERNAL_ACTIVITY_SCANNER_PROVIDERS'
      ).sort()
    ).toEqual([...EXTERNAL_ACTIVITY_SCANNER_PROVIDER_IDS].sort())
  })

  it('matches the model-usage table copy', () => {
    expect(
      providerSetFromSource(
        'src/renderer/src/lib/modelUsageTable.ts',
        'EXTERNALLY_SCANNED_PROVIDERS'
      ).sort()
    ).toEqual([...EXTERNAL_ACTIVITY_SCANNER_PROVIDER_IDS].sort())
  })
})

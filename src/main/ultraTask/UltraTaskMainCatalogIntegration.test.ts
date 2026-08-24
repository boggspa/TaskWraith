import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('UltraTask live model catalog integration', () => {
  it('publishes exact capability metadata to desktop, remote, and execution consumers', () => {
    const catalog = sourceBetween(
      'const listAgentModelsForProvider = async',
      'listUltraTaskModelsRef = listAgentModelsForProvider'
    )

    expect(indexSource).toContain('mergeUltraTaskCatalogCapabilityMetadata,')
    expect(indexSource).toContain('materializeDiscoveredUltraTaskSupport,')
    expect(catalog).toContain('const staticFallback = getStaticProviderModels(provider,')
    expect(catalog).toContain('const publishLiveModels =')
    expect(catalog.match(/publishLiveModels\(/g)).toHaveLength(3)
    expect(catalog).toContain('return staticFallback')
    expect(catalog).not.toContain('ultraTaskSupported: true')
  })
})

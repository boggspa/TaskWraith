import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start, `Missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0)
  expect(end, `Missing end marker: ${endMarker}`).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('provider seat generation main-process integration', () => {
  it('plans after main-owned exact MCP profile resolution and rotates before dispatch', () => {
    const runtimeProfile = sourceBetween(
      'function applyRuntimeProfileToPayload(',
      'async function getCliProviderStatus('
    )
    const exactResolution = runtimeProfile.indexOf('const resolution = resolveTaskWraithMcpProfile({')
    const generation = runtimeProfile.indexOf('applyProviderSeatGeneration({')
    const fence = runtimeProfile.indexOf('refreshTaskWraithMcpProfileFenceStoreIdentity(applied)')

    expect(exactResolution).toBeGreaterThanOrEqual(0)
    expect(generation).toBeGreaterThan(exactResolution)
    expect(fence).toBeGreaterThan(generation)
    expect(runtimeProfile).toContain('providerSessionId: null')
    expect(runtimeProfile).toContain('storeProviderSessionId: null')
  })

  it('fingerprints stable seat prefix configuration without hashing user prompts', () => {
    const generationInput = sourceBetween(
      'function providerSeatGenerationInputForPayload(',
      'function saveProviderSeatGeneration('
    )

    expect(generationInput).toContain("fingerprintProviderSeatPrefix('system'")
    expect(generationInput).toContain('TASKWRAITH_RUNTIME_PREAMBLE_VERSION')
    expect(generationInput).toContain("fingerprintProviderSeatPrefix('tools'")
    expect(generationInput).not.toContain('payload.prompt')
  })

  it('persists provider-reported cache evidence from the terminal lifecycle seam', () => {
    const listener = sourceBetween(
      'runManager.onChange((event) => {',
      'function flushBackgroundSubThreadTranscript('
    )

    expect(listener).toContain('recordProviderSeatCacheEvidenceForRun(event.session)')
    expect(indexSource).toContain('recordProviderSeatCacheEvidence(target.generation, stats')
    expect(indexSource).toContain("eventType: 'provider_seat_cache_evidence'")
  })

  it('preserves the frozen Codex startup lease and canonical gateway target dispatch', () => {
    expect(indexSource).toContain('codexAppServerStartupLeaseCount')
    expect(indexSource).toContain('shouldRestartCodexAppServerForMcpConfig')
    expect(indexSource).toContain('dispatchResolvedGatewayTarget({')
    expect(indexSource).toContain('executeCanonical: executeGeminiMcpTool')
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX } from '../../shared/antigravityGeminiApiModelNaming'
import { readHostStandaloneAntigravityInventory } from './HostStandaloneAntigravityCatalog'

const profiles: string[] = []

function profile(settings: Record<string, unknown>): string {
  const path = mkdtempSync(join(tmpdir(), 'host-antigravity-catalog-'))
  profiles.push(path)
  writeFileSync(join(path, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
  writeFileSync(
    join(path, 'antigravity-gemini-api-key.json'),
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'taskwraith:antigravity-gemini-api-key-envelope:v1',
      updatedAt: '2026-08-30T23:00:00.000Z',
      encryptedPayload: 'AAAA'
    }),
    { mode: 0o600 }
  )
  return path
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('readHostStandaloneAntigravityInventory', () => {
  it('publishes consented AGY floor rows and configured API rows without reading a key', () => {
    const path = profile({
      antigravityEnabled: true,
      antigravityOptInAcceptedAt: 1_700_000_000_000,
      antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_001
    })

    const rows = readHostStandaloneAntigravityInventory(path, { agyBinaryAvailable: true })

    expect(rows).toHaveLength(23)
    expect(rows.map((row) => row.modelId)).toEqual(
      expect.arrayContaining([
        'gemini-3.7-flash-high',
        'claude-opus-4-6',
        `${ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX}gemini-3.6-flash`,
        `${ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX}gemini-3.1-flash-lite`
      ])
    )
  })

  it('prefers the main-written live rows and keeps the API/AGY lanes separate', () => {
    const path = profile({
      antigravityEnabled: true,
      antigravityOptInAcceptedAt: 1_700_000_000_000,
      antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_001
    })
    writeFileSync(
      join(path, 'antigravity-combined-models.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-08-30T23:01:00.000Z',
        models: [
          { id: 'agy-live', label: 'AGY Live' },
          { id: 'gemini-api:gemini-4.0-flash', label: '4.0 Flash' },
          { id: 'gemini-api:not safe!', label: 'Ignored' }
        ]
      }),
      { mode: 0o600 }
    )

    const rows = readHostStandaloneAntigravityInventory(path, { agyBinaryAvailable: true })

    expect(rows[0]).toEqual({ modelId: 'agy-live', label: 'AGY Live' })
    expect(rows).toContainEqual({ modelId: 'gemini-api:gemini-4.0-flash', label: '4.0 Flash' })
    expect(rows.map((row) => row.modelId)).not.toContain('gemini-api:not safe!')
  })

  it('does not publish AGY rows without its binary and does not publish API rows without disclosure', () => {
    const noBinary = profile({
      antigravityEnabled: true,
      antigravityOptInAcceptedAt: 1_700_000_000_000,
      antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_001
    })
    const apiOnly = readHostStandaloneAntigravityInventory(noBinary, {
      agyBinaryAvailable: false
    })
    expect(apiOnly.map((row) => row.modelId)).not.toContain('gemini-3.7-flash-high')
    expect(apiOnly.map((row) => row.modelId)).toContain('gemini-api:gemini-3.6-flash')

    const noDisclosure = profile({
      antigravityEnabled: true,
      antigravityOptInAcceptedAt: 1_700_000_000_000
    })
    const agyOnly = readHostStandaloneAntigravityInventory(noDisclosure, {
      agyBinaryAvailable: true
    })
    expect(agyOnly.map((row) => row.modelId)).toContain('gemini-3.7-flash-high')
    expect(agyOnly.some((row) => row.modelId.startsWith('gemini-api:'))).toBe(false)
  })
})

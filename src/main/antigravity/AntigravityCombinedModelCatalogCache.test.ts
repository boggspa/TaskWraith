import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { sanitizeAntigravityCatalogCache } from '../../shared/antigravityCatalogCache.node'
import { discoverAuthenticatedAntigravityCombinedModels } from './AntigravityCombinedModelCatalog'

const paths: string[] = []

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('mirrors the combined non-secret rows for the external Host', async () => {
  const path = mkdtempSync(join(tmpdir(), 'antigravity-combined-catalog-'))
  paths.push(path)
  const store = { loadApiKey: () => ({ status: 'ok' as const, value: 'not-written' }) }

  await expect(
    discoverAuthenticatedAntigravityCombinedModels(
      {
        antigravityEnabled: true,
        antigravityOptInAcceptedAt: 1,
        antigravityGeminiApiDisclosureAcceptedAt: 2
      },
      {
        discoverAgy: async () => [{ id: 'agy-live', label: 'AGY Live' }],
        discoverGeminiApi: async () => ({
          status: 'ok' as const,
          models: [
            {
              id: 'gemini-api:gemini-4.0-flash' as `gemini-api:${string}`,
              modelId: 'gemini-4.0-flash'
            }
          ]
        }),
        getSecretStore: () => store,
        agyDependencies: { cache: { userDataPath: path } }
      }
    )
  ).resolves.toEqual([
    { id: 'agy-live', label: 'AGY Live' },
    { id: 'gemini-api:gemini-4.0-flash', label: '4.0 Flash' }
  ])

  await vi.waitFor(
    () => {
      const parsed = JSON.parse(
        readFileSync(join(path, 'antigravity-combined-models.json'), 'utf8')
      ) as unknown
      expect(sanitizeAntigravityCatalogCache(parsed)).toEqual([
        { id: 'agy-live', label: 'AGY Live' },
        { id: 'gemini-api:gemini-4.0-flash', label: '4.0 Flash' }
      ])
    },
    { timeout: 2_000 }
  )
})

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import {
  antigravityCombinedCatalogCachePath,
  sanitizeAntigravityCatalogCache,
  writeAntigravityCatalogCache
} from './antigravityCatalogCache.node'

const paths: string[] = []

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('writes a bounded non-secret combined catalog that the Host can validate', async () => {
  const path = mkdtempSync(join(tmpdir(), 'antigravity-combined-cache-'))
  paths.push(path)

  await writeAntigravityCatalogCache(
    path,
    [
      { id: 'agy-model', label: 'AGY Model' },
      { id: 'gemini-api:gemini-3.6-flash', label: '3.6 Flash' },
      { id: 'unsafe model', label: 'Ignored' }
    ],
    () => '2026-08-30T23:00:00.000Z'
  )

  const parsed = JSON.parse(
    readFileSync(antigravityCombinedCatalogCachePath(path), 'utf8')
  ) as unknown
  expect(sanitizeAntigravityCatalogCache(parsed)).toEqual([
    { id: 'agy-model', label: 'AGY Model' },
    { id: 'gemini-api:gemini-3.6-flash', label: '3.6 Flash' }
  ])
})

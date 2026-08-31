/**
 * Non-secret, profile-local bridge for the combined AntiGravity catalogue.
 *
 * Electron owns the Gemini API key and its live SDK discovery. The external
 * Host must not decrypt or receive that key, but it does need the same model
 * rows for its read-only provider projection. Main writes this bounded cache;
 * the Host reads only the validated ids and labels.
 */

import { randomBytes } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

export const ANTIGRAVITY_COMBINED_CATALOG_CACHE_FILENAME = 'antigravity-combined-models.json'
export const ANTIGRAVITY_COMBINED_CATALOG_CACHE_VERSION = 1

const MAX_CACHED_MODELS = 128
const MAX_ID_LENGTH = 512
const MAX_LABEL_LENGTH = 200
// eslint-disable-next-line no-control-regex -- cached catalog metadata rejects C0 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

export interface AntigravityCatalogCacheModel {
  readonly id: string
  readonly label: string
}

export interface AntigravityCatalogCacheRecord {
  readonly version: typeof ANTIGRAVITY_COMBINED_CATALOG_CACHE_VERSION
  readonly updatedAt: string
  readonly models: readonly AntigravityCatalogCacheModel[]
}

export function antigravityCombinedCatalogCachePath(userDataPath: string): string {
  return join(userDataPath, ANTIGRAVITY_COMBINED_CATALOG_CACHE_FILENAME)
}

function canonicalProfilePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    value.trim() === value &&
    isAbsolute(value) &&
    resolve(value) === value &&
    value !== parse(value).root &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function sanitizeModel(value: unknown): AntigravityCatalogCacheModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as { id?: unknown; label?: unknown }
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (
    !id ||
    !label ||
    id.length > MAX_ID_LENGTH ||
    label.length > MAX_LABEL_LENGTH ||
    !SAFE_MODEL_ID.test(id) ||
    CONTROL_CHARACTERS.test(id) ||
    CONTROL_CHARACTERS.test(label)
  ) {
    return null
  }
  return { id, label }
}

/** Pure half: validate a parsed cache record into bounded model rows. */
export function sanitizeAntigravityCatalogCache(value: unknown): AntigravityCatalogCacheModel[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as { version?: unknown; models?: unknown }
  if (record.version !== ANTIGRAVITY_COMBINED_CATALOG_CACHE_VERSION) return []
  if (!Array.isArray(record.models)) return []

  const models: AntigravityCatalogCacheModel[] = []
  const seen = new Set<string>()
  for (const entry of record.models) {
    if (models.length >= MAX_CACHED_MODELS) break
    const model = sanitizeModel(entry)
    if (!model) continue
    const key = model.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    models.push(model)
  }
  return models
}

function safeUserDataPath(value: unknown): value is string {
  return canonicalProfilePath(value)
}

/**
 * Best-effort atomic write. A cache failure never changes the catalogue
 * returned to the current main-process caller.
 */
export async function writeAntigravityCatalogCache(
  userDataPath: string | undefined,
  models: readonly AntigravityCatalogCacheModel[],
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  if (!safeUserDataPath(userDataPath)) return

  const sanitized = sanitizeAntigravityCatalogCache({
    version: ANTIGRAVITY_COMBINED_CATALOG_CACHE_VERSION,
    models
  })
  const path = antigravityCombinedCatalogCachePath(userDataPath)
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  const record: AntigravityCatalogCacheRecord = {
    version: ANTIGRAVITY_COMBINED_CATALOG_CACHE_VERSION,
    updatedAt: now(),
    models: sanitized
  }

  try {
    await fsPromises.mkdir(userDataPath, { recursive: true, mode: 0o700 })
    await fsPromises.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await fsPromises.rename(temporaryPath, path)
    if (process.platform !== 'win32') await fsPromises.chmod(path, 0o600)
  } catch {
    try {
      await fsPromises.unlink(temporaryPath)
    } catch {
      // Preserve the best-effort cache contract.
    }
  }
}

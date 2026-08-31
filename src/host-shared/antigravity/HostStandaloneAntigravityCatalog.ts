/**
 * Read-only AntiGravity catalog projection for the external Node Host.
 *
 * The AGY lane is guarded by the existing opt-in and binary gate. The Gemini
 * API lane is owned by Electron because its key is encrypted with
 * safeStorage; this module reads only the disclosure bit, envelope shape, and
 * main-written non-secret model ids/labels. It never decrypts or returns key
 * material.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import {
  ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX,
  antigravityGeminiApiModelLabel
} from '../../shared/antigravityGeminiApiModelNaming'
import {
  ANTIGRAVITY_AGY_STATIC_MODEL_IDS,
  ANTIGRAVITY_GEMINI_API_STATIC_MODEL_IDS
} from '../../shared/antigravityStaticModelIds'
import {
  antigravityCombinedCatalogCachePath,
  sanitizeAntigravityCatalogCache,
  type AntigravityCatalogCacheModel
} from '../../shared/antigravityCatalogCache.node'
import { readHostStandaloneAntigravityConsent } from './HostStandaloneAntigravityAdmission'

const AGY_MODEL_CACHE_FILENAME = 'antigravity-agy-models.json'
const AGY_MODEL_CACHE_VERSION = 1
const ANTIGRAVITY_GEMINI_API_SECRET_FILENAME = 'antigravity-gemini-api-key.json'
const ANTIGRAVITY_GEMINI_API_ENVELOPE_PURPOSE = 'taskwraith:antigravity-gemini-api-key-envelope:v1'
const MAX_PROFILE_JSON_BYTES = 512 * 1024
const MAX_CATALOG_ROWS = 128
const MAX_MODEL_ID_CHARS = 512
const MAX_MODEL_LABEL_CHARS = 200
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const SAFE_API_MODEL_ID = /^gemini-api:gemini-[a-z0-9][a-z0-9._-]{0,127}$/
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
// eslint-disable-next-line no-control-regex -- profile metadata rejects C0 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export interface HostStandaloneAntigravityCatalogRow {
  readonly modelId: string
  readonly label: string
}

export interface HostStandaloneAntigravityCatalogOptions {
  /** The caller's resolved official `agy` binary status. */
  readonly agyBinaryAvailable: boolean
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

function readJson(path: string): unknown | null {
  let descriptor: number | null = null
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2) return null
    if (before.size > MAX_PROFILE_JSON_BYTES) return null
    descriptor = openSync(
      path,
      constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0)
    )
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size < 2 || opened.size > MAX_PROFILE_JSON_BYTES) return null
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
  } catch {
    return null
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function inventoryRow(
  idValue: unknown,
  labelValue: unknown
): HostStandaloneAntigravityCatalogRow | null {
  const id = typeof idValue === 'string' ? idValue.trim() : ''
  const label = typeof labelValue === 'string' ? labelValue.trim() : ''
  if (
    !id ||
    !label ||
    id.length > MAX_MODEL_ID_CHARS ||
    label.length > MAX_MODEL_LABEL_CHARS ||
    !SAFE_MODEL_ID.test(id) ||
    CONTROL_CHARACTERS.test(id) ||
    CONTROL_CHARACTERS.test(label)
  ) {
    return null
  }
  return { modelId: id, label }
}

function appendUnique(
  rows: HostStandaloneAntigravityCatalogRow[],
  seen: Set<string>,
  candidate: HostStandaloneAntigravityCatalogRow | null
): void {
  if (!candidate || rows.length >= MAX_CATALOG_ROWS) return
  const key = candidate.modelId.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  rows.push(candidate)
}

function readAgyCache(profilePath: string): HostStandaloneAntigravityCatalogRow[] {
  const parsed = readJson(join(profilePath, AGY_MODEL_CACHE_FILENAME))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const record = parsed as { version?: unknown; models?: unknown }
  if (record.version !== AGY_MODEL_CACHE_VERSION || !Array.isArray(record.models)) return []

  const rows: HostStandaloneAntigravityCatalogRow[] = []
  const seen = new Set<string>()
  for (const entry of record.models) {
    if (rows.length >= MAX_CATALOG_ROWS || !entry || typeof entry !== 'object') break
    const model = entry as { id?: unknown; label?: unknown }
    const row = inventoryRow(model.id, model.label ?? model.id)
    if (!row || row.modelId.startsWith(ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX)) continue
    appendUnique(rows, seen, row)
  }
  return rows
}

function readCombinedCache(profilePath: string): AntigravityCatalogCacheModel[] {
  return sanitizeAntigravityCatalogCache(readJson(antigravityCombinedCatalogCachePath(profilePath)))
}

function readSettings(profilePath: string): Record<string, unknown> | null {
  const parsed = readJson(join(profilePath, 'settings.json'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function acceptedTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Presence-only API-key check; encryptedPayload is never returned or logged. */
function hasConfiguredGeminiApiEnvelope(profilePath: string): boolean {
  const parsed = readJson(join(profilePath, ANTIGRAVITY_GEMINI_API_SECRET_FILENAME))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const envelope = parsed as {
    schemaVersion?: unknown
    purpose?: unknown
    updatedAt?: unknown
    encryptedPayload?: unknown
  }
  return (
    envelope.schemaVersion === 1 &&
    envelope.purpose === ANTIGRAVITY_GEMINI_API_ENVELOPE_PURPOSE &&
    typeof envelope.updatedAt === 'string' &&
    Number.isFinite(Date.parse(envelope.updatedAt)) &&
    typeof envelope.encryptedPayload === 'string' &&
    envelope.encryptedPayload.length > 0 &&
    envelope.encryptedPayload.length <= 64 * 1024 &&
    CANONICAL_BASE64.test(envelope.encryptedPayload)
  )
}

function isApiModelId(value: string): boolean {
  return SAFE_API_MODEL_ID.test(value)
}

function staticAgyRows(): HostStandaloneAntigravityCatalogRow[] {
  return ANTIGRAVITY_AGY_STATIC_MODEL_IDS.map((modelId) => ({
    modelId,
    label: modelId
  }))
}

function staticApiRows(): HostStandaloneAntigravityCatalogRow[] {
  return ANTIGRAVITY_GEMINI_API_STATIC_MODEL_IDS.map((modelId) => ({
    modelId: `${ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX}${modelId}`,
    label: antigravityGeminiApiModelLabel(modelId)
  }))
}

/**
 * Return all non-secret AntiGravity rows the Host may publish in its provider
 * inventory. Runtime AGY offers are merged by the registry separately, so a
 * failed live probe cannot erase a consented cached/floor catalog.
 */
export function readHostStandaloneAntigravityInventory(
  profilePath: string,
  options: HostStandaloneAntigravityCatalogOptions
): HostStandaloneAntigravityCatalogRow[] {
  if (!canonicalProfilePath(profilePath)) return []

  const rows: HostStandaloneAntigravityCatalogRow[] = []
  const seen = new Set<string>()
  const combined = readCombinedCache(profilePath)
  const consent = readHostStandaloneAntigravityConsent(profilePath)
  if (options.agyBinaryAvailable === true && consent.accepted) {
    for (const entry of combined) {
      if (!isApiModelId(entry.id)) appendUnique(rows, seen, inventoryRow(entry.id, entry.label))
    }
    for (const row of readAgyCache(profilePath)) appendUnique(rows, seen, row)
    // Match Electron main's live-wins contract: the floor recovers an empty
    // catalogue, but must not append aliases or withdrawn rows to a healthy one.
    if (rows.length === 0) {
      for (const row of staticAgyRows()) appendUnique(rows, seen, row)
    }
  }

  const settings = readSettings(profilePath)
  const apiDisclosureAccepted = acceptedTimestamp(
    settings?.antigravityGeminiApiDisclosureAcceptedAt
  )
  if (apiDisclosureAccepted && hasConfiguredGeminiApiEnvelope(profilePath)) {
    for (const entry of combined) {
      if (isApiModelId(entry.id)) appendUnique(rows, seen, inventoryRow(entry.id, entry.label))
    }
    for (const row of staticApiRows()) appendUnique(rows, seen, row)
  }

  return rows
}

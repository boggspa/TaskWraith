import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import {
  KIMI_256K_CONTEXT_WINDOW,
  KIMI_HIGHSPEED_CLI_MODEL,
  KIMI_K27_HIGHSPEED_MODEL_ID,
  KIMI_K27_HIGHSPEED_MODEL_LABEL,
  KIMI_K28_MODEL_ID,
  KIMI_K28_MODEL_LABEL,
  KIMI_K31_PRO_API_MODEL,
  KIMI_K31_PRO_CLI_MODEL,
  KIMI_K31_PRO_MODEL_ID,
  KIMI_K31_PRO_MODEL_LABEL,
  KIMI_K3_LONG_CONTEXT_WINDOW,
  KIMI_K3_REASONING_EFFORTS,
  KIMI_STANDARD_CLI_MODEL
} from '../../shared/kimiModels'
import { effectiveKimiModelContextWindow } from './KimiModelContext'

export interface KimiManagedModelRow {
  id: string
  label?: string
  description?: string
  isDefault?: boolean
  disabled?: boolean
  disabledReason?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    description?: string
    disabled?: boolean
    disabledReason?: string
  }>
  defaultReasoningEffort?: string | null
  additionalSpeedTiers?: string[]
  ultraTaskSupported?: boolean
  contextWindow?: number
}

interface ParsedKimiModelAlias {
  alias: string
  modelId?: string
  displayName?: string
  supportEfforts?: string[]
  defaultEffort?: string
  maxContextSize?: number
}

// Kimi Code still configures `kimi-code/k3` and `kimi-code/k3-256k`, but both
// left TaskWraith's pickers for K3.1 Pro on 2026-10-27 (user decision), so they
// are deliberately not read: the live projection must not resurrect them.
const MANAGED_KIMI_ALIASES = new Set([
  KIMI_STANDARD_CLI_MODEL,
  KIMI_HIGHSPEED_CLI_MODEL,
  KIMI_K31_PRO_CLI_MODEL
])
const EXPECTED_UPSTREAM_MODEL = new Map([
  [KIMI_STANDARD_CLI_MODEL, 'kimi-for-coding'],
  [KIMI_HIGHSPEED_CLI_MODEL, 'kimi-for-coding-highspeed'],
  [KIMI_K31_PRO_CLI_MODEL, KIMI_K31_PRO_API_MODEL]
])

function modelSection(line: string): { alias: string; override: boolean } | null {
  const match = line.match(
    /^\s*\[\s*models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(\.overrides)?\s*\]\s*(?:#.*)?$/
  )
  if (!match) return null
  return { alias: match[1] || match[2] || match[3], override: Boolean(match[4]) }
}

function stringAssignment(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`))
  return match?.[2]?.trim() || undefined
}

function stringArrayAssignment(line: string, key: string): string[] | undefined {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[(.*)\\]\\s*(?:#.*)?$`))
  if (!match) return undefined
  const values = [...match[1].matchAll(/(["'])(.*?)\1/g)]
    .map((item) => item[2].trim().toLowerCase())
    .filter(Boolean)
  return values.length > 0 ? values : []
}

/**
 * Read only the three offered managed model tables from Kimi's config. Provider tables,
 * OAuth data, API keys, and all unrelated settings are deliberately ignored.
 */
export function parseKimiManagedModelAliases(
  configBody: string
): Map<string, ParsedKimiModelAlias> {
  const aliases = new Map<string, ParsedKimiModelAlias>()
  let section: { alias: string; override: boolean } | null = null

  for (const line of configBody.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      section = modelSection(line)
      if (
        section &&
        !section.override &&
        MANAGED_KIMI_ALIASES.has(section.alias) &&
        !aliases.has(section.alias)
      ) {
        aliases.set(section.alias, { alias: section.alias })
      }
      continue
    }
    if (!section || section.override || !MANAGED_KIMI_ALIASES.has(section.alias)) continue
    const alias = aliases.get(section.alias)
    if (!alias) continue

    const displayName = stringAssignment(line, 'display_name')
    if (displayName) alias.displayName = displayName
    const modelId = stringAssignment(line, 'model')
    if (modelId) alias.modelId = modelId.toLowerCase()
    const supportEfforts = stringArrayAssignment(line, 'support_efforts')
    if (supportEfforts) alias.supportEfforts = supportEfforts
    const defaultEffort = stringAssignment(line, 'default_effort')
    if (defaultEffort) alias.defaultEffort = defaultEffort.toLowerCase()
  }

  for (const [aliasId, alias] of aliases) {
    const expected = EXPECTED_UPSTREAM_MODEL.get(aliasId)
    if (alias.modelId && alias.modelId !== expected) aliases.delete(aliasId)
  }
  for (const alias of aliases.values()) {
    alias.maxContextSize = effectiveKimiModelContextWindow(configBody, alias.alias)
  }
  return aliases
}

function reasoningMetadata(
  alias: ParsedKimiModelAlias,
  fallback: KimiManagedModelRow
): Pick<KimiManagedModelRow, 'supportedReasoningEfforts' | 'defaultReasoningEffort'> {
  const allowed = new Set<string>(KIMI_K3_REASONING_EFFORTS)
  const efforts = alias.supportEfforts
    ?.filter((reasoningEffort) => allowed.has(reasoningEffort))
    .map((reasoningEffort) => ({ reasoningEffort }))
  const enabled = new Set(efforts?.map((item) => item.reasoningEffort) ?? [])
  const defaultEffort =
    alias.defaultEffort && enabled.has(alias.defaultEffort)
      ? alias.defaultEffort
      : fallback.defaultReasoningEffort
  return {
    supportedReasoningEfforts: efforts?.length ? efforts : fallback.supportedReasoningEfforts,
    defaultReasoningEffort: defaultEffort
  }
}

export function projectKimiManagedModelRows(
  configBody: string,
  fallbackRows: readonly KimiManagedModelRow[]
): KimiManagedModelRow[] | null {
  const aliases = parseKimiManagedModelAliases(configBody)
  if (aliases.size === 0) return null

  const fallback = new Map(fallbackRows.map((row) => [row.id, row]))
  const projected = new Map<string, KimiManagedModelRow>()
  const standard = aliases.get(KIMI_STANDARD_CLI_MODEL)
  const standardFallback = fallback.get(KIMI_K28_MODEL_ID)
  if (standard && standardFallback) {
    // The standard route carries its own effort ladder now (K2.8 Preview took
    // K3's Low/High/Max axis), so read it from the config like the K3 rows
    // rather than pinning the retired always-on stop.
    projected.set(KIMI_K28_MODEL_ID, {
      ...standardFallback,
      label: standard.displayName || KIMI_K28_MODEL_LABEL,
      ...reasoningMetadata(standard, standardFallback),
      ...(standard.maxContextSize ? { contextWindow: standard.maxContextSize } : {})
    })
  }

  const highspeed = aliases.get(KIMI_HIGHSPEED_CLI_MODEL)
  const highspeedFallback = fallback.get(KIMI_K27_HIGHSPEED_MODEL_ID)
  if (highspeed && highspeedFallback) {
    projected.set(KIMI_K27_HIGHSPEED_MODEL_ID, {
      ...highspeedFallback,
      label: highspeed.displayName || KIMI_K27_HIGHSPEED_MODEL_LABEL,
      contextWindow: highspeed.maxContextSize || KIMI_256K_CONTEXT_WINDOW
    })
  }

  const k31Pro = aliases.get(KIMI_K31_PRO_CLI_MODEL)
  const k31ProFallback = fallback.get(KIMI_K31_PRO_MODEL_ID)
  if (k31Pro && k31ProFallback) {
    // Kimi Code's display name is the plain "K3.1 Pro"; keep TaskWraith's label
    // so a renamed config row cannot drift the picker away from the transcript.
    projected.set(KIMI_K31_PRO_MODEL_ID, {
      ...k31ProFallback,
      label: KIMI_K31_PRO_MODEL_LABEL,
      ...reasoningMetadata(k31Pro, k31ProFallback),
      contextWindow: k31Pro.maxContextSize || KIMI_K3_LONG_CONTEXT_WINDOW
    })
  }

  const rows = fallbackRows.flatMap((row) => {
    const item = projected.get(row.id)
    return item ? [item] : []
  })
  return rows.length > 0 ? rows : null
}

export async function discoverKimiManagedModelRows(
  sourceHome: string,
  fallbackRows: readonly KimiManagedModelRow[],
  readFile: (path: string) => Promise<string> = (path) => fs.readFile(path, 'utf8')
): Promise<KimiManagedModelRow[] | null> {
  try {
    const configBody = await readFile(join(sourceHome, 'config.toml'))
    return projectKimiManagedModelRows(configBody, fallbackRows)
  } catch {
    return null
  }
}

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import {
  KIMI_HIGHSPEED_CLI_MODEL,
  KIMI_K27_MODEL_ID,
  KIMI_K3_256K_CLI_MODEL,
  KIMI_K3_256K_MODEL_ID,
  KIMI_K3_CLI_MODEL,
  KIMI_K3_LONG_CONTEXT_WINDOW,
  KIMI_K3_MODEL_ID,
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

const MANAGED_KIMI_ALIASES = new Set([
  KIMI_STANDARD_CLI_MODEL,
  KIMI_HIGHSPEED_CLI_MODEL,
  KIMI_K3_CLI_MODEL,
  KIMI_K3_256K_CLI_MODEL
])
const EXPECTED_UPSTREAM_MODEL = new Map([
  [KIMI_STANDARD_CLI_MODEL, 'kimi-for-coding'],
  [KIMI_HIGHSPEED_CLI_MODEL, 'kimi-for-coding-highspeed'],
  [KIMI_K3_CLI_MODEL, 'k3'],
  [KIMI_K3_256K_CLI_MODEL, 'k3-256k']
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
 * Read only the four managed model tables from Kimi's config. Provider tables,
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

function k3LongRoutePresentation(alias: ParsedKimiModelAlias): {
  label: string
  description: string
} {
  if ((alias.maxContextSize || 0) >= KIMI_K3_LONG_CONTEXT_WINDOW) {
    return {
      label: 'K3 1M',
      description: 'Long-context K3 route - 1M on this Kimi plan - Low, High, or Max thinking'
    }
  }
  if (alias.maxContextSize) {
    return {
      label: 'K3 (plan-capped 256K)',
      description: 'K3 route - 256K limit on this Kimi plan - Low, High, or Max thinking'
    }
  }
  return {
    label: 'K3 (up to 1M)',
    description: 'Long-context K3 route - plan-dependent up to 1M - Low, High, or Max thinking'
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
  const standardFallback = fallback.get(KIMI_K27_MODEL_ID)
  if (standard && standardFallback) {
    const highspeedAvailable = aliases.has(KIMI_HIGHSPEED_CLI_MODEL)
    projected.set(KIMI_K27_MODEL_ID, {
      ...standardFallback,
      description: highspeedAvailable
        ? 'Standard and Highspeed tiers with always-on thinking'
        : 'Standard tier with always-on thinking',
      additionalSpeedTiers: highspeedAvailable ? ['fast'] : [],
      ...(standard.maxContextSize ? { contextWindow: standard.maxContextSize } : {})
    })
  }

  const k3 = aliases.get(KIMI_K3_CLI_MODEL)
  const k3Fallback = fallback.get(KIMI_K3_MODEL_ID)
  if (k3 && k3Fallback) {
    projected.set(KIMI_K3_MODEL_ID, {
      ...k3Fallback,
      ...k3LongRoutePresentation(k3),
      ...reasoningMetadata(k3, k3Fallback),
      ...(k3.maxContextSize ? { contextWindow: k3.maxContextSize } : {})
    })
  }

  const k3Short = aliases.get(KIMI_K3_256K_CLI_MODEL)
  const k3ShortFallback = fallback.get(KIMI_K3_256K_MODEL_ID)
  if (k3Short && k3ShortFallback) {
    projected.set(KIMI_K3_256K_MODEL_ID, {
      ...k3ShortFallback,
      label: 'K3 256K',
      description: 'Quota-efficient K3 route - fixed 256K context - Low, High, or Max thinking',
      ...reasoningMetadata(k3Short, k3ShortFallback),
      ...(k3Short.maxContextSize ? { contextWindow: k3Short.maxContextSize } : {})
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

/**
 * The model tables in the user's own Mistral Vibe config.
 *
 * Vibe reads `~/.vibe/config.toml` and merges it into the model list it
 * advertises over ACP (`build_model_config` in vibe/acp/utils.py lists
 * `config.models`, which is the defaults + the user's file + the `VIBE_*`
 * environment layer). A `[[models]]` entry there is how a user puts a model
 * on their Vibe plan: Mistral enabled Mistral Large 4 for the Vibe quota for
 * accounts whose config carries it (2026-11-02), so the entry — not a
 * TaskWraith-side allow-list — is what decides whether the plan lane exists.
 *
 * TaskWraith only READS this file. It never writes it: a `set_config_option
 * thinking=` against a model Vibe does not know materialises a full
 * `[[models]]` entry in the user's real config, and the same is true of any
 * edit made here (see MistralApiModelEnv's header for the full reason).
 *
 * The parse is a deliberately small TOML reader — only the `[[models]]`
 * array-of-tables and the scalar keys TaskWraith acts on. Anything else in
 * the file (`[tools.bash]` allowlists, `installed_agents`, the top-level
 * settings) is ignored rather than half-understood.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  MISTRAL_LARGE_4_CONTEXT_WINDOW,
  MISTRAL_LARGE_4_MODEL_ID,
  MISTRAL_LARGE_4_VIBE_ALIAS,
  MISTRAL_LARGE_4_VIBE_ROW,
  MISTRAL_REASONING_EFFORTS
} from '../../shared/mistralModels'

export interface MistralVibeConfigModel {
  /** The alias Vibe exposes the model under (`config.models[].alias`). */
  alias: string
  /** The upstream model id Vibe sends (`config.models[].name`). */
  name?: string
  /** The provider the entry points at. Vibe's default provider is `mistral`. */
  provider?: string
  /** The label the user's own config gives the model. */
  displayName?: string
  /** `max_context_length` from the entry, when it declares one. */
  contextWindow?: number
  /** `thinking` from the entry — the level the model opens at. */
  thinking?: string
  /** `supports_images` from the entry. */
  supportsImages?: boolean
}

export type MistralVibePlanRow = typeof MISTRAL_LARGE_4_VIBE_ROW & {
  supportedReasoningEfforts: Array<(typeof MISTRAL_REASONING_EFFORTS)[number]>
  ultraTaskSupported: true
  contextWindow: number
}

const MODEL_TABLE_HEADER = /^\s*\[\[\s*models\s*\]\]\s*(?:#.*)?$/
const ANY_TABLE_HEADER = /^\s*\[/

/**
 * The Vibe home whose `config.toml` the child will read.
 *
 * Vibe resolves `VIBE_HOME` and falls back to `~/.vibe` (see
 * vibe/core/paths/_vibe_home.py). TaskWraith must read the SAME file the
 * child reads — the config that matters is the one the child will use, not
 * the one this process happens to sit next to (the same rule
 * `mistralCredentialStateEvidence` already follows for the seal).
 */
export function mistralVibeHome(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const override = environment.VIBE_HOME
  return typeof override === 'string' && override.trim() ? override.trim() : join(home, '.vibe')
}

function scalarValue(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/)
  if (!match) return null
  return { key: match[1], value: match[2] }
}

function stringValue(raw: string): string | undefined {
  const match = raw.match(/^"([^"]*)"$/) || raw.match(/^'([^']*)'$/)
  return match ? match[1] : undefined
}

function numberValue(raw: string): number | undefined {
  const match = raw.match(/^-?\d+(?:\.\d+)?$/)
  if (!match) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function booleanValue(raw: string): boolean | undefined {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

/**
 * Parse the `[[models]]` entries out of a Vibe config body.
 *
 * Only Mistral-provider entries are returned: the `llamacpp` provider is a
 * local server the user runs, not a Mistral quota, and must never be treated
 * as one.
 */
export function parseMistralVibeConfigModels(configBody: string): MistralVibeConfigModel[] {
  const models: MistralVibeConfigModel[] = []
  let inModelTable = false
  let current: Record<string, string> | null = null

  const flush = (): void => {
    if (!current) return
    const alias = stringValue(current.alias ?? '')
    const provider = stringValue(current.provider ?? '') ?? 'mistral'
    if (alias && provider.toLowerCase() === 'mistral') {
      const contextWindow = numberValue(current.max_context_length ?? '')
      const supportsImages = booleanValue(current.supports_images ?? '')
      models.push({
        alias,
        ...(stringValue(current.name ?? '') ? { name: stringValue(current.name ?? '') } : {}),
        provider,
        ...(stringValue(current.display_name ?? '')
          ? { displayName: stringValue(current.display_name ?? '') }
          : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(stringValue(current.thinking ?? '')
          ? { thinking: stringValue(current.thinking ?? '') }
          : {}),
        ...(supportsImages !== undefined ? { supportsImages } : {})
      })
    }
    current = null
  }

  for (const line of configBody.split(/\r?\n/)) {
    if (MODEL_TABLE_HEADER.test(line)) {
      flush()
      inModelTable = true
      current = {}
      continue
    }
    if (ANY_TABLE_HEADER.test(line)) {
      flush()
      inModelTable = false
      continue
    }
    if (!inModelTable || !current) continue
    const scalar = scalarValue(line)
    if (!scalar) continue
    current[scalar.key] = scalar.value
  }
  flush()
  return models
}

/**
 * Read the user's Vibe config and return its Mistral model entries.
 *
 * A missing, unreadable, or malformed config yields an empty list — never an
 * error. The caller treats that as "this user has no Vibe-config models",
 * which is the same answer as a config that holds none.
 */
export async function readMistralVibeConfigModels(
  vibeHome: string
): Promise<MistralVibeConfigModel[]> {
  try {
    const body = await fs.readFile(join(vibeHome, 'config.toml'), 'utf8')
    return parseMistralVibeConfigModels(body)
  } catch {
    return []
  }
}

/** The entry a user has configured for one alias, if any. */
export function mistralVibeConfigModelByAlias(
  models: readonly MistralVibeConfigModel[],
  alias: string
): MistralVibeConfigModel | undefined {
  const wanted = alias.trim().toLowerCase()
  return models.find((model) => model.alias.trim().toLowerCase() === wanted)
}

/**
 * The seat's rows with the Vibe-plan lane for Large 4 added directly after the
 * API-key row, when the user's own config carries the model. Without the entry
 * the rows come back untouched, so the row is never offered to an account that
 * could not run it.
 */
export function withMistralVibePlanRow<T extends { id: string }>(
  rows: readonly T[],
  vibeModels: readonly MistralVibeConfigModel[]
): Array<T | MistralVibePlanRow> {
  const configured = mistralVibeConfigModelByAlias(vibeModels, MISTRAL_LARGE_4_VIBE_ALIAS)
  if (!configured) return [...rows]
  const planRow: MistralVibePlanRow = {
    ...MISTRAL_LARGE_4_VIBE_ROW,
    supportedReasoningEfforts: [...MISTRAL_REASONING_EFFORTS],
    ultraTaskSupported: true,
    contextWindow: configured.contextWindow ?? MISTRAL_LARGE_4_CONTEXT_WINDOW
  }
  const apiRowIndex = rows.findIndex((row) => row.id === MISTRAL_LARGE_4_MODEL_ID)
  const insertAt = apiRowIndex >= 0 ? apiRowIndex + 1 : rows.length
  return [...rows.slice(0, insertAt), planRow, ...rows.slice(insertAt)]
}

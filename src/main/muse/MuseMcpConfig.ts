import type { MuseSkillPinSettings } from './MuseSkillPin'

/** Per-run server name inside the isolated Muse settings document. */
export const MUSE_TASKWRAITH_MCP_SERVER_NAME = 'taskwraith'

export interface MuseStdioMcpServer {
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** A route-bound lifecycle bridge must not silently disappear at startup. */
  readonly mode: 'required'
  readonly enabled: true
}

export interface MuseMcpSettings {
  readonly mcp_servers: Readonly<Record<string, MuseStdioMcpServer>>
}

export interface MuseTaskWraithMcpInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export type MuseSettingsDocument = MuseSkillPinSettings & Partial<MuseMcpSettings>

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Muse MCP ${label} must be a non-empty string.`)
  }
  return value.trim()
}

function cloneArgs(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('Muse MCP args must be a string array.')
  }
  return Object.freeze(value.map((entry) => String(entry)))
}

function cloneEnvironment(
  value: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value || {})) {
    if (!ENVIRONMENT_KEY.test(key) || typeof entry !== 'string') {
      throw new TypeError('Muse MCP env must contain shell-safe string entries.')
    }
    out[key] = entry
  }
  return Object.freeze(out)
}

/**
 * Build the sole app-owned MCP registration Muse receives for one run.
 *
 * The broker endpoint and route environment are scoped to the isolated home
 * and deleted at run teardown. `required` is intentional: claiming lifecycle
 * tools in the prompt without a live broker would strand an Ensemble seat.
 */
export function buildMuseTaskWraithMcpSettings(
  invocation: MuseTaskWraithMcpInvocation
): MuseMcpSettings {
  const server: MuseStdioMcpServer = Object.freeze({
    transport: 'stdio' as const,
    command: requiredText(invocation.command, 'command'),
    args: cloneArgs(invocation.args),
    env: cloneEnvironment(invocation.env),
    mode: 'required' as const,
    enabled: true as const
  })
  return Object.freeze({
    mcp_servers: Object.freeze({ [MUSE_TASKWRAITH_MCP_SERVER_NAME]: server })
  })
}

/** Merge the app-owned bridge into the private, already-pinned Muse settings. */
export function mergeMuseMcpSettings(
  skillPinSettings: MuseSkillPinSettings,
  mcpSettings?: MuseMcpSettings
): MuseSettingsDocument {
  if (!mcpSettings) return skillPinSettings
  return Object.freeze({
    ...skillPinSettings,
    mcp_servers: Object.freeze({ ...mcpSettings.mcp_servers })
  })
}

export function serializeMuseSettings(settings: MuseSettingsDocument): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

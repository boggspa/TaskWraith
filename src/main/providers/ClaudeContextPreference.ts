import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClaudeContextPreference {
  windowTokens?: number
  source: 'environment' | 'user-settings' | 'provider-default'
}

export interface ClaudeContextPreferenceDependencies {
  readSettings?: (path: string) => string
}

function windowTokens(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 100_000 &&
    value <= 1_000_000
    ? value
    : undefined
}

/**
 * Forward only the native compaction preference across the empty settingSources
 * boundary. Loading the settings file into the SDK would also load hooks, MCP
 * servers and permission settings. Both SDK and CLI consume this frozen env.
 */
export function resolveClaudeContextPreference(
  env: Record<string, string>,
  dependencies: ClaudeContextPreferenceDependencies = {}
): { env: Record<string, string>; preference: ClaudeContextPreference } {
  const override = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (override !== undefined && override !== '') {
    return {
      env,
      preference: { source: 'environment', windowTokens: windowTokens(Number(override)) }
    }
  }
  try {
    const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude')
    const readSettings = dependencies.readSettings || ((path: string) => readFileSync(path, 'utf8'))
    const settings = JSON.parse(readSettings(join(configDir, 'settings.json')))
    const tokens = windowTokens(settings?.autoCompactWindow)
    if (tokens !== undefined) {
      return {
        env: { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(tokens) },
        preference: { source: 'user-settings', windowTokens: tokens }
      }
    }
  } catch {
    // An absent or malformed optional preference retains the provider default.
  }
  return { env, preference: { source: 'provider-default' } }
}

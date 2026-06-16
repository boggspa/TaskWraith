import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DISCORD_ENV_KEYS = [
  'TASKWRAITH_DISCORD_BOT_TOKEN',
  'TASKWRAITH_DISCORD_GUILD_IDS',
  'TASKWRAITH_DISCORD_GUILD_ID',
  'TASKWRAITH_DISCORD_ACCOUNT_ID'
] as const

export interface DiscordContextRuntimeConfig {
  botToken?: string
  guildIds: string[]
  accountId: string
  checkedConfigFilePaths: string[]
  loadedConfigFilePath?: string
  suggestedConfigFilePath?: string
}

export interface ResolveDiscordContextConfigOptions {
  env?: Record<string, string | undefined>
  userDataPath?: string
  homeDir?: string
  cwdEnvPath?: string
}

export function resolveDiscordContextConfig(
  options: ResolveDiscordContextConfigOptions = {}
): DiscordContextRuntimeConfig {
  const env = options.env || process.env
  const checkedConfigFilePaths = candidateDiscordConfigPaths(options, env)
  const fileEnv = loadFirstDiscordEnvFile(checkedConfigFilePaths)
  const envValues = pickDiscordEnv(env)
  const merged = { ...fileEnv.values, ...envValues }
  const guildIdSource =
    envValues.TASKWRAITH_DISCORD_GUILD_IDS ||
    envValues.TASKWRAITH_DISCORD_GUILD_ID ||
    fileEnv.values.TASKWRAITH_DISCORD_GUILD_IDS ||
    fileEnv.values.TASKWRAITH_DISCORD_GUILD_ID
  const guildIds = parseGuildIds(guildIdSource)

  return {
    botToken: normalizeText(merged.TASKWRAITH_DISCORD_BOT_TOKEN),
    guildIds,
    accountId: normalizeText(merged.TASKWRAITH_DISCORD_ACCOUNT_ID) || 'discord-bot',
    checkedConfigFilePaths,
    loadedConfigFilePath: fileEnv.path,
    suggestedConfigFilePath: checkedConfigFilePaths[0]
  }
}

function candidateDiscordConfigPaths(
  options: ResolveDiscordContextConfigOptions,
  env: Record<string, string | undefined>
): string[] {
  const paths = [
    normalizeText(env.TASKWRAITH_DISCORD_CONFIG_FILE),
    normalizeText(env.TASKWRAITH_DISCORD_ENV_FILE),
    options.userDataPath ? join(options.userDataPath, 'discord-context.env') : '',
    join(options.homeDir || homedir(), '.config', 'taskwraith', 'discord-context.env'),
    options.cwdEnvPath || ''
  ].filter(Boolean)
  return Array.from(new Set(paths))
}

function loadFirstDiscordEnvFile(paths: string[]): {
  path?: string
  values: Partial<Record<(typeof DISCORD_ENV_KEYS)[number], string>>
} {
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue
      return { path, values: parseDiscordEnvFile(readFileSync(path, 'utf8')) }
    } catch {
      continue
    }
  }
  return { values: {} }
}

function parseDiscordEnvFile(text: string): Partial<Record<(typeof DISCORD_ENV_KEYS)[number], string>> {
  const values: Partial<Record<(typeof DISCORD_ENV_KEYS)[number], string>> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!match) continue
    const key = match[1] as (typeof DISCORD_ENV_KEYS)[number]
    if (!DISCORD_ENV_KEYS.includes(key)) continue
    values[key] = unquoteEnvValue(match[2])
  }
  return values
}

function pickDiscordEnv(
  env: Record<string, string | undefined>
): Partial<Record<(typeof DISCORD_ENV_KEYS)[number], string>> {
  const picked: Partial<Record<(typeof DISCORD_ENV_KEYS)[number], string>> = {}
  for (const key of DISCORD_ENV_KEYS) {
    const value = normalizeText(env[key])
    if (value) picked[key] = value
  }
  return picked
}

function parseGuildIds(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return Array.from(
    new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => /^\d{5,32}$/.test(item))
    )
  )
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

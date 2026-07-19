import type { ProviderId } from './store/types'

export const MAX_EDITOR_FILE_BYTES = 1_500_000
export const MAX_EDITOR_FILES = 900
export const MAX_EDITOR_DEPTH = 6
export const SKIP_EDITOR_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.vite',
  '.turbo',
  'coverage',
  '.cache'
])

export const MAX_SCHEDULE_TIMER_DELAY_MS = 2_147_000_000

export const GROK_USAGE_FRESH_TTL_MS = 2 * 60_000

export const GROK_PROJECTED_INPUT_USD_PER_MILLION = 3.0

export const GROK_PROJECTED_OUTPUT_USD_PER_MILLION = 15.0

export const GROK_SCOPED_MCP_SERVER_NAME = 'taskwraith-grok'

/** Tool namespace reported by Grok ACP for the per-run TaskWraith broker. */
export const GROK_BROKER_MCP_TOOL_NAMESPACE = 'taskwraith-broker'

export const PROBE_TIMEOUT_MS = 1000

export const KNOWN_OFF_PATH_CODEX_BINARIES = ['/Applications/Codex.app/Contents/Resources/codex']

export const LIGHT_THEME_POPOUT_BACKDROPS: Record<string, string> = {
  light: '#f4f6f8',
  citrus: '#f4f6f8',
  mist: '#eef4f6',
  sage: '#f0f5f0',
  alabaster: '#f4f3ef'
}

export const RUN_MANAGER_PROVIDERS: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]

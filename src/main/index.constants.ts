import type { ProviderId } from './store/types'

export const MAX_EDITOR_FILE_BYTES = 1_500_000

/**
 * read_file MCP windowing (offset/limit). Whole-file reads stay byte-identical
 * to the pre-windowing behavior; these bounds only apply once the caller asks
 * for a line window. Default fires when offset is set without limit.
 */
export const MCP_READ_FILE_WINDOW_DEFAULT_LINES = 2_000
export const MCP_READ_FILE_WINDOW_MAX_LINES = 5_000
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
export const GROK_BROKER_MCP_TOOL_NAMESPACE = 'TaskWraith'

/**
 * Read-only Mistral Vibe seats attach the safe-subset broker under this name.
 *
 * It must NOT collide with `taskwraith-grok` or `taskwraith-broker`: the
 * permission handler decides whether a `session/request_permission` targets one
 * of TaskWraith's own immutable read-only tools by unqualifying the reported
 * tool name against the namespaces this seat actually advertised. A shared name
 * would let one seat's scoped-subset qualifier vouch for another seat's call.
 */
export const MISTRAL_SCOPED_MCP_SERVER_NAME = 'taskwraith-mistral'

/** Tool namespace `vibe-acp` reports for the per-run TaskWraith broker. */
export const MISTRAL_BROKER_MCP_TOOL_NAMESPACE = 'TaskWraith'

export const PROBE_TIMEOUT_MS = 1000

export const KNOWN_OFF_PATH_CODEX_BINARIES = ['/Applications/Codex.app/Contents/Resources/codex']

export const LIGHT_THEME_POPOUT_BACKDROPS: Record<string, string> = {
  light: '#f4f6f8',
  citrus: '#f4f6f8',
  mist: '#eef4f6',
  sage: '#f0f5f0',
  alabaster: '#f4f3ef'
}

/**
 * Internal lifecycle/cleanup inventory for every stable provider identity.
 * This list deliberately includes conditional and retired providers; it must
 * never drive offer, picker, or run admission.
 */
export const RUN_MANAGER_PROVIDERS: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  // Appended, not inserted: ProviderRunManagementBinding.test asserts this list
  // is element-for-element equal to PROVIDER_RUN_MANAGEMENT_IDS, so the two
  // orderings are one fact stored twice. Keep new identities at the tail of
  // BOTH.
  'mistral',
  'muse'
]

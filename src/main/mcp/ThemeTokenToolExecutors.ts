import type { McpToolExecutionResult } from './McpBridgeRuntime'
import {
  AGENT_THEME_TOKENS,
  normalizeAgentThemeTokenOverrides,
  validateAgentThemeToken,
  type AgentThemeTokenOverrides
} from '../../shared/agentThemeTokens'

/**
 * Theme-token tools — the agent-accessed half of appearance customisation.
 *
 * The user asks their agent to restyle TaskWraith; the agent names allowlisted
 * tokens and typed values. All of the safety lives in
 * `shared/agentThemeTokens`: this module is the transport, and deliberately does
 * no parsing of its own so there is exactly one place where "what may an agent
 * change about this window" is decided.
 *
 * Extracted rather than inlined into `executeGeminiMcpTool` per AGENTS.md's
 * composition-root policy — index.ts gets one import and one branch. That also
 * buys the fail-closed default below: the top-level dispatcher has NO terminal
 * else, so a tool that reaches it without a branch returns `{text:''}` as a
 * SUCCESS. Family executors like this one answer with an explicit error instead.
 */

export const THEME_TOKEN_MCP_TOOL_NAMES = ['theme_tokens_get', 'theme_tokens_set'] as const
export type ThemeTokenMcpToolName = (typeof THEME_TOKEN_MCP_TOOL_NAMES)[number]

export function isThemeTokenMcpToolName(name: string): name is ThemeTokenMcpToolName {
  return (THEME_TOKEN_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

export interface ThemeTokenToolDependencies {
  /** Current persisted overrides. Re-validated here; never trusted raw. */
  readonly getOverrides: () => unknown
  /** Persist the replacement map. Main owns the write; this only hands it over. */
  readonly setOverrides: (next: AgentThemeTokenOverrides) => Promise<void> | void
}

function ok(text: string): McpToolExecutionResult {
  return { text, isError: false }
}

function fail(text: string): McpToolExecutionResult {
  return { text, isError: true }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The writable surface, described so a model can choose without guessing. */
function describeWritableTokens(): string {
  return AGENT_THEME_TOKENS.map((spec) => {
    const bounds =
      spec.kind === 'color' ? '#RGB or #RRGGBB' : `${spec.min}..${spec.max} (px, number)`
    return `- ${spec.token} [${spec.kind}] ${bounds} — ${spec.describe}`
  }).join('\n')
}

function renderCurrent(overrides: AgentThemeTokenOverrides): string {
  const entries = Object.entries(overrides)
  if (entries.length === 0) return '(none — the user is on their theme defaults)'
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([token, value]) => `- ${token}: ${value}`)
    .join('\n')
}

export function createThemeTokenToolExecutor(deps: ThemeTokenToolDependencies): {
  executeThemeTokenTool: (toolName: string, rawArgs: unknown) => Promise<McpToolExecutionResult>
} {
  const readOverrides = (): AgentThemeTokenOverrides =>
    normalizeAgentThemeTokenOverrides(deps.getOverrides())

  async function executeGet(): Promise<McpToolExecutionResult> {
    return ok(
      [
        'Current appearance overrides:',
        renderCurrent(readOverrides()),
        '',
        'Tokens you may set:',
        describeWritableTokens(),
        '',
        'Values are typed, not CSS. Pixel tokens take a number or "12px"; colour tokens take a hex. calc(), var(), url(), named colours and percentages are rejected.'
      ].join('\n')
    )
  }

  async function executeSet(rawArgs: unknown): Promise<McpToolExecutionResult> {
    const args = asRecord(rawArgs)
    const reset = args.reset === true
    const requested = asRecord(args.tokens)
    const requestedCount = Object.keys(requested).length

    if (!reset && requestedCount === 0) {
      return fail(
        'Nothing to do: pass `tokens` with at least one allowlisted token, or `reset: true`. Call theme_tokens_get for the writable set.'
      )
    }

    // Reset applies FIRST so one call can wipe and re-set atomically.
    const base: AgentThemeTokenOverrides = reset ? {} : { ...readOverrides() }

    const applied: string[] = []
    const rejected: string[] = []
    for (const [token, value] of Object.entries(requested)) {
      const result = validateAgentThemeToken(token, value)
      if (result.ok) {
        base[result.token] = result.cssValue
        applied.push(`${result.token}: ${result.cssValue}`)
        continue
      }
      // Report each rejection individually rather than failing the batch — a
      // model that mistyped one value should not have to re-send the rest, and
      // it needs to know WHICH entry it got wrong to correct itself.
      const because =
        result.reason === 'unknown-token'
          ? 'not an allowlisted token'
          : result.reason === 'out-of-range'
            ? 'outside the allowed range for this token'
            : result.reason === 'not-a-string'
              ? 'wrong value type for this token'
              : 'not a valid value (typed values only — no calc/var/url/named colours)'
      rejected.push(`${token}: ${because}`)
    }

    // Every requested token was invalid: nothing changed, so this is an error
    // rather than a success with an empty diff.
    if (applied.length === 0 && !reset) {
      return fail(['No tokens were applied.', ...rejected.map((r) => `- ${r}`)].join('\n'))
    }

    await deps.setOverrides(base)

    const lines: string[] = []
    if (reset) lines.push('Cleared all appearance overrides.')
    if (applied.length > 0) {
      lines.push('Applied:', ...applied.map((a) => `- ${a}`))
    }
    if (rejected.length > 0) {
      lines.push('Rejected (everything else still applied):', ...rejected.map((r) => `- ${r}`))
    }
    return ok(lines.join('\n'))
  }

  return {
    executeThemeTokenTool(toolName, rawArgs) {
      switch (toolName) {
        case 'theme_tokens_get':
          return executeGet()
        case 'theme_tokens_set':
          return executeSet(rawArgs)
        default:
          // Explicit error, never an empty success — see the module note.
          return Promise.resolve(fail(`Unknown theme token tool "${String(toolName)}".`))
      }
    }
  }
}

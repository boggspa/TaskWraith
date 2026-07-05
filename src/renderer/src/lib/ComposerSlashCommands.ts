import type { ProviderCapabilityContract, ProviderId } from '../../../main/store/types'

/**
 * ComposerSlashCommands — single source of truth for the chat composer's
 * slash picker, including the Cmd-K shortcut entry point. Migrated out of
 * App.tsx so command data and dispatch stay in one place.
 *
 * The legacy CommandPaletteItem adapter types live here too because provider
 * command dispatch still uses them — the slash picker wraps each
 * CommandPaletteItem in a `palette-passthrough` ComposerSlashCommand and
 * delegates dispatch to the existing `handlePaletteCommand`, so no
 * duplicate dispatch logic.
 *
 * Additional layers introduce `kind`s
 * (`action`, `prompt-template`, `insert`) for commands
 * that don't fit the legacy palette shape.
 */

// ---------------------------------------------------------------------------
// Legacy CommandPaletteItem adapter types — verbatim relocation from App.tsx.
// Provider-backed slash commands still use this shape for dispatch, while the
// visible command surface is the slash picker.
// ---------------------------------------------------------------------------

export type CommandPaletteSource = 'core' | 'workspace' | 'global'
export type CommandPaletteGroup = 'Core' | 'Discovery' | 'Memory' | 'Inspectors' | 'Custom'

export interface CommandPaletteItem {
  id: string
  command: string
  label: string
  description: string
  group: CommandPaletteGroup
  source: CommandPaletteSource
  sourcePath?: string
}

// ---------------------------------------------------------------------------
// Per-provider palette cores — these used to live inline in App.tsx (lines
// 1278 / 1360 / 1434). Moving them here so the slash picker registry can
// derive the same data without re-importing the App component.
// ---------------------------------------------------------------------------

export const RETIRED_PROVIDER_PALETTE_CORE: CommandPaletteItem[] = []

export const CODEX_PALETTE_CORE: CommandPaletteItem[] = [
  {
    id: 'codex-status',
    command: '/status',
    label: 'Status',
    description: 'Show Codex auth, sandbox, approval policy, and rate-limit state.',
    group: 'Core',
    source: 'core'
  },
  {
    id: 'codex-model',
    command: '/model',
    label: 'Model',
    description: 'Show Codex model, reasoning effort, and speed tier options.',
    group: 'Core',
    source: 'core'
  },
  {
    id: 'codex-fast',
    command: '/fast',
    label: 'Fast mode',
    description: 'Toggle Codex Fast mode when the selected model supports it.',
    group: 'Core',
    source: 'core'
  },
  {
    id: 'codex-diff',
    command: '/diff',
    label: 'Diff',
    description: 'Open Diff Studio for current workspace changes.',
    group: 'Inspectors',
    source: 'core'
  },
  {
    id: 'codex-mcp',
    command: '/mcp',
    label: 'MCP',
    description: 'Show Codex MCP server and tool status.',
    group: 'Inspectors',
    source: 'core'
  },
  {
    id: 'codex-review',
    command: '/review',
    label: 'Review diff',
    description: 'Prepare a read-only review of current workspace changes.',
    group: 'Inspectors',
    source: 'core'
  },
  {
    id: 'codex-resume',
    command: '/resume',
    label: 'Resume thread',
    description: 'Open the Codex thread browser to link a persisted thread.',
    group: 'Discovery',
    source: 'core'
  },
  {
    id: 'universal-fork',
    command: '/fork',
    label: 'Fork session',
    description: 'Fork the linked provider session (native on Codex; emulated elsewhere — no Gemini).',
    group: 'Discovery',
    source: 'core'
  },
  {
    id: 'codex-permissions',
    command: '/permissions',
    label: 'Permissions',
    description: 'Show Codex sandbox and approval controls.',
    group: 'Core',
    source: 'core'
  }
]

export const CLI_PROVIDER_PALETTE_CORE: CommandPaletteItem[] = [
  {
    id: 'cli-provider-status',
    command: '/status',
    label: 'Status',
    description: 'Show provider binary, auth, and setup state.',
    group: 'Core',
    source: 'core'
  },
  {
    id: 'cli-provider-model',
    command: '/model',
    label: 'Model',
    description: 'Show model and provider capability state.',
    group: 'Core',
    source: 'core'
  },
  {
    id: 'cli-provider-diff',
    command: '/diff',
    label: 'Diff',
    description: 'Open Diff Studio for current workspace changes.',
    group: 'Inspectors',
    source: 'core'
  },
  {
    id: 'cli-provider-review',
    command: '/review',
    label: 'Review diff',
    description: 'Prepare a read-only review of current workspace changes.',
    group: 'Inspectors',
    source: 'core'
  },
  {
    id: 'cli-provider-permissions',
    command: '/permissions',
    label: 'Permissions',
    description: 'Show provider permission and approval mode controls.',
    group: 'Core',
    source: 'core'
  },
  {
    id: 'cli-universal-fork',
    command: '/fork',
    label: 'Fork session',
    description: 'Fork this chat session (emulated — duplicates transcript into an isolated sibling).',
    group: 'Discovery',
    source: 'core'
  }
]

// ---------------------------------------------------------------------------
// ComposerSlashCommand — the new shape consumed by the slash picker.
// Discriminated by `kind` so the dispatcher can route each command
// without inspecting string contents.
// ---------------------------------------------------------------------------

export interface ComposerSlashCommandBase {
  id: string
  command: string
  label: string
  description: string
  group: CommandPaletteGroup
  /** Optional parent command id for slash-picker hierarchy. Child commands
   * remain normal dispatchable slash commands so typed submits still work. */
  parentId?: string
}

/** Wraps a legacy CommandPaletteItem; delegates dispatch to the existing
 * `handlePaletteCommand`. The dominant kind in L1 — every existing
 * palette entry becomes one of these. */
export interface PalettePassthroughCommand extends ComposerSlashCommandBase {
  kind: 'palette-passthrough'
  paletteItem: CommandPaletteItem
}

/**
 * Context handed to an `action` command's `run()` at dispatch time.
 *
 * The dispatcher ( `handleComposerSlash` / `tryHandleActionSlashSubmit` ) lives
 * inside the INVOKING `<Composer>` instance and owns the slash-token machinery
 * (anchor index, query, the live textarea ref). Action `run()` closures are
 * defined at the App level and must NOT reach into composer globals — they
 * receive everything they need to read or mutate the invoking composer through
 * this context, so the same closure works no matter which pane fired it.
 */
export interface SlashCommandRunContext {
  /** The raw invoking composer draft at dispatch time. */
  rawPrompt: string
  /** The composer draft with the leading `/<query>` token removed (read-only
   * snapshot). Equivalent to the old `promptWithoutCurrentSlashToken()`. */
  promptWithoutSlashToken: string
  /** Strip the `/<query>` token from the invoking composer's draft and
   * re-focus its textarea with the caret where the slash used to be.
   * Equivalent to the old `consumeSlashTokenFromPrompt()`. */
  consumeSlashToken: () => void
  /** Write the invoking composer's draft (per-chat). Equivalent to the old
   * `setPrompt(value)` for the focused composer. */
  setDraft: (value: string) => void
  /** Focus the invoking composer's textarea, optionally placing the caret at
   * `caret` (defaults to the current selection). */
  focusComposer: (caret?: number) => void
}

/** Renderer-side action — invokes an arbitrary side-effect (open a panel,
 * trigger a modal, fire an existing IPC). The picker dispatcher will
 * receive a `run` callback resolved at registry-build time. The dispatcher
 * passes a {@link SlashCommandRunContext} so closures that read or mutate the
 * composer do so through the invoking instance rather than App-level globals. */
export interface ActionCommand extends ComposerSlashCommandBase {
  kind: 'action'
  run: (ctx: SlashCommandRunContext) => void | Promise<void>
}

/** Inserts a canned prompt template at the slash position, leaving the
 * caret at `cursorOffset` chars into the template. Foundation for the
 * future skill-discovery channel. */
export interface PromptTemplateCommand extends ComposerSlashCommandBase {
  kind: 'prompt-template'
  template: string
  /** Optional caret offset relative to start of inserted template. */
  cursorOffset?: number
}

/** Inserts literal text at the slash position without dispatching
 * anything (e.g. `/think` style toggles or provider-specific prefixes
 * that need a confirmation keypress before sending). */
export interface InsertCommand extends ComposerSlashCommandBase {
  kind: 'insert'
  insertText: string
}

export type ComposerSlashCommand =
  | PalettePassthroughCommand
  | ActionCommand
  | PromptTemplateCommand
  | InsertCommand

// ---------------------------------------------------------------------------
// Builder + helpers
// ---------------------------------------------------------------------------

/** Wrap a legacy CommandPaletteItem as a palette-passthrough slash
 * command. Used by the registry builder and any downstream code that
 * needs to surface a palette item through the slash picker. */
export function wrapPaletteItemAsSlashCommand(item: CommandPaletteItem): PalettePassthroughCommand {
  return {
    kind: 'palette-passthrough',
    id: item.id,
    command: item.command,
    label: item.label,
    description: item.description,
    group: item.group,
    paletteItem: item
  }
}

export interface ComposerSlashRegistryInput {
  provider: ProviderId
  /** Already-resolved palette items for the current provider + chat state. */
  paletteItems: CommandPaletteItem[]
  /** Additional slash commands that don't map cleanly to legacy palette
   * items — `action`, `prompt-template`, `insert`. The
   * builder concatenates these after the palette-passthrough block. */
  extraCommands?: ComposerSlashCommand[]
  /** Provider capability snapshot for the current chat scope. When
   * supplied, the builder hides entries the provider can't service:
   *   - `/mcp` is hidden when `capabilities.mcp.available === false`
   * Callers in tests can omit this and get the unfiltered registry. */
  capabilities?: ProviderCapabilityContract | null
}

/** Inspect a slash command's `command` string to decide whether to
 * gate it on a capability flag. Pure helper so the gating logic stays
 * testable. Returns true when the entry should be kept. */
function passesCapabilityGate(
  command: ComposerSlashCommand,
  capabilities: ProviderCapabilityContract | null | undefined
): boolean {
  if (!capabilities) return true
  // `/mcp` is meaningless when the provider's MCP surface is offline.
  // Codex's app-server returns a contract; if its mcp section reports
  // unavailable the entry just confuses the user.
  if (command.command === '/mcp' && capabilities.mcp?.available === false) {
    return false
  }
  return true
}

/**
 * Build the per-provider slash command registry. Pure function: no React,
 * no IPC, no global state. Caller computes the dynamic context and
 * passes resolved palette items + any extra commands in.
 */
export function buildComposerSlashCommandRegistry(
  input: ComposerSlashRegistryInput
): ComposerSlashCommand[] {
  const wrapped = input.paletteItems.map(wrapPaletteItemAsSlashCommand)
  const combined = [...wrapped, ...(input.extraCommands ?? [])]
  return dedupeComposerSlashCommands(
    combined.filter((command) => passesCapabilityGate(command, input.capabilities))
  )
}

/**
 * Slash tokens must be unique in the final picker/submit registry. Provider
 * palette items are appended before TaskWraith action commands, so later
 * entries intentionally win when a local action replaces a provider token
 * such as `/help`.
 */
export function dedupeComposerSlashCommands(
  commands: ComposerSlashCommand[]
): ComposerSlashCommand[] {
  const order: string[] = []
  const byCommand = new Map<string, ComposerSlashCommand>()
  for (const command of commands) {
    const key = command.command.trim().toLowerCase()
    if (!key) continue
    if (!byCommand.has(key)) order.push(key)
    byCommand.set(key, command)
  }
  return order.map((key) => byCommand.get(key)!)
}

/** Filter a registry by user-typed query against label / description /
 * command / group / source path. Substring match, case-insensitive. */
export function filterComposerSlashCommands(
  commands: ComposerSlashCommand[],
  query: string
): ComposerSlashCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands
  return commands.filter((command) => {
    const sourcePath =
      command.kind === 'palette-passthrough' ? command.paletteItem.sourcePath || '' : ''
    const haystack = `${command.command} ${command.label} ${command.description} ${command.group} ${sourcePath}`
    return haystack.toLowerCase().includes(needle)
  })
}

/**
 * Find the ACTION command a submitted prompt leads with, so the composer can
 * fire it instead of sending the literal text to the provider. The slash MENU
 * dispatches a command on selection, but typing the full command + a space
 * (e.g. `/audit quick`) closes the menu — without this, Enter would send
 * `/audit quick` as a chat message. Matches the prompt's first
 * whitespace-delimited token (case-insensitive) against each action command's
 * `command`; trailing args are allowed (the command's own `run` parses them).
 * Only a LEADING token matches — `fix /audit later` is a normal message.
 */
export function matchLeadingActionCommand(
  prompt: string,
  commands: ComposerSlashCommand[]
): ActionCommand | null {
  const match = matchLeadingSlashCommand(prompt, commands)
  const command = match?.command
  return command && command.kind === 'action' ? command : null
}

export interface LeadingSlashCommandMatch {
  command: ComposerSlashCommand
  matchedText: string
  remainder: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isCommandPlaceholderToken(token: string): boolean {
  return (
    /^<[^>\s]+>$/.test(token) ||
    /^\[[^\]\s]+\]$/.test(token) ||
    /^\{[^}\s]+\}$/.test(token)
  )
}

export function hasSlashCommandPlaceholders(command: string): boolean {
  return command.trim().split(/\s+/).some(isCommandPlaceholderToken)
}

export function slashCommandDispatchPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  const placeholderIndex = tokens.findIndex(isCommandPlaceholderToken)
  return (placeholderIndex >= 0 ? tokens.slice(0, placeholderIndex) : tokens).join(' ')
}

function leadingCommandPattern(command: string): RegExp | null {
  const tokens = slashCommandDispatchPrefix(command).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  return new RegExp(`^${tokens.map(escapeRegExp).join('\\s+')}(?=\\s|$)`, 'i')
}

/**
 * Match a registered slash command at the start of a submitted draft. Unlike
 * {@link matchLeadingActionCommand}, this handles multi-word commands such as
 * `/commands reload` and returns the remaining text so the submit path can
 * decide whether trailing args are meaningful for that command kind.
 */
export function matchLeadingSlashCommand(
  prompt: string,
  commands: ComposerSlashCommand[]
): LeadingSlashCommandMatch | null {
  const trimmed = prompt.trim()
  if (!trimmed.startsWith('/')) return null
  let best: LeadingSlashCommandMatch | null = null
  for (const command of commands) {
    if (command.kind === 'insert') continue
    const pattern = leadingCommandPattern(command.command)
    if (!pattern) continue
    const match = trimmed.match(pattern)
    if (!match) continue
    const matchedText = match[0]
    if (best && matchedText.length <= best.matchedText.length) continue
    best = {
      command,
      matchedText,
      remainder: trimmed.slice(matchedText.length).trim()
    }
  }
  return best
}

/** Group sort key. Cmd-K palette enforces this order today; mirror it
 * so the slash picker reads identically. */
export const COMPOSER_SLASH_GROUP_ORDER: CommandPaletteGroup[] = [
  'Core',
  'Discovery',
  'Memory',
  'Inspectors',
  'Custom'
]

/** Resolve the per-provider palette core. Mirrors the routing logic at
 * App.tsx:11874 (codex → CODEX, non-Codex CLI providers → CLI_PROVIDER).
 * Grok/Cursor/Ollama take the generic CLI core: provider-native TUI slash
 * commands are not reachable over our headless/ACP/local run paths. /review
 * here is TaskWraith's own read-only diff review (reviewDiffPrompt + a
 * plan-mode run), provider-agnostic. Retired provider ids intentionally return
 * an empty command set. */
export function paletteCoreForProvider(provider: ProviderId): CommandPaletteItem[] {
  if (provider === 'codex') return CODEX_PALETTE_CORE
  if (
    provider === 'claude' ||
    provider === 'kimi' ||
    provider === 'grok' ||
    provider === 'cursor' ||
    provider === 'ollama'
  ) {
    return CLI_PROVIDER_PALETTE_CORE
  }
  return RETIRED_PROVIDER_PALETTE_CORE
}

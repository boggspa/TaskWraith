/**
 * The TaskWraith TUI's slash-command vocabulary.
 *
 * This module deliberately owns data and parsing only. Dispatch remains in the
 * TUI controller, while the composer palette, help surface and dispatcher can
 * all consume the same canonical names instead of maintaining parallel lists.
 */

export type TuiSlashCommandName =
  | '/archive'
  | '/cancel'
  | '/clear'
  | '/context'
  | '/dismiss'
  | '/git'
  | '/goal'
  | '/help'
  | '/history'
  | '/login'
  | '/missions'
  | '/model'
  | '/new'
  | '/quit'
  | '/seats'
  | '/status'
  | '/theme'
  | '/think'
  | '/threads'
  | '/tune'
  | '/workspace'

export interface TuiSlashCommandDefinition {
  /** Canonical, dispatchable leading token, including its slash. */
  readonly name: TuiSlashCommandName
  /** Other accepted leading tokens. Aliases include their slash too. */
  readonly aliases: readonly string[]
  /** User-facing invocation form. Optional arguments use square brackets. */
  readonly usage: string
  readonly description: string
  /**
   * Selecting this command immediately interrupts or discards state.
   * Commands that merely open a lens remain non-destructive even when that
   * lens later offers a mutation of its own.
   */
  readonly destructive: boolean
}

export const TUI_SLASH_COMMANDS: readonly TuiSlashCommandDefinition[] = [
  {
    name: '/model',
    aliases: ['/m'],
    usage: '/model [id]',
    description: 'Choose a model or stage one for the next send.',
    destructive: false
  },
  {
    name: '/think',
    aliases: ['/reasoning'],
    usage: '/think [level]',
    description: 'Choose or stage a reasoning effort for the next send.',
    destructive: false
  },
  {
    name: '/tune',
    aliases: [],
    usage: '/tune',
    description: 'Open the combined model and reasoning lens.',
    destructive: false
  },
  {
    name: '/new',
    aliases: ['/provider'],
    usage: '/new [provider]',
    description: 'Start a fresh solo thread, optionally with a provider.',
    destructive: false
  },
  {
    name: '/login',
    aliases: [],
    usage: '/login [provider]',
    description: 'Open provider sign-in and setup status.',
    destructive: false
  },
  {
    name: '/status',
    aliases: [],
    usage: '/status',
    description: 'Show Host, connection and open-thread detail.',
    destructive: false
  },
  {
    name: '/context',
    aliases: [],
    usage: '/context',
    description: 'Open the context lens for the current thread.',
    destructive: false
  },
  {
    name: '/goal',
    aliases: [],
    usage: '/goal',
    description: 'Show the current thread objective.',
    destructive: false
  },
  {
    name: '/git',
    aliases: [],
    usage: '/git [status|diff|log] [path]',
    description: 'Open the read-only workspace Git lens.',
    destructive: false
  },
  {
    name: '/seats',
    aliases: [],
    usage: '/seats',
    description: 'Open the Ensemble seat lens.',
    destructive: false
  },
  {
    name: '/threads',
    aliases: [],
    usage: '/threads',
    description: 'Open the thread picker.',
    destructive: false
  },
  {
    name: '/workspace',
    aliases: ['/ws'],
    usage: '/workspace [path]',
    description: 'Choose where new threads land or register a workspace path.',
    destructive: false
  },
  {
    name: '/missions',
    aliases: [],
    usage: '/missions',
    description: 'Open active mission control.',
    destructive: false
  },
  {
    name: '/history',
    aliases: [],
    usage: '/history',
    description: 'Show completed mission history.',
    destructive: false
  },
  {
    name: '/theme',
    aliases: [],
    usage: '/theme [name]',
    description: 'Preview or apply a TUI colour theme.',
    destructive: false
  },
  {
    name: '/clear',
    aliases: [],
    usage: '/clear',
    description: "Reset this TUI session's local transcript scrollback.",
    destructive: false
  },
  {
    name: '/help',
    aliases: [],
    usage: '/help',
    description: 'Show command and keyboard help.',
    destructive: false
  },
  {
    name: '/archive',
    aliases: [],
    usage: '/archive',
    description: 'Archive the open thread.',
    destructive: true
  },
  {
    name: '/cancel',
    aliases: [],
    usage: '/cancel',
    description: 'Stop the active run.',
    destructive: true
  },
  {
    name: '/dismiss',
    aliases: [],
    usage: '/dismiss',
    description: 'Dismiss the pending Host question.',
    destructive: true
  },
  {
    name: '/quit',
    aliases: ['/q'],
    usage: '/quit',
    description: 'Leave the TUI while the Host keeps running.',
    destructive: true
  }
]

export interface TuiLeadingSlashToken {
  /** Token exactly as typed, preserving case for honest error messages. */
  readonly rawToken: string
  /** Lower-case token used for registry matching. */
  readonly normalizedToken: string
  /** Trimmed text after the leading token, with internal spacing preserved. */
  readonly argumentText: string
  /** Whitespace-delimited arguments, matching the current TUI dispatcher. */
  readonly arguments: readonly string[]
}

/** Parse a slash token only when it leads the input (after optional whitespace). */
export function parseLeadingTuiSlashToken(input: string): TuiLeadingSlashToken | null {
  const leading = input.trimStart()
  if (!leading.startsWith('/')) return null

  const whitespace = leading.search(/\s/)
  const rawToken = whitespace < 0 ? leading : leading.slice(0, whitespace)
  const argumentText = (whitespace < 0 ? '' : leading.slice(whitespace)).trim()
  return {
    rawToken,
    normalizedToken: rawToken.toLowerCase(),
    argumentText,
    arguments: argumentText ? argumentText.split(/\s+/) : []
  }
}

function commandMatchRank(command: TuiSlashCommandDefinition, needle: string): number | null {
  const name = command.name.slice(1).toLowerCase()
  const aliases = command.aliases.map((alias) => alias.replace(/^\//, '').toLowerCase())
  if (name === needle) return 0
  if (aliases.includes(needle)) return 1
  if (name.startsWith(needle)) return 2
  if (aliases.some((alias) => alias.startsWith(needle))) return 3
  if (command.usage.toLowerCase().includes(needle)) return 4
  if (command.description.toLowerCase().includes(needle)) return 5
  return null
}

/**
 * Filter and rank commands for a selectable palette.
 *
 * A slash-led input searches by its first token, so arguments never make a
 * selected command disappear. Plain text can search usage and descriptions,
 * which also makes this useful for a keyboard-opened command palette.
 */
export function filterTuiSlashCommands(
  input: string,
  commands: readonly TuiSlashCommandDefinition[] = TUI_SLASH_COMMANDS
): TuiSlashCommandDefinition[] {
  const parsed = parseLeadingTuiSlashToken(input)
  const query = parsed ? parsed.normalizedToken.slice(1) : input.trim().toLowerCase()
  if (!query) return [...commands]

  return commands
    .map((command, index) => ({ command, index, rank: commandMatchRank(command, query) }))
    .filter(
      (entry): entry is { command: TuiSlashCommandDefinition; index: number; rank: number } =>
        entry.rank !== null
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ command }) => command)
}

export interface ResolvedTuiSlashCommand extends TuiLeadingSlashToken {
  readonly command: TuiSlashCommandDefinition
}

/** Resolve an exact canonical name or alias from the input's leading token. */
export function resolveTuiSlashCommand(
  input: string,
  commands: readonly TuiSlashCommandDefinition[] = TUI_SLASH_COMMANDS
): ResolvedTuiSlashCommand | null {
  const parsed = parseLeadingTuiSlashToken(input)
  if (!parsed || parsed.normalizedToken === '/') return null
  const command = commands.find(
    (candidate) =>
      candidate.name.toLowerCase() === parsed.normalizedToken ||
      candidate.aliases.some((alias) => alias.toLowerCase() === parsed.normalizedToken)
  )
  return command ? { ...parsed, command } : null
}

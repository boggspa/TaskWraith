/**
 * The non-interactive `tw` surface an outside agent uses: list the threads in
 * this working tree, and send one prompt into one of them.
 *
 * This parser runs BEFORE `parseTaskWraithTuiArgs` and returns null for
 * anything that is not one of its verbs, so the interactive TUI keeps owning
 * its own flags unchanged. It is pure: stdin, discovery and the socket belong
 * to the caller.
 */
import { TuiUsageError } from './tuiUsageError'

export type OutsideCommand =
  | {
      kind: 'threads'
      query?: string
      /** Absent means every workspace; otherwise scope to this working tree. */
      cwd?: string
      json: boolean
    }
  | {
      kind: 'send'
      /** Exact thread id, or a title substring that must match exactly one. */
      selector: string
      /** Absent means "read the prompt from stdin". */
      text?: string
      from?: string
      cwd?: string
      json: boolean
    }
  | {
      kind: 'read'
      /** Exact thread id, or a title substring that must match exactly one. */
      selector: string
      /** Newest rows to return; the host clamps this to its own ceiling. */
      limit?: number
      cwd?: string
      json: boolean
    }
  | {
      kind: 'mcp'
      /** Default scope for tool calls that name no working tree of their own. */
      cwd: string
    }

/**
 * The verbs that actually talk to the control socket. `mcp` is not one: it
 * serves the others over stdio, so anything reaching the socket runner or the
 * MCP tool bridge is narrowed to this.
 */
export type OutsideSocketCommand = Exclude<OutsideCommand, { kind: 'mcp' }>

export const OUTSIDE_COMMAND_NAMES = ['threads', 'send', 'read', 'mcp'] as const

export interface OutsideCommandDefaults {
  /** Working tree to scope to unless `--all` or `--cwd` says otherwise. */
  cwd: string
}

type FlagName = '--query' | '--cwd' | '--from' | '--limit'

function takeValue(args: readonly string[], index: number, flag: string): [string, number] {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new TuiUsageError(`${flag} requires a value.`)
  }
  return [value, index + 1]
}

/**
 * Parse one verb's flags up to its first positional. Flags after the first
 * positional are NOT consumed: for `send` everything past the selector is
 * prompt text, and a prompt is allowed to contain a word starting with `--`.
 */
function parseFlags(
  args: readonly string[],
  accepted: readonly FlagName[]
): { values: Partial<Record<FlagName, string>>; all: boolean; json: boolean; rest: string[] } {
  const values: Partial<Record<FlagName, string>> = {}
  let all = false
  let json = false
  let index = 0
  for (; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) break
    const [flag, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined]
    if (flag === '--all') {
      all = true
    } else if (flag === '--json') {
      json = true
    } else if ((accepted as readonly string[]).includes(flag)) {
      if (inline !== undefined) {
        values[flag as FlagName] = inline
      } else {
        const [value, consumed] = takeValue(args, index, flag)
        values[flag as FlagName] = value
        index = consumed
      }
    } else {
      throw new TuiUsageError(`Unknown option: ${flag}`)
    }
  }
  return { values, all, json, rest: args.slice(index) }
}

/** A row count must be a whole number of rows, not a truthy string. */
function positiveCount(raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new TuiUsageError('--limit expects a positive whole number of rows.')
  }
  return value
}

function scope(cwd: string | undefined, all: boolean, fallback: string): { cwd?: string } {
  if (all) return {}
  return { cwd: cwd ?? fallback }
}

export function parseOutsideCommand(
  argv: readonly string[],
  defaults: OutsideCommandDefaults
): OutsideCommand | null {
  const verb = argv[0]
  if (!verb || !(OUTSIDE_COMMAND_NAMES as readonly string[]).includes(verb)) return null
  const args = argv.slice(1)

  if (verb === 'mcp') {
    const { values, rest } = parseFlags(args, ['--cwd'])
    if (rest.length) {
      throw new TuiUsageError(`mcp takes no arguments; it serves tools over stdio. Got: ${rest[0]}`)
    }
    return { kind: 'mcp', cwd: values['--cwd'] ?? defaults.cwd }
  }

  if (verb === 'threads') {
    const { values, all, json, rest } = parseFlags(args, ['--query', '--cwd'])
    const query = values['--query'] ?? (rest.join(' ').trim() || undefined)
    return {
      kind: 'threads',
      ...(query ? { query } : {}),
      ...scope(values['--cwd'], all, defaults.cwd),
      json
    }
  }

  if (verb === 'read') {
    const { values, all, json, rest } = parseFlags(args, ['--cwd', '--limit'])
    const selector = rest[0]
    if (!selector) {
      throw new TuiUsageError('read needs a thread id or a title to match: tw read <thread>')
    }
    const limit = values['--limit'] === undefined ? undefined : positiveCount(values['--limit'])
    return {
      kind: 'read',
      selector,
      ...(limit !== undefined ? { limit } : {}),
      ...scope(values['--cwd'], all, defaults.cwd),
      json
    }
  }

  const { values, all, json, rest } = parseFlags(args, ['--cwd', '--from'])
  const selector = rest[0]
  if (!selector) {
    throw new TuiUsageError('send needs a thread id or a title to match: tw send <thread> <text…>')
  }
  const text = rest.slice(1).join(' ').trim()
  return {
    kind: 'send',
    selector,
    ...(text ? { text } : {}),
    ...(values['--from'] ? { from: values['--from'] } : {}),
    ...scope(values['--cwd'], all, defaults.cwd),
    json
  }
}

/**
 * Parser for the deliberately small shell-source subset that command rules can
 * replay as direct argv. It is an identity parser, not a safety classifier:
 * callers may still explicitly permit an opaque host command, but the command
 * must be reducible to one executable plus literal arguments with no shell
 * behaviour left to reinterpret later.
 */

export const STATIC_SHELL_ARGV_PARSER_VERSION = 'static-shell-argv-v1' as const
export const MAX_STATIC_SHELL_COMMAND_CHARS = 8 * 1024

export interface StaticShellArgv {
  executable: string
  argv: string[]
}

export type StaticShellArgvParseFailure =
  | 'not_a_string'
  | 'empty'
  | 'too_long'
  | 'unsafe_syntax'
  | 'unterminated_quote'
  | 'environment_assignment'
  | 'shell_wrapper'

export type StaticShellArgvParseResult =
  | { ok: true; value: StaticShellArgv }
  | { ok: false; reason: StaticShellArgvParseFailure }

// Direct execution has no shell builtins. Refuse the wrappers that would make
// the visible argv a second layer of shell/program interpretation rather than
// one exact executable invocation.
const SHELL_WRAPPER_EXECUTABLES = new Set([
  '.',
  'bash',
  'command',
  'dash',
  'env',
  'eval',
  'exec',
  'fish',
  'sh',
  'source',
  'zsh'
])

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SAFE_UNQUOTED_CHARACTER = /^[A-Za-z0-9._/=:,+@%^-]$/

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code <= 0x1f || code === 0x7f
}

/**
 * Parse one static command string into the exact direct argv that will be
 * executed. Single and double quotes may carry literal data, but expansion,
 * redirects, pipelines, glob expansion, and control operators fail closed.
 *
 * A glob-like character inside quotes is permitted because it is literal argv
 * rather than shell pathname expansion (for example an `rg` regex or a tool's
 * own `--glob` argument). The same character unquoted is rejected.
 */
export function parseStaticShellArgv(value: unknown): StaticShellArgvParseResult {
  if (typeof value !== 'string') return { ok: false, reason: 'not_a_string' }
  if (!value.trim()) return { ok: false, reason: 'empty' }
  if (value.length > MAX_STATIC_SHELL_COMMAND_CHARS) return { ok: false, reason: 'too_long' }

  const tokens: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: 'single' | 'double' | null = null

  const pushToken = (): void => {
    if (tokenStarted) tokens.push(token)
    token = ''
    tokenStarted = false
  }

  for (const character of value) {
    if (quote === 'single') {
      if (character === "'") quote = null
      else if (isControlCharacter(character)) return { ok: false, reason: 'unsafe_syntax' }
      else token += character
      tokenStarted = true
      continue
    }

    if (quote === 'double') {
      if (character === '"') quote = null
      else if (
        character === '$' ||
        character === '`' ||
        character === '\\' ||
        isControlCharacter(character)
      ) {
        return { ok: false, reason: 'unsafe_syntax' }
      } else {
        token += character
      }
      tokenStarted = true
      continue
    }

    if (character === "'") {
      quote = 'single'
      tokenStarted = true
      continue
    }
    if (character === '"') {
      quote = 'double'
      tokenStarted = true
      continue
    }
    if (character === ' ') {
      pushToken()
      continue
    }
    if (!SAFE_UNQUOTED_CHARACTER.test(character)) {
      return { ok: false, reason: 'unsafe_syntax' }
    }
    token += character
    tokenStarted = true
  }

  if (quote !== null) return { ok: false, reason: 'unterminated_quote' }
  pushToken()
  if (tokens.length === 0) return { ok: false, reason: 'empty' }

  const executable = tokens[0]
  if (ENVIRONMENT_ASSIGNMENT.test(executable)) {
    return { ok: false, reason: 'environment_assignment' }
  }
  const executableBasename = executable.slice(executable.lastIndexOf('/') + 1)
  if (
    SHELL_WRAPPER_EXECUTABLES.has(executable) ||
    SHELL_WRAPPER_EXECUTABLES.has(executableBasename)
  ) {
    return { ok: false, reason: 'shell_wrapper' }
  }

  return { ok: true, value: { executable, argv: tokens.slice(1) } }
}

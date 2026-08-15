import { isInspectionShellCommand } from '../ShellCommandTierPolicy'
import { isReadOnlyGitShellCommand } from '../ReadOnlyGitShellCommand'

// Fail-closed classifier for "is this shell command read-only?" — used to let a
// READ-ONLY / recon Grok turn run genuine investigation commands (ls, cat,
// git log, find, grep, …) instead of hard-denying every shell tool.
//
// WHY THIS EXISTS: Grok's ACP shell tool (`run_terminal_command`, kind
// `execute`) is not covered by the CLI `--deny Bash/Shell` rules, so it reaches
// TaskWraith's permission gate. Under read-only posture the gate previously
// denied ALL non-network tools — and Grok treats a denied tool as a FATAL turn
// cancel (stopReason: cancelled), abandoning the turn with no answer. A user who
// only asked Grok to *investigate* a repo would see the run fail the moment Grok
// tried `ls && git log`. This classifier lets the gate ALLOW provably read-only
// commands so recon completes and Grok can report findings.
//
// SECURITY POSTURE — FAIL CLOSED. This runs as part of the read-only safety
// floor, so the ONE unacceptable outcome is a false positive (a mutating command
// classified read-only → it executes under read-only posture). A false negative
// (a read command classified unsafe → denied) merely degrades to the prior
// behaviour. Every ambiguity therefore resolves to `false`:
//   - unknown command → false
//   - output redirection to anything but /dev/null|stdout|stderr → false
//   - command substitution `$(…)` / backticks / process substitution → false
//   - path/script execution (`./x`, `/bin/sh`) or `VAR=val cmd` prefixes → false
//   - `git` → only the shared fail-closed status/diff/log classifier plus the
//     specifically screened `git grep` form
//   - `find` with `-exec/-delete/…` → false
// The allowlist is deliberately small; widen it only with matching tests.

/** Commands audited to have no setter/compile/exec mode AND no output-file
 * positional / no command-exec flag. Redirections and substitutions are rejected
 * separately. Commands that CAN write or exec via their own flags/positionals
 * (`git`, `file`, `printf`, `find`, `rg`, `uniq`) are rejected or handled
 * specially below — do NOT add them here. Deliberately EXCLUDED:
 *   - `xxd`  → `xxd infile OUTFILE` writes an arbitrary file (positional output)
 *   - `tree` → `tree -o FILE` writes its output to a file
 *   - `sort` → `sort -o FILE` writes its output to a file
 *   - `sed`/`awk` → `-i` / `print > f` / `system()` write & exec */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'pwd',
  'echo',
  'wc',
  'stat',
  'which',
  'type',
  'printenv',
  'whoami',
  'id',
  'uname',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'du',
  'df',
  'ps',
  'uptime',
  'free',
  'od',
  'strings',
  'cut',
  'tr',
  'nl',
  'fold',
  'column',
  'comm',
  'cmp',
  'diff',
  'grep',
  'egrep',
  'fgrep',
  'jq',
  'cksum',
  'md5sum',
  'shasum',
  'sha1sum',
  'sha256sum'
])

// The general classifier below deliberately excludes native `git` and `sed`.
// Reuse the shared all-tier proof only for the two constrained source-inspection
// forms that need their own semantic flag/program screens.
const SHARED_INSPECTION_EXCEPTION =
  /^(?:(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)?git\s+grep|(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)?sed\s+(?:-n|--quiet|--silent))(?:\s|$)/

/** `find` primaries that run a command or mutate the tree — any presence = deny. */
const FIND_MUTATION_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls'
])
const FIND_EXACT_READ_FLAGS = new Set(['-o', '-or'])

function isSafeRedirectTarget(target: string): boolean {
  const unquoted = target.replace(/^['"]|['"]$/g, '')
  return unquoted === '/dev/null' || unquoted === '/dev/stdout' || unquoted === '/dev/stderr'
}

/**
 * Reject dynamic shell syntax across the ORIGINAL command before redirect
 * targets are stripped. This is quote-aware: single-quoted `$`, braces, and
 * regex parentheses are literal data; outside single quotes they can trigger
 * parameter/ANSI-C/brace expansion or zsh executable glob qualifiers. A
 * backslash-newline continuation is also unsafe because the shell removes it
 * before argv construction.
 */
function hasUnsafeDynamicShellSyntax(command: string): boolean {
  let quote: 'single' | 'double' | null = null
  let escaped = false

  for (const char of command) {
    if (escaped) {
      if (char === '\n' || char === '\r') return true
      escaped = false
      continue
    }
    if (quote === 'single') {
      if (char === "'") quote = null
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote === 'double') {
      if (char === '"') quote = null
      else if (char === '$') return true
      continue
    }
    if (char === "'") {
      quote = 'single'
      continue
    }
    if (char === '"') {
      quote = 'double'
      continue
    }
    if (char === '$' || char === '{' || char === '}' || char === '(' || char === ')') {
      return true
    }
  }

  return quote !== null || escaped
}

/**
 * Validate + strip redirections and reject command substitution. Returns the
 * command with safe redirects (to /dev/null etc.) and input redirects removed,
 * or ok:false if anything unsafe is present.
 */
function sanitizeRedirects(command: string): { ok: boolean; cleaned: string } {
  // Command / process substitution can hide arbitrary (mutating) commands.
  if (/\$\(|`|<\(|>\(/.test(command)) return { ok: false, cleaned: '' }

  let cleaned = command
  // File-descriptor duplication (2>&1, >&2, 1>&2) is side-effect free only
  // when the descriptor number ends at a real shell boundary. In zsh,
  // `2>&1err` redirects to the filename `1err`; stripping the `2>&1` prefix
  // would hide that write from the remaining redirect checks.
  cleaned = cleaned
    .replace(/\d*>&\d+(?=$|[\s|;&<>])/g, ' ')
    .replace(/\d*<&\d+(?=$|[\s|;&<>])/g, ' ')

  // Any remaining output redirect (`>`, `>>`, `n>`, `n>>`, `&>`, `&>>`) must
  // target /dev/null|stdout|stderr; otherwise it writes a file → deny.
  const outputRedirect = /(?:&|\d)?>>?\s*("[^"]*"|'[^']*'|[^\s|;&<>]+)/g
  let match: RegExpExecArray | null
  while ((match = outputRedirect.exec(cleaned)) !== null) {
    if (!isSafeRedirectTarget(match[1])) return { ok: false, cleaned: '' }
  }
  cleaned = cleaned.replace(/(?:&|\d)?>>?\s*(?:\/dev\/(?:null|stdout|stderr))/g, ' ')
  // Input redirects (`< file`, `<<<`) only read — strip the operator + target.
  cleaned = cleaned.replace(/<{1,3}\s*("[^"]*"|'[^']*'|[^\s|;&<>]+)/g, ' ')

  // Defensive: no redirection metacharacters should survive. If one does, it was
  // a form we didn't recognise → fail closed.
  if (/[<>]/.test(cleaned)) return { ok: false, cleaned: '' }
  return { ok: true, cleaned }
}

/** Validate a single `find …` segment (tokens after `find`). */
function isReadOnlyFind(args: string[]): boolean {
  return !args.some((token) =>
    FIND_EXACT_READ_FLAGS.has(token)
      ? false
      : [...FIND_MUTATION_FLAGS].some(
          (dangerous) => token === dangerous || (token.length > 1 && dangerous.startsWith(token))
        )
  )
}

/** ripgrep can EXECUTE an arbitrary program per file via `--pre <cmd>` (and
 * `--hostname-bin`), turning any readable file into an executed script. Reject
 * those; every other rg flag only reads. */
function isReadOnlyRg(args: string[]): boolean {
  const dangerousFlags = ['--pre', '--hostname-bin']
  return !args.some((token) =>
    dangerousFlags.some(
      (dangerous) =>
        token.startsWith(dangerous) ||
        (token.length > 2 && token.startsWith('--') && dangerous.startsWith(token))
    )
  )
}

/** `uniq [INPUT [OUTPUT]]` — a SECOND positional is an output file it writes.
 * Allow zero or one positional (piped, or a single input file); reject two. */
function isReadOnlyUniq(args: string[]): boolean {
  let afterOptionTerminator = false
  let positionalCount = 0
  for (const token of args) {
    if (!afterOptionTerminator && token === '--') {
      afterOptionTerminator = true
      continue
    }
    if (!afterOptionTerminator && token.startsWith('-')) continue
    positionalCount += 1
    if (positionalCount > 1) return false
  }
  return true
}

/** Bare `date` and `hostname` are inert reads. Any argument is denied because
 * their platform variants include clock/host setters and positional set forms. */
function isBareSystemRead(args: string[]): boolean {
  return args.length === 0
}

const GREP_GLOB_FILTER_PREFIXES = ['--include=', '--exclude=', '--include-dir=', '--exclude-dir=']

/**
 * Split shell pipelines/sequences without treating operators inside quoted
 * arguments as syntax. The previous regex split broke commands such as
 * `rg "foo|bar"`: the regex alternation became a fake pipeline segment and a
 * provably read-only Grok request was denied, which Grok then treated as a
 * turn-ending cancellation. Malformed quoting/escaping fails closed.
 */
function splitShellSegments(command: string): string[] | null {
  const segments: string[] = []
  let segment = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const pushSegment = (): void => {
    const trimmed = segment.trim()
    if (trimmed) segments.push(trimmed)
    segment = ''
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      // zsh removes backslash + LF before tokenization, which can splice a
      // forbidden flag (`-de\\\nlete`) after policy inspection. CR/CRLF may
      // arrive through normalized transports; ambiguity fails closed too.
      if (char === '\n' || char === '\r') return null
      segment += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== 'single') {
      segment += char
      escaped = true
      continue
    }
    if (quote) {
      segment += char
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"')) {
        quote = null
      }
      continue
    }
    if (char === "'") {
      quote = 'single'
      segment += char
      continue
    }
    if (char === '"') {
      quote = 'double'
      segment += char
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      pushSegment()
      if (
        (char === '|' && (command[index + 1] === '|' || command[index + 1] === '&')) ||
        (char === '&' && command[index + 1] === '&') ||
        (char === '\r' && command[index + 1] === '\n')
      ) {
        index += 1
      }
      continue
    }
    segment += char
  }

  if (quote || escaped) return null
  pushSegment()
  return segments
}

/**
 * Tokenize one already-separated shell segment into the semantic words the
 * shell passes to the executable. Quote delimiters disappear and adjacent
 * quoted/unquoted fragments concatenate, so `-e''xec` becomes `-exec` and
 * `--p''re=/bin/sh` becomes `--pre=/bin/sh`. Backslash escapes are normalized
 * for the same reason. This is deliberately a small fail-closed lexer rather
 * than whitespace splitting: policy checks must inspect argv-like values, not
 * the source spelling an attacker controls.
 */
interface ShellWord {
  value: string
  /** Literal prefix before the first unquoted pathname-expansion token. Empty
   * means expansion can synthesize an option such as `--pre` / `-delete`. */
  pathnameExpansionPrefix?: string
}

/**
 * grep's attached include/exclude filters are patterns, not executable or
 * output-file arguments. An unquoted shell glob can only expand to more argv
 * entries retaining the same fixed option prefix, so it cannot synthesize a
 * different flag. Keep this exception command-specific; `-*` elsewhere still
 * fails closed.
 */
function grepPathnameExpansionIsReadOnly(word: ShellWord): boolean {
  const prefix = word.pathnameExpansionPrefix
  return Boolean(prefix && GREP_GLOB_FILTER_PREFIXES.some((flag) => prefix.startsWith(flag)))
}

function tokenizeShellWords(segment: string): ShellWord[] | null {
  const tokens: ShellWord[] = []
  let token = ''
  let tokenStarted = false
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let pathnameExpansionPrefix: string | undefined

  const pushToken = (): void => {
    if (tokenStarted) {
      tokens.push({
        value: token,
        ...(pathnameExpansionPrefix !== undefined ? { pathnameExpansionPrefix } : {})
      })
    }
    token = ''
    tokenStarted = false
    pathnameExpansionPrefix = undefined
  }

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (escaped) {
      token += char
      tokenStarted = true
      escaped = false
      continue
    }
    if (quote === 'single') {
      tokenStarted = true
      if (char === "'") quote = null
      else token += char
      continue
    }
    if (quote === 'double') {
      tokenStarted = true
      if (char === '"') quote = null
      else if (char === '\\') escaped = true
      // Parameter/command/arithmetic expansion remains active inside double
      // quotes. Its resulting argv is not statically provable here.
      else if (char === '$') return null
      else token += char
      continue
    }
    if (char === '\\') {
      tokenStarted = true
      escaped = true
      continue
    }
    if (char === "'") {
      tokenStarted = true
      quote = 'single'
      continue
    }
    if (char === '"') {
      tokenStarted = true
      quote = 'double'
      continue
    }
    // Dynamic argv construction is outside this classifier's proof surface.
    // `$` also covers ANSI-C `$'...'` and zsh parameter flags (`${(e)...}`).
    // Unquoted braces cover brace expansion; parentheses cover zsh glob
    // qualifiers/process substitutions capable of executing code.
    if (char === '$' || char === '{' || char === '}' || char === '(' || char === ')') {
      return null
    }
    if (char === '*' || char === '?' || char === '[' || char === '^') {
      pathnameExpansionPrefix ??= token
    }
    if (/\s/.test(char)) {
      pushToken()
      continue
    }
    tokenStarted = true
    token += char
  }

  if (quote || escaped) return null
  pushToken()
  return tokens
}

function isReadOnlySegment(segment: string): boolean {
  const words = tokenizeShellWords(segment)
  if (!words || words.length === 0) return false
  // Reuse the shared classifier only for its two explicitly bridged forms.
  // The generic parser deliberately carries a narrower command surface, so
  // routing every shared inspection head through here would erase its extra
  // rg/file safeguards.
  if (
    SHARED_INSPECTION_EXCEPTION.test(segment.trim()) &&
    isInspectionShellCommand(segment.trim())
  ) {
    return true
  }
  // Expanding the command name is arbitrary execution. For arguments, a
  // non-empty fixed prefix that does not begin with '-' proves pathname
  // expansion cannot synthesize a new option. `uniq` is stricter because one
  // glob can expand into both INPUT and OUTPUT positionals, causing a write.
  if (words[0].pathnameExpansionPrefix !== undefined) return false
  const command = words[0].value
  const expandedArguments = words
    .slice(1)
    .filter((word) => word.pathnameExpansionPrefix !== undefined)
  const grepCommand = command === 'grep' || command === 'egrep' || command === 'fgrep'
  if (
    expandedArguments.some((word) => {
      const prefixCouldSynthesizeOption =
        word.pathnameExpansionPrefix === '' || word.pathnameExpansionPrefix?.startsWith('-')
      return prefixCouldSynthesizeOption && (!grepCommand || !grepPathnameExpansionIsReadOnly(word))
    }) ||
    (command === 'uniq' && expandedArguments.length > 0)
  ) {
    return false
  }
  const rest = words.slice(1).map((word) => word.value)
  // No path/script execution, no `VAR=val cmd` prefix, no bare-flag "command".
  if (command.includes('/') || command.includes('=') || command.startsWith('-')) return false
  if (command === 'find') return isReadOnlyFind(rest)
  // Reuse the screened `git grep` proof for individual segments as well as a
  // whole command, then fall through to the strict status/diff/log surface.
  // This keeps safe `git grep ... || echo ...` sequences prompt-free without
  // admitting mutating or unknown Git subcommands.
  if (command === 'git') {
    return isInspectionShellCommand(segment) || isReadOnlyGitShellCommand(segment)
  }
  if (command === 'rg') return isReadOnlyRg(rest)
  if (command === 'uniq') return isReadOnlyUniq(rest)
  if (command === 'date' || command === 'hostname') return isBareSystemRead(rest)
  if ((command === 'true' || command === 'false') && rest.length === 0) return true
  return READ_ONLY_COMMANDS.has(command)
}

/**
 * True iff EVERY pipeline/sequence segment of `command` is a recognised
 * read-only operation. Fail-closed: any unknown command, unsafe redirect,
 * substitution, or write form makes the whole command unsafe.
 */
export function isReadOnlyShellCommand(command: string | null | undefined): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false
  // Keep the all-tier inspection surface consistent for the two single-command
  // forms that need stricter semantic flag/program screens than this general
  // parser carries (`git grep` and narrow `sed -n`).
  if (SHARED_INSPECTION_EXCEPTION.test(trimmed) && isInspectionShellCommand(trimmed)) return true
  if (hasUnsafeDynamicShellSyntax(trimmed)) return false

  const { ok, cleaned } = sanitizeRedirects(trimmed)
  if (!ok) return false

  // Split on command sequencing / piping operators outside quoted arguments:
  // && || ; | |& & and newlines.
  const meaningful = splitShellSegments(cleaned)
  if (!meaningful) return false
  if (meaningful.length === 0) return false
  return meaningful.every(isReadOnlySegment)
}

/** Pull the shell command string out of an ACP tool-call's raw input, tolerant
 * of the few shapes the command can arrive under. Returns null when absent. */
export function extractShellCommandFromToolCall(rawToolCall: unknown): string | null {
  const roots: unknown[] = []
  const top = rawToolCall as Record<string, unknown> | null | undefined
  if (top && typeof top === 'object') {
    roots.push(top)
    for (const key of ['rawInput', 'input', 'parameters', 'arguments']) {
      const nested = (top as Record<string, unknown>)[key]
      if (nested && typeof nested === 'object') roots.push(nested)
    }
  }
  for (const root of roots) {
    const command = (root as Record<string, unknown>).command
    if (typeof command === 'string' && command.trim()) return command
  }
  return null
}

/**
 * Decide whether a read-only Grok seat may run this permission-gated tool call
 * because it is a provably read-only shell command. Only applies to shell /
 * execute tool kinds; everything else returns false (the caller keeps denying).
 */
export function grokReadOnlyShellRequestAllowed(request: {
  toolKind?: string
  toolName?: string
  rawToolCall?: unknown
}): boolean {
  const kind = (request.toolKind || '').toLowerCase()
  const name = (request.toolName || '').toLowerCase().replace(/[\s:_-]+/g, '')
  const isShellTool =
    kind === 'execute' ||
    name.includes('runterminalcommand') ||
    name.includes('terminal') ||
    name === 'bash' ||
    name === 'shell'
  if (!isShellTool) return false
  const command = extractShellCommandFromToolCall(request.rawToolCall)
  return isReadOnlyShellCommand(command)
}

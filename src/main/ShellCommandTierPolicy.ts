import * as path from 'path'
import { shellCommandFromRawCommand } from './ReadOnlyGitShellCommand'

/**
 * Per-tier shell-command policy classifiers (behavior-alignment slices D/E —
 * the owner-approved permission-tier alignment record, owner directive
 * 2026-08-04). Two POLARITIES live here and must never be mixed up:
 *
 *  - `isInspectionShellCommand` is an ALLOW-list (it widens automation), so it
 *    follows the ReadOnlyGitShellCommand discipline exactly: static shell-word
 *    parsing, length cap, `~` rejection, per-head flag screening — anything it
 *    cannot positively parse as a read-only inspection command FAILS CLOSED
 *    (prompts).
 *  - The catastrophic-deletion / remote-egress / process-mutation classifiers
 *    are RESTRICTING holds (they force prompts), so they follow the
 *    IsolateSharedBranchHold polarity: no charset gate, match what parses,
 *    and never hold what they cannot parse. Compound/wrapped commands
 *    (`cd x && rm -rf y`, scripts) evade the holds — the same accepted #54
 *    residue as every shell classifier here; the executors' path containment
 *    and the audit trail remain the backstop.
 */

const MAX_COMMAND_LENGTH = 400

// Same charset the read-only git classifier uses: no quotes, $, backticks,
// separators, redirects, globs, braces, parens, control chars, backslashes.
// The inside-workspace proof uses it directly. Inspection commands use this
// grammar for unquoted text, plus strictly-literal quoted arguments so common
// search patterns such as `grep "canvas panel"` do not spuriously prompt. A
// bare pipe is handled separately and allowed only when every stage passes the
// same inspection proof.
const SAFE_CHARSET = /^[A-Za-z0-9 ._/=:,+@%~^-]+$/
const SAFE_UNQUOTED_INSPECTION_CHARACTER = /^[A-Za-z0-9._/=:,+@%~^-]$/

const STRIPPABLE_BIN_PREFIX = /^(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)/

function tokensOf(command: string): string[] {
  return command.trim().split(/\s+/)
}

/**
 * Shell words for the inspection allowlist. This deliberately understands
 * only literal quoting: single quotes are wholly literal; double quotes reject
 * `$`, backticks, and backslashes because all three can trigger or preserve
 * shell expansion. Quote delimiters are removed and adjacent pieces join, so
 * policy screens see the argv that the executable receives (`--p''re` becomes
 * `--pre`). Anything beyond this small, static grammar fails closed.
 */
function inspectionTokensOf(command: string): string[] | null {
  const tokens: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: 'single' | 'double' | null = null

  const pushToken = (): void => {
    if (tokenStarted) tokens.push(token)
    token = ''
    tokenStarted = false
  }

  const isAsciiControlCharacter = (character: string): boolean => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  }

  for (const character of command.trim()) {
    if (quote === 'single') {
      if (character === "'") quote = null
      else if (isAsciiControlCharacter(character)) return null
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
        isAsciiControlCharacter(character)
      ) {
        return null
      } else token += character
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
    if (!SAFE_UNQUOTED_INSPECTION_CHARACTER.test(character)) return null
    token += character
    tokenStarted = true
  }

  if (quote !== null) return null
  pushToken()
  return tokens
}

/**
 * Split only ordinary stdout pipelines while preserving literal pipes inside
 * quotes. Every other shell composition operator remains rejected later by
 * `inspectionTokensOf`; empty stages make `||` and malformed pipelines fail
 * closed before any per-command classification.
 */
function inspectionPipelineSegmentsOf(command: string): string[] | null {
  const segments: string[] = []
  let quote: 'single' | 'double' | null = null
  let segmentStart = 0

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote === 'single') {
      if (character === "'") quote = null
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      continue
    }
    if (character === "'") {
      quote = 'single'
      continue
    }
    if (character === '"') {
      quote = 'double'
      continue
    }
    if (character !== '|') continue
    const segment = command.slice(segmentStart, index).trim()
    if (!segment) return null
    segments.push(segment)
    segmentStart = index + 1
  }

  if (quote !== null) return null
  const finalSegment = command.slice(segmentStart).trim()
  if (!finalSegment) return null
  segments.push(finalSegment)
  return segments
}

function headOf(tokens: string[]): string {
  return (tokens[0] ?? '').replace(STRIPPABLE_BIN_PREFIX, '')
}

/**
 * Read-only inspection heads whose EVERY flag is harmless. Deliberately absent:
 * `find` (-delete/-exec/-fprintf write or execute), `awk` (in-place writes /
 * system()), `xargs` (executes), `env` with arguments (executes), interpreters,
 * and anything that talks to the network (that's the remote-egress hold's
 * territory). Globs and redirects never reach these heads — the charset gate
 * rejects the whole command first. Heads that are read-only EXCEPT for
 * specific flag or operand shapes (`sort`, `uniq`, `tree`, `file`,
 * `hostname`, `date`, `sed`) live in the screened dispatch below instead,
 * beside `rg`/`env` — membership here asserts the any-flags claim.
 */
const INSPECTION_HEADS_ANY_FLAGS: ReadonlySet<string> = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'du',
  'df',
  'cut',
  'comm',
  'diff',
  'cmp',
  'nl',
  'strings',
  'which',
  'whoami',
  'uname',
  'id',
  'groups',
  'basename',
  'dirname',
  'readlink',
  'realpath',
  'printenv',
  'shasum',
  'cksum',
  'echo',
  'grep',
  'egrep',
  'fgrep'
])

/**
 * Screened inspection heads: read-only in ordinary use, but with a known
 * write/exec completion that the per-head predicate must reject. Same
 * allow-polarity discipline as the rg `--pre` screen — anything the predicate
 * cannot positively clear fails closed to the ordinary prompt. Short-flag
 * screens match bundled clusters (`sort -ro out` hides `-o` inside `-ro`) and
 * attached values (`-oout.txt`), which is why they test for the letter
 * anywhere in a single-dash token rather than an exact flag.
 */
function splitFlagsAndOperands(args: readonly string[]): {
  flags: string[]
  operands: string[]
} {
  const flags: string[] = []
  const operands: string[] = []
  let seenDashDash = false
  for (const token of args) {
    if (!seenDashDash && token === '--') {
      seenDashDash = true
      continue
    }
    if (!seenDashDash && token.startsWith('-')) flags.push(token)
    else operands.push(token)
  }
  return { flags, operands }
}

// sort: `-o <file>`/`--output` write, `--compress-program` executes, and
// `-T`/`--temporary-directory` spills temp files to a chosen directory. `-o`
// is sort's only o-bearing short flag, so a cluster letter test is exact.
function sortArgsAreReadOnly(args: readonly string[]): boolean {
  return !args.some(
    (token) =>
      /^-[^-]*[oT]/.test(token) ||
      token.startsWith('--output') ||
      token.startsWith('--compress-program') ||
      token.startsWith('--temporary-directory')
  )
}

// uniq: a second operand is an OUTPUT file. The separate-argument forms of
// `-f`/`-s`/`-w` make the operand count ambiguous, so they fail closed; the
// attached (`-f2`) and `=` (`--skip-fields=2`) forms stay allowed.
function uniqArgsAreReadOnly(args: readonly string[]): boolean {
  const { flags, operands } = splitFlagsAndOperands(args)
  if (flags.some((token) => token === '-f' || token === '-s' || token === '-w')) return false
  return operands.length <= 1
}

// tree: `-o <file>` writes the report to disk; `-o` is tree's only o-bearing
// short flag.
function treeArgsAreReadOnly(args: readonly string[]): boolean {
  return !args.some((token) => /^-[^-]*o/.test(token) || token.startsWith('--output'))
}

// file: `-C` compiles a .mgc magic file to disk (lowercase `-c` merely prints
// the parsed magic — the screen is case-sensitive on purpose).
function fileArgsAreReadOnly(args: readonly string[]): boolean {
  return !args.some((token) => /^-[^-]*C/.test(token) || token.startsWith('--compile'))
}

// hostname: any operand is the set-hostname form; `-F <file>`/`--file` and
// `-b`/`--boot` set it too. Lowercase `-f`/`-s` (FQDN/short) remain reads.
function hostnameArgsAreReadOnly(args: readonly string[]): boolean {
  const { flags, operands } = splitFlagsAndOperands(args)
  if (operands.length > 0) return false
  return !flags.some(
    (token) => /^-[^-]*[Fb]/.test(token) || token.startsWith('--file') || token.startsWith('--boot')
  )
}

// date: a bare operand is the BSD set-clock form and `-s`/`--set` is the GNU
// one; `-f` is BSD parse-and-set (GNU reads dates from a file with it — fail
// closed on both). `+format` operands and one value after the read-only
// `-r`/`-d` flags stay allowed.
function dateArgsAreReadOnly(args: readonly string[]): boolean {
  let seenDashDash = false
  let expectFlagValue = false
  for (const token of args) {
    if (expectFlagValue) {
      expectFlagValue = false
      continue
    }
    if (!seenDashDash && token === '--') {
      seenDashDash = true
      continue
    }
    if (!seenDashDash && token.startsWith('-')) {
      if (/^-[^-]*[sf]/.test(token) || token.startsWith('--set') || token.startsWith('--file')) {
        return false
      }
      if (token === '-r' || token === '-d') expectFlagValue = true
      continue
    }
    if (!token.startsWith('+')) return false
  }
  return true
}

/**
 * `sed` is inspection-safe only for the deliberately narrow source-view forms
 * used by agents: `sed -n '401,600p' path` and a semicolon-separated list of
 * those print-only ranges. `-i`, arbitrary `-e` programs, `-f` scripts, and
 * write/execute commands stay outside this allowlist.
 */
function sedArgsAreReadOnly(args: readonly string[]): boolean {
  let index = 0
  let quiet = false
  while (index < args.length) {
    const token = args[index]
    if (token === '-n' || token === '--quiet' || token === '--silent') {
      quiet = true
      index += 1
      continue
    }
    break
  }
  if (!quiet) return false

  const program = args[index]
  const printRange = /^(?:[1-9]\d*|\$)(?:,(?:[1-9]\d*|\$))?p$/
  if (!program || !program.split(';').every((clause) => printRange.test(clause.trim()))) {
    return false
  }
  index += 1

  let literalPaths = false
  for (; index < args.length; index += 1) {
    const token = args[index]
    if (!literalPaths && token === '--') {
      literalPaths = true
      continue
    }
    // GNU sed permits options after the program, so a leading `-` must be
    // explicitly protected by `--` before it can be a source filename.
    if (!literalPaths && token.startsWith('-') && token !== '-') return false
  }
  return true
}

const GIT_GREP_SIMPLE_FLAGS: ReadonlySet<string> = new Set([
  '--cached',
  '--no-cached',
  '--index',
  '--untracked',
  '--no-untracked',
  '--exclude-standard',
  '--no-exclude-standard',
  '--no-recurse-submodules',
  '--invert-match',
  '--no-invert-match',
  '--ignore-case',
  '--no-ignore-case',
  '--word-regexp',
  '--no-word-regexp',
  '--text',
  '--no-text',
  '--no-textconv',
  '--recursive',
  '--no-recursive',
  '--extended-regexp',
  '--no-extended-regexp',
  '--basic-regexp',
  '--no-basic-regexp',
  '--fixed-strings',
  '--no-fixed-strings',
  '--perl-regexp',
  '--no-perl-regexp',
  '--line-number',
  '--no-line-number',
  '--column',
  '--no-column',
  '--full-name',
  '--no-full-name',
  '--files-with-matches',
  '--no-files-with-matches',
  '--name-only',
  '--files-without-match',
  '--no-files-without-match',
  '--null',
  '--no-null',
  '--only-matching',
  '--no-only-matching',
  '--count',
  '--no-count',
  '--break',
  '--no-break',
  '--heading',
  '--no-heading',
  '--show-function',
  '--no-show-function',
  '--function-context',
  '--no-function-context',
  '--and',
  '--or',
  '--not',
  '--quiet',
  '--no-quiet',
  '--all-match',
  '--no-all-match',
  '--no-ext-grep'
])

const GIT_GREP_COMBINABLE_SHORT_FLAGS = /^[viwaIrEGFPnhHlLzocpWq]+$/
const GIT_GREP_ATTACHED_NUMBER_FLAG = /^-(?:[CBAm]\d+|\d+)$/
const GIT_GREP_NUMBER_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '-B',
  '-A',
  '-m',
  '--context',
  '--before-context',
  '--after-context',
  '--max-depth',
  '--threads',
  '--max-count'
])
const GIT_GREP_NUMBER_FLAG_PREFIXES = [
  '--context=',
  '--before-context=',
  '--after-context=',
  '--max-depth=',
  '--threads=',
  '--max-count='
]

/**
 * `git grep` is a workspace inspection command except its pager, external
 * grep, text-conversion, and no-index modes. The accepted flag surface is
 * deliberately explicit: an unknown or future option prompts rather than
 * becoming a zero-click shell capability.
 */
function gitGrepArgsAreReadOnly(args: readonly string[]): boolean {
  let subcommandIndex = 0
  // This exact override disables the repository-configured fsmonitor instead
  // of naming a hook to execute. All other `git -c` forms remain outside the
  // prompt-free proof surface.
  if (args[0] === '-c') {
    if (args[1] !== 'core.fsmonitor=false') return false
    subcommandIndex = 2
  }
  if (args[subcommandIndex] !== 'grep') return false
  let literalOperands = false
  for (let index = subcommandIndex + 1; index < args.length; index += 1) {
    const token = args[index]
    if (literalOperands) continue
    if (token === '--') {
      literalOperands = true
      continue
    }
    if (!token.startsWith('-') || token === '-') continue
    if (GIT_GREP_SIMPLE_FLAGS.has(token)) continue
    if (GIT_GREP_COMBINABLE_SHORT_FLAGS.test(token.slice(1))) continue
    if (GIT_GREP_ATTACHED_NUMBER_FLAG.test(token)) continue
    if (GIT_GREP_NUMBER_FLAGS.has(token)) {
      const value = args[index + 1]
      if (!value || !/^\d+$/.test(value)) return false
      index += 1
      continue
    }
    if (
      GIT_GREP_NUMBER_FLAG_PREFIXES.some((prefix) => token.startsWith(prefix)) &&
      /^\d+$/.test(token.slice(token.indexOf('=') + 1))
    ) {
      continue
    }
    if (token === '-e') {
      if (args[index + 1] === undefined) return false
      index += 1
      continue
    }
    if (token === '--color' || token.startsWith('--color=')) continue
    return false
  }
  return true
}

const SCREENED_INSPECTION_HEADS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  sort: sortArgsAreReadOnly,
  uniq: uniqArgsAreReadOnly,
  tree: treeArgsAreReadOnly,
  file: fileArgsAreReadOnly,
  hostname: hostnameArgsAreReadOnly,
  date: dateArgsAreReadOnly,
  sed: sedArgsAreReadOnly
}

// rg is inspection-safe EXCEPT its preprocessor flags, which execute an
// arbitrary command per file (`--pre <cmd>`): reject any token starting
// with `--pre` (covers --pre and --pre-glob, = and space forms).
const RG_REJECT_FLAG_PREFIX = '--pre'

/**
 * Is this exact shell string a pure read-only inspection command (`ls`, `cat`,
 * `grep`, `git grep`, or a narrow `sed -n` source range)? Allowed prompt-free
 * under every posture — the shell twins of the auto-allowed MCP read tools
 * (read_file / list_directory / workspace_search), mirroring the read-only git
 * fast path. Fails closed on anything else.
 */
function inspectionTokensAreReadOnly(tokens: string[] | null): boolean {
  if (!tokens || tokens.length === 0) return false
  // Word-initial `~` is the one in-charset character the shell still expands.
  if (tokens.some((token) => token.startsWith('~'))) return false
  const head = headOf(tokens)
  // Absolute/relative-path heads beyond the standard bin prefixes stay unknown.
  if (tokens[0] !== head && !STRIPPABLE_BIN_PREFIX.test(tokens[0] ?? '')) return false
  if (head.includes('/')) return false
  if (head === 'rg') {
    return !tokens.slice(1).some((token) => token.startsWith(RG_REJECT_FLAG_PREFIX))
  }
  if (head === 'env') {
    // Bare `env` prints the environment; `env X=1 cmd` EXECUTES cmd.
    return tokens.length === 1
  }
  if (head === 'git') return gitGrepArgsAreReadOnly(tokens.slice(1))
  const screened = Object.prototype.hasOwnProperty.call(SCREENED_INSPECTION_HEADS, head)
    ? SCREENED_INSPECTION_HEADS[head]
    : undefined
  if (screened) return screened(tokens.slice(1))
  return INSPECTION_HEADS_ANY_FLAGS.has(head)
}

export function isInspectionShellCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return false
  const segments = inspectionPipelineSegmentsOf(trimmed)
  return Boolean(
    segments?.every((segment) => inspectionTokensAreReadOnly(inspectionTokensOf(segment)))
  )
}

/**
 * Catastrophic-deletion classifier (hold polarity): `rm` with a recursive
 * flag, `find` carrying an action that deletes or executes, and `shred`.
 * Plain `rm file` is ordinary mutation — the run's shell policy governs it.
 */
export function isCatastrophicDeletionShellCommand(command: unknown): boolean {
  const cmd = typeof command === 'string' ? command.trim() : ''
  if (!cmd) return false
  const tokens = tokensOf(cmd)
  const head = headOf(tokens)
  if (head === 'shred') return true
  if (head === 'find') {
    return tokens.some(
      (token) =>
        token === '-delete' ||
        token === '-exec' ||
        token === '-execdir' ||
        token === '-ok' ||
        token === '-okdir'
    )
  }
  if (head !== 'rm') return false
  return tokens
    .slice(1)
    .some((token) => token === '--recursive' || (/^-[A-Za-z]+$/.test(token) && /[rR]/.test(token)))
}

/**
 * Is one path operand provably inside the workspace? Relative targets without
 * `..` are inside by construction for any cwd inside the workspace; absolute
 * targets must sit under the resolved root. Shared by the deletion proof and
 * the inbound-fetch proof so the two agree on what containment means.
 */
function pathProvablyInsideWorkspace(target: string, workspaceRoot: string): boolean {
  if (target.startsWith('~')) return false
  if (target.split('/').some((segment) => segment === '..')) return false
  if (!path.isAbsolute(target)) return true
  const resolved = path.resolve(target)
  return resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)
}

/**
 * PROOF that every deletion target stays inside the workspace — used only to
 * let Full Access auto-approve in-workspace `rm -r` (owner spec: "ALWAYS
 * APPROVE IN WORKSPACE"). Because this WIDENS automation it flips back to
 * allow-polarity: metacharacters, `~`, `..` segments, flag-less parse
 * ambiguity, or an empty target list all fail closed (→ prompt). Relative
 * targets without `..` are inside by construction for any cwd inside the
 * workspace; absolute targets must sit under the workspace root.
 */
export function deletionTargetsProvablyInsideWorkspace(
  command: unknown,
  workspacePath: string | null | undefined
): boolean {
  if (typeof command !== 'string' || !workspacePath) return false
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return false
  if (!SAFE_CHARSET.test(trimmed)) return false
  const tokens = tokensOf(trimmed)
  if (headOf(tokens) !== 'rm') return false
  let seenDashDash = false
  const targets: string[] = []
  for (const token of tokens.slice(1)) {
    if (!seenDashDash && token === '--') {
      seenDashDash = true
      continue
    }
    if (!seenDashDash && token.startsWith('-')) continue
    targets.push(token)
  }
  if (targets.length === 0) return false
  const workspaceRoot = path.resolve(workspacePath)
  return targets.every((target) => pathProvablyInsideWorkspace(target, workspaceRoot))
}

const REMOTE_EGRESS_HEADS: ReadonlySet<string> = new Set([
  'ssh',
  'autossh',
  'ssh-copy-id',
  'scp',
  'sftp',
  'mosh',
  'telnet',
  'nc',
  'ncat',
  'netcat',
  'curl',
  'wget',
  'ftp'
])

// rsync is remote only when a target names a host (`host:path` /
// `user@host:path` / `rsync://…`) or an explicit remote shell is requested.
const RSYNC_REMOTE_TARGET = /^(?:[^\s/]+@)?[^\s/:]+:/

/**
 * Remote/SSH + raw network egress classifier (hold polarity). Owner spec:
 * these ASK at Full WS Access AND Full Access (and the hold also survives
 * grants/YOLO at Accept Edits). Web reads via the governed web_search /
 * web_fetch tools are unaffected — this is about the uncontained shell.
 */
export function isRemoteEgressShellCommand(command: unknown): boolean {
  const cmd = typeof command === 'string' ? command.trim() : ''
  if (!cmd) return false
  const tokens = tokensOf(cmd)
  const head = headOf(tokens)
  if (REMOTE_EGRESS_HEADS.has(head)) return true
  if (head !== 'rsync') return false
  return tokens
    .slice(1)
    .some(
      (token) => token === '-e' || token.startsWith('rsync://') || RSYNC_REMOTE_TARGET.test(token)
    )
}

/**
 * INBOUND-FETCH carve-out inside the remote-egress hold (owner directive
 * 2026-08-26). What the hold actually buys is that nothing leaves this machine
 * un-prompted; a download that only pulls bytes IN and lands them at a named
 * path inside the workspace spends none of that value, so the write tiers stop
 * paying the UX cost that PermissionTierBehaviorAlignment.md recorded when the
 * hold shipped. Exfiltration, remote shells, and uploads are untouched.
 *
 * Because this WIDENS automation it is allow-polarity throughout and fails
 * closed on anything it cannot positively parse. Critically, the proof spans
 * the WHOLE command rather than its head: every hold classifier here screens a
 * head token only, so clearing `curl` on its own would hand
 * `curl url && rm -rf ~` a zero-click path that the deletion hold never even
 * looks at. A chain qualifies only when each segment is itself either a proven
 * download or a pure read-only inspection command.
 */

/**
 * Split `&&` / `;` sequences, quote-aware. A pipe is rejected outright —
 * `curl url | sh` is the canonical download-and-execute and no inbound fetch
 * needs one — as are redirects, subshells, expansion and background `&`, all
 * of which hide the real effect from a static read.
 */
function fetchChainSegmentsOf(command: string): string[] | null {
  const segments: string[] = []
  let quote: 'single' | 'double' | null = null
  let segmentStart = 0

  const pushSegment = (end: number): boolean => {
    const segment = command.slice(segmentStart, end).trim()
    if (!segment) return false
    segments.push(segment)
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote === 'single') {
      if (character === "'") quote = null
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      else if (character === '$' || character === '`' || character === '\\') return null
      continue
    }
    if (character === "'") {
      quote = 'single'
      continue
    }
    if (character === '"') {
      quote = 'double'
      continue
    }
    if ('|<>(){}$`\\'.includes(character)) return null
    if (character === ';') {
      if (!pushSegment(index)) return null
      segmentStart = index + 1
      continue
    }
    if (character !== '&') continue
    // A lone `&` backgrounds the job; only `&&` sequences a chain.
    if (command[index + 1] !== '&') return null
    if (!pushSegment(index)) return null
    index += 1
    segmentStart = index + 1
  }

  if (quote !== null) return null
  if (!pushSegment(command.length)) return null
  return segments
}

interface FetchOptionSpec {
  /** Short flags taking no value; safe anywhere in a bundled cluster. */
  shortNoValue: string
  /** Short flags consuming the rest of their cluster, or the next token. */
  shortWithValue: string
  longNoValue: ReadonlySet<string>
  longWithValue: ReadonlySet<string>
}

/**
 * getopt-style walk over a fetch command's arguments. ALLOWLIST, exactly as
 * `gitGrepArgsAreReadOnly` is: an unknown or future option prompts rather than
 * silently becoming a zero-click capability. Only value-bearing options are
 * returned — the no-value letters are safe by membership alone.
 */
function parseFetchOptions(
  args: readonly string[],
  spec: FetchOptionSpec
): { values: Array<{ name: string; value: string }>; operands: string[] } | null {
  const values: Array<{ name: string; value: string }> = []
  const operands: string[] = []
  let literalOperands = false

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!literalOperands && token === '--') {
      literalOperands = true
      continue
    }
    if (literalOperands || !token.startsWith('-') || token === '-') {
      operands.push(token)
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token : token.slice(0, equals)
      if (spec.longNoValue.has(name)) {
        if (equals !== -1) return null
        continue
      }
      if (!spec.longWithValue.has(name)) return null
      if (equals !== -1) {
        values.push({ name, value: token.slice(equals + 1) })
        continue
      }
      const value = args[index + 1]
      if (value === undefined) return null
      index += 1
      values.push({ name, value })
      continue
    }
    const cluster = token.slice(1)
    for (let position = 0; position < cluster.length; position += 1) {
      const letter = cluster[position]
      if (spec.shortNoValue.includes(letter)) continue
      if (!spec.shortWithValue.includes(letter)) return null
      const attached = cluster.slice(position + 1)
      if (attached) {
        values.push({ name: `-${letter}`, value: attached })
      } else {
        const value = args[index + 1]
        if (value === undefined) return null
        index += 1
        values.push({ name: `-${letter}`, value })
      }
      break
    }
  }

  return { values, operands }
}

// Only http/https. `file://`, `scp://`, `dict://` and friends turn the same
// binary into a local reader or an upload channel.
const HTTP_FETCH_URL = /^https?:\/\/[^/?#]+(?:[/?#].*)?$/i

const CURL_INBOUND_OPTIONS: FetchOptionSpec = {
  // s/S silent + show-error, L follow redirects, f fail, i/I response headers
  // and HEAD, v verbose, g globoff, R remote-time, 4/6 address family.
  // Deliberately absent: k (insecure), O/J (URL- or server-chosen filename, so
  // there is no destination to prove), a (append), n (netrc).
  shortNoValue: 'sSLfiIvgR46',
  // o output (destination-screened), m max-time, A user-agent, H header,
  // e referer, b cookie (a read), r range, z time-cond. Deliberately absent:
  // d/F/T (request bodies and uploads — the exfiltration shapes), X (method),
  // K (a config file of arbitrary further options), D (header dump to disk),
  // c (cookie-jar write), u/E (credentials).
  shortWithValue: 'omAHebrz',
  longNoValue: new Set([
    '--silent',
    '--show-error',
    '--location',
    '--fail',
    '--fail-with-body',
    '--fail-early',
    '--include',
    '--head',
    '--verbose',
    '--compressed',
    '--create-dirs',
    '--globoff',
    '--remote-time',
    '--no-progress-meter',
    '--no-buffer',
    '--ipv4',
    '--ipv6'
  ]),
  longWithValue: new Set([
    '--output',
    '--url',
    '--max-time',
    '--connect-timeout',
    '--retry',
    '--retry-delay',
    '--retry-max-time',
    '--user-agent',
    '--header',
    '--referer',
    '--cookie',
    '--range',
    '--time-cond',
    '--max-filesize',
    '--limit-rate'
  ])
}

const WGET_INBOUND_OPTIONS: FetchOptionSpec = {
  // q quiet, c continue, N timestamping, S server-response, 4/6 address
  // family. Deliberately absent: r/m/p/k (recursive mirroring rewrites whole
  // trees), b (background).
  shortNoValue: 'qcNS46',
  // O output-document (destination-screened), T timeout, t tries, U
  // user-agent. Deliberately absent: o/a (LOG writes — note wget inverts
  // curl's o/O), P (directory prefix), i (a file of further URLs), e (executes
  // wgetrc directives).
  shortWithValue: 'OTtU',
  longNoValue: new Set([
    '--quiet',
    '--no-verbose',
    '--continue',
    '--timestamping',
    '--server-response',
    '--inet4-only',
    '--inet6-only'
  ]),
  longWithValue: new Set([
    '--output-document',
    '--timeout',
    '--connect-timeout',
    '--read-timeout',
    '--tries',
    '--user-agent',
    '--header',
    '--wait',
    '--limit-rate'
  ])
}

function curlIsInboundFetch(args: readonly string[], workspaceRoot: string): boolean {
  const parsed = parseFetchOptions(args, CURL_INBOUND_OPTIONS)
  if (!parsed) return false
  let urlCount = parsed.operands.length
  for (const { name, value } of parsed.values) {
    if (name === '-o' || name === '--output') {
      // `-` is stdout, which writes nothing.
      if (value !== '-' && !pathProvablyInsideWorkspace(value, workspaceRoot)) return false
      continue
    }
    if (name === '--url') {
      if (!HTTP_FETCH_URL.test(value)) return false
      urlCount += 1
    }
  }
  if (urlCount === 0) return false
  return parsed.operands.every((operand) => HTTP_FETCH_URL.test(operand))
}

function wgetIsInboundFetch(args: readonly string[], workspaceRoot: string): boolean {
  const parsed = parseFetchOptions(args, WGET_INBOUND_OPTIONS)
  if (!parsed) return false
  let namedDestination = false
  for (const { name, value } of parsed.values) {
    if (name !== '-O' && name !== '--output-document') continue
    if (value !== '-' && !pathProvablyInsideWorkspace(value, workspaceRoot)) return false
    namedDestination = true
  }
  // Bare wget writes a remote-chosen filename into the cwd, which no static
  // read can place — an explicit destination is required before it can prove.
  if (!namedDestination) return false
  if (parsed.operands.length === 0) return false
  return parsed.operands.every((operand) => HTTP_FETCH_URL.test(operand))
}

function segmentIsProvableInboundFetch(segment: string, workspaceRoot: string): boolean {
  const tokens = inspectionTokensOf(segment)
  if (!tokens || tokens.length === 0) return false
  // Word-initial `~` is the one in-charset character the shell still expands.
  if (tokens.some((token) => token.startsWith('~'))) return false
  const head = headOf(tokens)
  if (tokens[0] !== head && !STRIPPABLE_BIN_PREFIX.test(tokens[0] ?? '')) return false
  if (head.includes('/')) return false
  if (head === 'curl') return curlIsInboundFetch(tokens.slice(1), workspaceRoot)
  if (head === 'wget') return wgetIsInboundFetch(tokens.slice(1), workspaceRoot)
  return false
}

/**
 * PROOF that an egress-matching command only fetches bytes inward — used to let
 * the write tiers auto-approve downloads without reopening the exfiltration,
 * remote-shell, or download-and-execute shapes the hold exists for. Every
 * segment must be either a provable curl/wget download to a named in-workspace
 * destination, or a pure read-only inspection command; anything else (an
 * interpreter, an installer, `rm`, an unparseable operand) fails the whole
 * chain closed to the ordinary prompt.
 */
export function remoteEgressIsProvablyInboundFetch(
  command: unknown,
  workspacePath: string | null | undefined
): boolean {
  if (typeof command !== 'string' || !workspacePath) return false
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return false
  const segments = fetchChainSegmentsOf(trimmed)
  if (!segments) return false
  const workspaceRoot = path.resolve(workspacePath)
  let sawFetch = false
  for (const segment of segments) {
    if (isRemoteEgressShellCommand(segment)) {
      if (!segmentIsProvableInboundFetch(segment, workspaceRoot)) return false
      sawFetch = true
      continue
    }
    if (!isInspectionShellCommand(segment)) return false
  }
  return sawFetch
}

const PROCESS_MUTATION_HEADS: ReadonlySet<string> = new Set([
  'kill',
  'pkill',
  'killall',
  'launchctl',
  'systemctl'
])

/** System-process mutation classifier (hold polarity): kill family + service managers. */
export function isSystemProcessMutationShellCommand(command: unknown): boolean {
  const cmd = typeof command === 'string' ? command.trim() : ''
  if (!cmd) return false
  return PROCESS_MUTATION_HEADS.has(headOf(tokensOf(cmd)))
}

export interface ShellCommandTierHoldArgs {
  presetId: string | null | undefined
  service: string | null | undefined
  /** Raw tool-call command value (string / argv / sh -c wrapper). */
  shellCommand: unknown
  workspacePath?: string | null
}

/**
 * The single per-tier shell hold folded into `neverAutoAllow` at both gate
 * sites (beside the plan-instrument and Isolate holds). Ask-hold, not deny —
 * unattended lanes fail safe via the approval timeout. Rules (owner spec):
 *
 *  - Remote/SSH + raw network egress: hold at EVERY tier, EXCEPT a provably
 *    inbound fetch at the two write tiers (owner directive 2026-08-26 — see
 *    `remoteEgressIsProvablyInboundFetch`). Read tiers never auto-allow shell
 *    anyway; the hold still keeps grants/session-YOLO from silencing the
 *    prompt for every other egress shape at the write tiers.
 *  - Catastrophic deletion (`rm -r` class): hold everywhere EXCEPT Full
 *    Access with every target provably inside the workspace — "always
 *    approve in workspace" is Full Access's explicit contract.
 *  - System-process mutation: hold at Full WS Access only (owner spec asks
 *    there; Full Access runs it automatically; Accept Edits already prompts
 *    for shell by policy).
 */
export function shellCommandTierHold(args: ShellCommandTierHoldArgs): boolean {
  if (args.service !== 'shellCommands') return false
  const cmd = shellCommandFromRawCommand(args.shellCommand)
  if (cmd === null) return false
  if (isRemoteEgressShellCommand(cmd)) {
    // Inbound-fetch carve-out: the write tiers stop asking for a download that
    // only pulls bytes in and lands them at a named in-workspace path. Every
    // other egress shape — and any chain the proof cannot fully account for —
    // still asks, at every tier.
    if (args.presetId !== 'workspace_write' && args.presetId !== 'full_access') return true
    return !remoteEgressIsProvablyInboundFetch(cmd, args.workspacePath)
  }
  if (isCatastrophicDeletionShellCommand(cmd)) {
    if (args.presetId === 'full_access') {
      return !deletionTargetsProvablyInsideWorkspace(cmd, args.workspacePath)
    }
    return true
  }
  if (args.presetId === 'workspace_write' && isSystemProcessMutationShellCommand(cmd)) return true
  return false
}

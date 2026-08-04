import * as path from 'path'
import { shellCommandFromRawCommand } from './ReadOnlyGitShellCommand'

/**
 * Per-tier shell-command policy classifiers (behavior-alignment slices D/E —
 * docs/refactors/PermissionTierBehaviorAlignment.md, owner directive
 * 2026-08-04). Two POLARITIES live here and must never be mixed up:
 *
 *  - `isInspectionShellCommand` is an ALLOW-list (it widens automation), so it
 *    follows the ReadOnlyGitShellCommand discipline exactly: charset gate,
 *    length cap, `~` rejection, per-head flag screening — anything it cannot
 *    positively parse as a read-only inspection command FAILS CLOSED (prompts).
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
// Only the ALLOW-polarity classifier and the inside-workspace PROOF use it.
const SAFE_CHARSET = /^[A-Za-z0-9 ._/=:,+@%~^-]+$/

const STRIPPABLE_BIN_PREFIX = /^(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)/

function tokensOf(command: string): string[] {
  return command.trim().split(/\s+/)
}

function headOf(tokens: string[]): string {
  return (tokens[0] ?? '').replace(STRIPPABLE_BIN_PREFIX, '')
}

/**
 * Read-only inspection heads whose EVERY flag is harmless. Deliberately absent:
 * `find` (-delete/-exec/-fprintf write or execute), `sed`/`awk` (-i writes /
 * system()), `xargs` (executes), `env` with arguments (executes), interpreters,
 * and anything that talks to the network (that's the remote-egress hold's
 * territory). Globs and redirects never reach these heads — the charset gate
 * rejects the whole command first. Heads that are read-only EXCEPT for
 * specific flag or operand shapes (`sort`, `uniq`, `tree`, `file`,
 * `hostname`, `date`) live in the screened dispatch below instead, beside
 * `rg`/`env` — membership here asserts the any-flags claim.
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

const SCREENED_INSPECTION_HEADS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  sort: sortArgsAreReadOnly,
  uniq: uniqArgsAreReadOnly,
  tree: treeArgsAreReadOnly,
  file: fileArgsAreReadOnly,
  hostname: hostnameArgsAreReadOnly,
  date: dateArgsAreReadOnly
}

// rg is inspection-safe EXCEPT its preprocessor flags, which execute an
// arbitrary command per file (`--pre <cmd>`): reject any token starting
// with `--pre` (covers --pre and --pre-glob, = and space forms).
const RG_REJECT_FLAG_PREFIX = '--pre'

/**
 * Is this exact shell string a pure read-only inspection command (`ls`, `cat`,
 * `grep`, …)? Allowed prompt-free under every posture — the shell twins of the
 * auto-allowed MCP read tools (read_file / list_directory / workspace_search),
 * mirroring the read-only git fast path. Fails closed on anything else.
 */
export function isInspectionShellCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return false
  if (!SAFE_CHARSET.test(trimmed)) return false
  const tokens = tokensOf(trimmed)
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
  const screened = Object.prototype.hasOwnProperty.call(SCREENED_INSPECTION_HEADS, head)
    ? SCREENED_INSPECTION_HEADS[head]
    : undefined
  if (screened) return screened(tokens.slice(1))
  return INSPECTION_HEADS_ANY_FLAGS.has(head)
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
  return targets.every((target) => {
    if (target.startsWith('~')) return false
    if (target.split('/').some((segment) => segment === '..')) return false
    if (!path.isAbsolute(target)) return true
    const resolved = path.resolve(target)
    return resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)
  })
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
 *  - Remote/SSH + raw network egress: hold at EVERY tier. (Read tiers never
 *    auto-allow shell anyway; this keeps grants/session-YOLO from silencing
 *    the prompt at the write tiers.)
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
  if (isRemoteEgressShellCommand(cmd)) return true
  if (isCatastrophicDeletionShellCommand(cmd)) {
    if (args.presetId === 'full_access') {
      return !deletionTargetsProvablyInsideWorkspace(cmd, args.workspacePath)
    }
    return true
  }
  if (args.presetId === 'workspace_write' && isSystemProcessMutationShellCommand(cmd)) return true
  return false
}

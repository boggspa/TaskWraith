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
//   - `git` write subcommands, or dual-mode subcommands (remote/branch/tag/
//     config/stash) in anything but their read form → false
//   - `find` with `-exec/-delete/…` → false
// The allowlist is deliberately small; widen it only with matching tests.

/** Commands that cannot mutate state through flags AND have no output-file
 * positional / no command-exec flag. Redirections and substitutions are rejected
 * separately, so these are safe with any of their own flags. Commands that CAN
 * write or exec via their own flags/positionals (`git`, `find`, `rg`, `uniq`)
 * are handled specially below — do NOT add them here. Deliberately EXCLUDED:
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
  'printf',
  'wc',
  'stat',
  'file',
  'which',
  'type',
  'printenv',
  'date',
  'whoami',
  'id',
  'uname',
  'hostname',
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

/** `git` subcommands that only ever read in every form. */
const GIT_ALWAYS_READ = new Set([
  'log',
  'show',
  'status',
  'diff',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'describe',
  'blame',
  'shortlog',
  'rev-list',
  'show-ref',
  'for-each-ref',
  'name-rev',
  'merge-base',
  'grep',
  'whatchanged',
  'cherry',
  'count-objects',
  'show-branch'
])

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

const BRANCH_WRITE_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-f',
  '--force',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description'
])

const TAG_WRITE_FLAGS = new Set([
  '-a',
  '--annotate',
  '-s',
  '--sign',
  '-d',
  '--delete',
  '-m',
  '--message',
  '-f',
  '--force',
  '-e',
  '--edit',
  '--create-reflog'
])

const CONFIG_READ_FLAGS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--list',
  '-l'
])

/** `git config` flags that write / delete config. */
const CONFIG_WRITE_FLAGS = new Set([
  '--add',
  '--replace-all',
  '--unset',
  '--unset-all',
  '--rename-section',
  '--remove-section',
  '--edit',
  '-e'
])

/**
 * Reject a `git` token that is dangerous REGARDLESS of position: it takes a
 * value we'd mis-parse as the subcommand (`-C`, `-c`, `--git-dir=…`), writes a
 * file (`--output=…`), or forces git to run an EXTERNAL program — an external
 * diff/textconv driver (`--ext-diff`/`--textconv`) or `git grep`'s pager
 * (`-O`/`--open-files-in-pager`). (The pager flag `-p`/`--paginate` is handled
 * separately because it is position-sensitive: `git -p log` paginates, but
 * `git log -p` is the log subcommand's own `--patch` and is a read.)
 */
function isRejectedGitToken(token: string): boolean {
  if (token === '-C' || token === '-c') return true
  if (token === '--ext-diff' || token === '--textconv') return true
  if (token === '--open-files-in-pager') return true
  // `-O`, `-Oless`, `-O<orderfile>` — grep's open-in-pager exec vector.
  if (token.startsWith('-O')) return true
  return /^--(git-dir|work-tree|namespace|exec-path|output|open-files-in-pager|ext-diff|textconv)(=|$)/.test(
    token
  )
}

function isSafeRedirectTarget(target: string): boolean {
  const unquoted = target.replace(/^['"]|['"]$/g, '')
  return unquoted === '/dev/null' || unquoted === '/dev/stdout' || unquoted === '/dev/stderr'
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
  // File-descriptor duplication (2>&1, >&2, 1>&2) is side-effect free — drop it.
  cleaned = cleaned.replace(/\d*>&\d+/g, ' ').replace(/\d*<&\d+/g, ' ')

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

/** Validate a single `git …` segment's tokens (everything after `git`). */
function isReadOnlyGit(argsRaw: string[]): boolean {
  const args = argsRaw.filter((token) => token.length > 0)
  // Reject value-taking / file-writing / external-program flags anywhere in the
  // invocation (they can turn a read subcommand into a write or code exec).
  if (args.some(isRejectedGitToken)) return false
  const subIndex = args.findIndex((token) => !token.startsWith('-'))
  // `-p`/`--paginate` forces the pager (which can exec a repo-configured
  // core.pager) ONLY as a global flag — before the subcommand. After it, `-p`
  // is the subcommand's own flag (`git log -p` = patch, a read).
  const globalRegion = subIndex === -1 ? args : args.slice(0, subIndex)
  if (globalRegion.some((token) => token === '-p' || token === '--paginate')) return false
  // `git`, `git --version`, `git --help` (no subcommand) → read.
  if (subIndex === -1) return true
  const sub = args[subIndex]
  const rest = args.slice(subIndex + 1)

  if (GIT_ALWAYS_READ.has(sub)) return true

  switch (sub) {
    case 'remote': {
      // `git remote [-v]` or `git remote (show|get-url) [name]` are read.
      if (rest.length === 0) return true
      if (rest.every((token) => token === '-v' || token === '--verbose')) return true
      return rest[0] === 'show' || rest[0] === 'get-url'
    }
    case 'branch':
      // Listing only: every remaining token is a flag and none mutate. A bare
      // arg (potential new branch name) or a write flag → deny.
      return rest.every((token) => token.startsWith('-') && !BRANCH_WRITE_FLAGS.has(token))
    case 'tag':
      return rest.every((token) => token.startsWith('-') && !TAG_WRITE_FLAGS.has(token))
    case 'config': {
      // Read forms only. A read flag must be present, no write flag, and at most
      // ONE positional (the config name) — `git config <name> <value>` (a SET)
      // has two positionals and git treats a trailing decoy `--get` as a no-op,
      // so requiring a read flag is not enough (that was the `.some()` bug).
      if (rest.some((token) => CONFIG_WRITE_FLAGS.has(token))) return false
      if (!rest.some((token) => CONFIG_READ_FLAGS.has(token))) return false
      return rest.filter((token) => !token.startsWith('-')).length <= 1
    }
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show'
    default:
      return false
  }
}

/** Validate a single `find …` segment (tokens after `find`). */
function isReadOnlyFind(args: string[]): boolean {
  return !args.some((token) => FIND_MUTATION_FLAGS.has(token))
}

/** ripgrep can EXECUTE an arbitrary program per file via `--pre <cmd>` (and
 * `--hostname-bin`), turning any readable file into an executed script. Reject
 * those; every other rg flag only reads. */
function isReadOnlyRg(args: string[]): boolean {
  return !args.some((token) => token.startsWith('--pre') || token.startsWith('--hostname-bin'))
}

/** `uniq [INPUT [OUTPUT]]` — a SECOND positional is an output file it writes.
 * Allow zero or one positional (piped, or a single input file); reject two. */
function isReadOnlyUniq(args: string[]): boolean {
  return args.filter((token) => !token.startsWith('-')).length <= 1
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return false
  const command = tokens[0]
  const rest = tokens.slice(1)
  // No path/script execution, no `VAR=val cmd` prefix, no bare-flag "command".
  if (command.includes('/') || command.includes('=') || command.startsWith('-')) return false
  if (command === 'find') return isReadOnlyFind(rest)
  if (command === 'git') return isReadOnlyGit(rest)
  if (command === 'rg') return isReadOnlyRg(rest)
  if (command === 'uniq') return isReadOnlyUniq(rest)
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

  const { ok, cleaned } = sanitizeRedirects(trimmed)
  if (!ok) return false

  // Split on command sequencing / piping operators: && || ; | |& & and newlines.
  const segments = cleaned.split(/\s*(?:\|\||&&|;|\||&|\n)\s*/)
  const meaningful = segments.map((s) => s.trim()).filter((s) => s.length > 0)
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

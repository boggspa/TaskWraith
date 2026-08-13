/**
 * Fail-closed classifier for the read-only git shell commands every permission
 * posture may run without a prompt: pure `git status`, `git diff`, `git log`,
 * and narrowly screened `git rev-list` invocations.
 *
 * WHY: the MCP `git_status` / `git_diff` / `git_log` tools are auto-allowed in
 * every posture (MCP_AUTO_ALLOWED_TOOLS — fixed-argv, non-mutating). Agents
 * that reach for their NATIVE shell instead ran into the posture gate:
 * read_only / plan denied the command outright and `default` prompted, so
 * "where does the repo stand" cost a modal or a dead end depending on the
 * seat. This classifier gives the shell forms the same standing — and ONLY
 * those forms. git_show / git_blame deliberately stay gated on both lanes.
 *
 * SECURITY: this is a posture bypass, so a false positive here runs a shell
 * command under read-only with no prompt. Every rule fails closed:
 *  - whole-command charset gate first — any quoting, substitution, redirect,
 *    pipe, separator, glob, or control character rejects before tokenization
 *    (`;`, `&`, `|`, `<`, `>`, backticks, `$`, quotes, parens, `*`, `\n`, …);
 *  - the program must be literally `git` (no paths, no env-var prefixes);
 *  - git GLOBAL flags are limited to `--no-pager` / `--no-optional-locks`.
 *    Everything else before the subcommand rejects, which kills the known
 *    escalation vectors: `-c core.fsmonitor=<cmd>` (status executes it!),
 *    `-C <dir>` (repo of the agent's choosing), `--exec-path`, `--git-dir`,
 *    `--work-tree`, `-p`/`--paginate` (pager exec — POSITION-SENSITIVE:
 *    `git -p log` is the pager, `git log -p` is the patch read), `--output`;
 *  - the subcommand must be one of `status` / `diff` / `log` / `rev-list`,
 *    followed only by that subcommand's allow-listed read flags and metacharacter-free
 *    pathspecs/refs. NOT allow-listed (and therefore rejected) on diff/log:
 *    `--no-index` (diffs ARBITRARY files outside the repo — a read of any path
 *    on disk), `--output[=]` (writes a file), `--ext-diff` / `--textconv`
 *    (exec external drivers), `--show-signature` (execs gpg), `-O` (orderfile).
 * Residual (same class the Grok read-only classifier documents): a repo whose
 * .git/config already carries a hostile core.pager/ext-diff/fsmonitor runs it
 * on the user's own git invocations too — that is a compromised-workspace
 * problem, not a posture problem, and executors run without a TTY so pager
 * paths stay inert.
 *
 * Charset notes: `%` is needed for --pretty=format:%H (no shell meaning in
 * sh/bash/zsh), `~`/`^` for HEAD~3 / HEAD^ revisions (tilde only expands
 * word-INITIALLY, so tokens starting with `~` are rejected separately), `@`
 * for --author=user@host. Braces/parens stay rejected, so `@{u}`, pathspec
 * magic `:(...)`, and format field selectors simply fall back to the prompt.
 */

const MAX_COMMAND_LENGTH = 400

// Anything outside this charset (quotes, $, backticks, separators, redirects,
// globs, braces, parens, control chars, backslashes…) fails closed before
// parsing.
const SAFE_CHARSET = /^[A-Za-z0-9 ._/=:,+@%~^-]+$/

const GIT_GLOBAL_SAFE_FLAGS = new Set(['--no-pager', '--no-optional-locks'])

interface GitReadSubcommandSpec {
  exact: ReadonlySet<string>
  prefixes: readonly string[]
  /** Strict short-flag shapes (`-sb` for status, `-10`/`-n10` for log). */
  combinedShort?: RegExp
}

// Display/read flags shared by the diff family (git diff + git log's patch
// output). Everything here formats or filters output; nothing execs, writes,
// or retargets the repo.
const DIFF_FAMILY_EXACT = [
  '-p',
  '--patch',
  '-s',
  '--no-patch',
  '--stat',
  '--numstat',
  '--shortstat',
  '--compact-summary',
  '--name-only',
  '--name-status',
  '--raw',
  '--patch-with-stat',
  '--word-diff',
  '--color',
  '--no-color',
  '--find-renames',
  '--no-renames',
  '--find-copies',
  '-M',
  '-w',
  '-b',
  '--ignore-all-space',
  '--ignore-space-change',
  '--full-index',
  '--binary',
  '--no-ext-diff',
  '--no-textconv',
  '-z',
  '--abbrev'
]

const DIFF_FAMILY_PREFIXES = [
  '-U',
  '--unified=',
  '--word-diff=',
  '--color=',
  '--color-moved',
  '--find-renames=',
  '--find-copies=',
  '--diff-filter=',
  '--abbrev=',
  '--stat='
]

const GIT_READ_SUBCOMMANDS: Record<string, GitReadSubcommandSpec> = {
  status: {
    exact: new Set([
      '--short',
      '--branch',
      '--long',
      '--porcelain',
      '--null',
      '-u',
      '-uno',
      '-unormal',
      '-uall',
      '--untracked-files',
      '--ignored',
      '--no-renames',
      '--renames',
      '--find-renames',
      '--ahead-behind',
      '--no-ahead-behind',
      '--show-stash',
      '--column',
      '--no-column',
      '--verbose'
    ]),
    prefixes: ['--porcelain=', '--untracked-files=', '--ignored=', '--column=', '--find-renames='],
    combinedShort: /^-[sbvz]{1,4}$/
  },
  diff: {
    exact: new Set([
      ...DIFF_FAMILY_EXACT,
      '--cached',
      '--staged',
      '--merge-base',
      // Reports whitespace errors through stdout + exit status; it does not
      // modify the index or working tree.
      '--check'
    ]),
    prefixes: [...DIFF_FAMILY_PREFIXES]
  },
  log: {
    exact: new Set([
      ...DIFF_FAMILY_EXACT,
      '--oneline',
      '--graph',
      '--decorate',
      '--no-decorate',
      '--abbrev-commit',
      '--no-abbrev-commit',
      '--all',
      '--branches',
      '--tags',
      '--remotes',
      '--first-parent',
      '--no-merges',
      '--merges',
      '--reverse',
      '--follow',
      '--relative-date',
      '--topo-order',
      '--date-order',
      '--author-date-order',
      '--left-right',
      '--boundary',
      '--full-history',
      '--simplify-by-decoration',
      '--source',
      '--pretty',
      '-n',
      '--grep',
      '--author',
      '--committer',
      '--since',
      '--until',
      '--before',
      '--after'
    ]),
    prefixes: [
      ...DIFF_FAMILY_PREFIXES,
      '--max-count=',
      '--skip=',
      '--since=',
      '--until=',
      '--after=',
      '--before=',
      '--author=',
      '--committer=',
      '--grep=',
      '--format=',
      '--pretty=',
      '--date=',
      '--decorate=',
      '--branches=',
      '--tags=',
      '--remotes=',
      '-S',
      '-G'
    ],
    // -10 / -n10 count shorthands; the separate-value form uses exact '-n'.
    combinedShort: /^-n?\d{1,6}$/
  },
  // `rev-list` has a very large option surface, including `--alternate-refs`,
  // which can execute a command configured by the repository. Keep this to
  // the exact count form agents use to compare local and upstream history.
  'rev-list': {
    exact: new Set(['--count']),
    prefixes: []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Is this exact shell string a pure, read-only git status/diff/log invocation? */
export function isReadOnlyGitShellCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return false
  if (!SAFE_CHARSET.test(trimmed)) return false

  const tokens = trimmed.split(/\s+/)
  // Word-initial `~` is the one in-charset character the shell still expands.
  if (tokens.some((token) => token.startsWith('~'))) return false
  if (tokens[0] !== 'git') return false

  let index = 1
  while (index < tokens.length && tokens[index].startsWith('-')) {
    if (!GIT_GLOBAL_SAFE_FLAGS.has(tokens[index])) return false
    index += 1
  }
  const subcommand = tokens[index] ?? ''
  const spec = Object.prototype.hasOwnProperty.call(GIT_READ_SUBCOMMANDS, subcommand)
    ? GIT_READ_SUBCOMMANDS[subcommand]
    : undefined
  if (!spec) return false
  index += 1

  for (; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') continue
    if (!token.startsWith('-')) continue // metacharacter-free pathspec / ref
    if (spec.exact.has(token)) continue
    if (spec.combinedShort?.test(token)) continue
    if (spec.prefixes.some((prefix) => token.startsWith(prefix))) continue
    return false
  }
  return true
}

/**
 * Normalize a raw tool-call `command` value (string, argv array, or a
 * `sh|bash|zsh -c <script>` wrapper) into the shell string to classify.
 * Anything else — objects, mixed arrays — returns null (fail closed).
 */
export function shellCommandFromRawCommand(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    if (
      value.length === 3 &&
      /^(?:\/usr\/bin\/|\/bin\/)?(?:ba|z|da)?sh$/.test(value[0]) &&
      /^-(?:l?c|cl)$/.test(value[1])
    ) {
      return value[2]
    }
    return value.join(' ')
  }
  return null
}

/**
 * Extract the shell command from an approval-request preview. Prefers the raw
 * tool input (`preview.params.command` — what actually executes) over the
 * display string (`preview.command`, which some builders derive from
 * descriptions or argv joins).
 */
export function shellCommandFromApprovalPreview(preview: unknown): string | null {
  if (!isRecord(preview)) return null
  if (isRecord(preview.params)) {
    const raw = shellCommandFromRawCommand(preview.params.command)
    if (raw !== null) return raw
  }
  return typeof preview.command === 'string' ? preview.command : null
}

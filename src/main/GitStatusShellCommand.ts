/**
 * Fail-closed classifier for the one shell command every permission posture may
 * run without a prompt: a pure `git status` invocation.
 *
 * WHY: the MCP `git_status` tool is already auto-allowed in every posture
 * (MCP_AUTO_ALLOWED_TOOLS — fixed-argv, non-mutating). Agents that reach for
 * their NATIVE shell instead ran into the posture gate: read_only / plan denied
 * the command outright and `default` prompted for it, so "check where the repo
 * stands" cost a modal or a dead end depending on the seat. This classifier
 * gives the shell form the same standing as the MCP tool — and ONLY that form.
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
 *    `--work-tree`, `-p`/`--paginate` (pager exec), `--output=<file>`;
 *  - the subcommand must be literally `status`, followed only by allow-listed
 *    read flags and metacharacter-free pathspecs.
 * Residual (same class the Grok read-only classifier documents): a repo whose
 * .git/config already carries a hostile core.fsmonitor/core.pager runs it on
 * ANY git status, including the user's own — that is a compromised-workspace
 * problem, not a posture problem, and executors run without a TTY so pager
 * paths stay inert.
 */

const MAX_COMMAND_LENGTH = 400

// Anything outside this charset (quotes, $, backticks, separators, redirects,
// globs, parens, control chars, backslashes…) fails closed before parsing.
const SAFE_CHARSET = /^[A-Za-z0-9 ._/=:,+-]+$/

const GIT_GLOBAL_SAFE_FLAGS = new Set(['--no-pager', '--no-optional-locks'])

// Combined short read flags (`-sb` etc.) — status/short/branch/verbose/z only.
const STATUS_COMBINED_SHORT = /^-[sbvz]{1,4}$/

const STATUS_EXACT_FLAGS = new Set([
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
])

const STATUS_PREFIX_FLAGS = [
  '--porcelain=',
  '--untracked-files=',
  '--ignored=',
  '--column=',
  '--find-renames='
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Is this exact shell string a pure, read-only `git status` invocation? */
export function isReadOnlyGitStatusCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return false
  if (!SAFE_CHARSET.test(trimmed)) return false

  const tokens = trimmed.split(/\s+/)
  if (tokens[0] !== 'git') return false

  let index = 1
  while (index < tokens.length && tokens[index].startsWith('-')) {
    if (!GIT_GLOBAL_SAFE_FLAGS.has(tokens[index])) return false
    index += 1
  }
  if (tokens[index] !== 'status') return false
  index += 1

  for (; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') continue
    if (!token.startsWith('-')) continue // metacharacter-free pathspec
    if (STATUS_EXACT_FLAGS.has(token)) continue
    if (STATUS_COMBINED_SHORT.test(token)) continue
    if (STATUS_PREFIX_FLAGS.some((prefix) => token.startsWith(prefix))) continue
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

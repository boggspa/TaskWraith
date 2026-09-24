/**
 * Destructive-shell ASK escalation (hold polarity).
 *
 * The structural inverse of `PromptFreeReadOnlyShell`: that module proves a
 * command is safe enough to skip the prompt, this one proves a command is
 * destructive enough that it MUST take the prompt. It never denies. A match
 * forces the Permission Request card at every tier, including the three write
 * tiers where `shellCommandTierHold` currently stops looking; the user (or, on
 * an unattended lane, the approval timeout) makes the call.
 *
 * POLARITY, and why it is tuned the way it is. This RESTRICTS, so it follows
 * the IsolateSharedBranchHold discipline: no charset gate, match what parses,
 * never hold what it cannot see. A MISS is cheap — the command then runs under
 * the normal posture, exactly as it does today. A FALSE POSITIVE is expensive:
 * approval auto-deny timers are 120s (Kimi/Mistral) or 240s (others) and the
 * first responder wins, so a needless escalation on an unattended Ensemble lane
 * burns the whole timer and then denies with nobody present. Every rule below
 * is therefore written to recognise the catastrophic shape and to stay silent
 * on the routine one.
 *
 * FLOOR, not ceiling: `isHostDestructiveShellCommand` still DENIES the narrow
 * host-wipe set (`rm -rf /`, `mkfs`, `dd of=/dev/…`, power-off) ahead of this
 * classifier at the gate, and it denies even under Full Access. Anything it
 * claims never reaches an ask. This module owns the much larger set that should
 * be askable but never silently allowed.
 *
 * Parsing is deliberately NOT re-implemented: `chainSegmentsOf`, `tokenize` and
 * `unwrap` are the deny-wall's own argv-aware parser, so the two classifiers
 * cannot drift on what a segment, a shell word, or a `sudo`/`env`/`nohup`
 * wrapper is.
 *
 * This module classifies strings only. It never spawns a process.
 *
 * RESIDUE (accepted, same class as every shell classifier here): command
 * substitution bodies are not re-classified — `echo $(git stash)` reads as
 * `echo`. The deny-wall does scan substitutions for its own narrower set, and
 * the executors' path containment and the audit trail remain the backstop.
 */

import * as path from 'path'
import { shellCommandFromRawCommand } from '../ReadOnlyGitShellCommand'
import { pathProvablyInsideWorkspace } from '../ShellCommandTierPolicy'
import {
  STRIPPABLE_BIN_PREFIX,
  chainSegmentsOf,
  tokenize,
  unwrap
} from './HostDestructiveShellDeny'

export type DestructiveShellRuleId =
  | 'rm_recursive'
  | 'find_delete'
  | 'shred'
  | 'truncate_zero'
  | 'dd_device'
  | 'mkfs'
  | 'diskutil_erase'
  | 'git_reset_hard'
  | 'git_checkout_discard'
  | 'git_restore_discard'
  | 'git_clean_force'
  | 'git_push_force'
  | 'git_branch_force_delete'
  | 'git_tag_delete'
  | 'git_filter_branch'
  | 'git_stash'
  | 'sudo'
  | 'su'
  | 'chmod_recursive'
  | 'chown_recursive'
  | 'launchctl'
  | 'systemctl'
  | 'killall'
  | 'pipe_to_shell'

export interface DestructiveShellAskEscalation {
  /** Stable id for the audit payload and for per-rule telemetry. */
  ruleId: DestructiveShellRuleId
  /** One sentence for the approval card, naming what is lost. */
  reason: string
  /** The chain segment that matched, for the card's detail line. */
  segment: string
}

const SHELL_HEADS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const FETCH_HEADS: ReadonlySet<string> = new Set(['curl', 'wget'])

/** `git` global flags whose value arrives as the NEXT token (skip both). */
const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace'
])

/** `find -exec` heads that delete rather than merely read. */
const FIND_DESTRUCTIVE_EXEC_HEADS: ReadonlySet<string> = new Set([
  'rm',
  'shred',
  'truncate',
  'unlink'
])

/** `launchctl` subcommands that only report state. */
const LAUNCHCTL_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'list',
  'print',
  'print-disabled',
  'dumpstate',
  'blame',
  'procinfo',
  'examine',
  'help',
  'version'
])

/** `systemctl` subcommands that only report state. */
const SYSTEMCTL_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'show',
  'cat',
  'list-units',
  'list-unit-files',
  'list-timers',
  'list-sockets',
  'list-dependencies',
  'is-active',
  'is-enabled',
  'is-failed',
  'is-system-running',
  'show-environment',
  'help'
])

/** `git stash` subcommands that read or RESTORE rather than destroy. */
const GIT_STASH_NON_DESTRUCTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'list',
  'show',
  'apply',
  'pop',
  'branch',
  'create',
  'store'
])

const GLOB_CHARACTER = /[*?[\]{}]/

/**
 * The classifier. Returns the FIRST matching segment's escalation, or null when
 * nothing in the command is provably destructive.
 */
export function destructiveShellAskEscalation(
  rawCommand: unknown,
  workspacePath?: string | null
): DestructiveShellAskEscalation | null {
  const command = shellCommandFromRawCommand(rawCommand)
  if (command === null) return null
  const trimmed = command.trim()
  if (!trimmed) return null
  const workspaceRoot = workspacePath ? path.resolve(workspacePath) : null
  // `rm`'s containment proof rests on "relative means inside the tree", which a
  // `cd` earlier in the chain can invalidate — `cd .. && rm -rf old-checkout`
  // deletes a sibling repo. Once the cwd stops being provable, every later
  // relative target is unprovable too.
  let cwdProven = true
  for (const segment of segmentsOf(trimmed)) {
    const escalation = segmentEscalation(segment, false, cwdProven, workspaceRoot)
    if (escalation) return escalation
    if (cwdProven && segmentLeavesProvableCwd(segment, workspaceRoot)) cwdProven = false
  }
  return pipeToShellEscalation(trimmed)
}

export function isDestructiveShellAskEscalation(
  rawCommand: unknown,
  workspacePath?: string | null
): boolean {
  return destructiveShellAskEscalation(rawCommand, workspacePath) !== null
}

/**
 * Every `&&`, `||`, `;`, `|` and newline segment — one destructive segment
 * anywhere escalates the whole command. The deny-wall's splitter rejects a
 * trailing separator (`git reset --hard;`) because its final segment is empty,
 * so retry once without it. When it still cannot account for the line
 * (unbalanced quote, a backgrounding `&` mid-line), fall back to reading the
 * whole command as a single segment: recognition can only add matches that
 * literally name a destructive head, never remove one.
 */
function segmentsOf(command: string): string[] {
  const segments = chainSegmentsOf(command)
  if (segments) return segments
  const withoutTrailingOperator = command.replace(/[;&|\s]+$/, '')
  if (withoutTrailingOperator === command || !withoutTrailingOperator) return [command]
  return chainSegmentsOf(withoutTrailingOperator) ?? [command]
}

/** Drop a subshell/group wrapper so `(cd x && rm -rf ~)` still tokenizes. */
function stripGroupWrapper(segment: string): string {
  return segment
    .trim()
    .replace(/^[({]\s*/, '')
    .replace(/\s*[)}]$/, '')
}

/**
 * One segment's argv, with the deny-wall's own `sudo`/`doas`/`env`/`nohup`
 * unwrapping. `unwrap` skips `VAR=value` words only after an explicit `env`;
 * the bare assignment PREFIX (`GIT_DIR=x git reset --hard`) reaches the same
 * argv, so it is stripped first.
 */
function argvOf(segment: string, hadSudo: boolean): { argv: string[]; sudo: boolean } | null {
  const tokens = tokenize(stripGroupWrapper(segment))
  if (!tokens) return null
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1
  if (index >= tokens.length) return null
  return unwrap(tokens.slice(index), hadSudo)
}

function escalate(
  ruleId: DestructiveShellRuleId,
  reason: string,
  segment: string
): DestructiveShellAskEscalation {
  return { ruleId, reason, segment: segment.trim() }
}

/** `cd`, `pushd` or `popd` to anywhere the parser cannot place relative to here. */
function segmentLeavesProvableCwd(segment: string, workspaceRoot: string | null): boolean {
  const unwrapped = argvOf(segment, false)
  if (!unwrapped || unwrapped.argv.length === 0) return false
  const head = unwrapped.argv[0].replace(STRIPPABLE_BIN_PREFIX, '')
  if (head === 'popd') return true
  if (head !== 'cd' && head !== 'pushd') return false
  const target = unwrapped.argv.slice(1).find((token) => !token.startsWith('-'))
  // Bare `cd` goes home; `cd -` goes back to wherever the shell was before.
  return target === undefined || !isContainedDeletionTarget(target, workspaceRoot)
}

function segmentEscalation(
  segment: string,
  hadSudo: boolean,
  cwdProven: boolean,
  workspaceRoot: string | null
): DestructiveShellAskEscalation | null {
  const unwrapped = argvOf(segment, hadSudo)
  if (!unwrapped) return null
  const { argv, sudo } = unwrapped
  const sudoEscalation = sudo
    ? escalate('sudo', 'sudo runs this as root, outside everything the run contains.', segment)
    : null
  if (argv.length === 0) return sudoEscalation
  const head = argv[0].replace(STRIPPABLE_BIN_PREFIX, '')
  const args = argv.slice(1)
  const specific = headEscalation(head, args, segment, cwdProven, workspaceRoot)
  // The specific rule names what is lost, so prefer it; a `sudo` wrapper on an
  // otherwise-ordinary command still escalates on its own.
  return specific ?? sudoEscalation
}

function headEscalation(
  head: string,
  args: readonly string[],
  segment: string,
  cwdProven: boolean,
  workspaceRoot: string | null
): DestructiveShellAskEscalation | null {
  switch (head) {
    case 'rm':
      return rmEscalation(args, segment, cwdProven, workspaceRoot)
    case 'find':
      return findEscalation(args, segment)
    case 'shred':
      return escalate('shred', 'shred overwrites the file so nothing can recover it.', segment)
    case 'truncate':
      return truncateEscalation(args, segment)
    case 'dd':
      return ddEscalation(args, segment)
    case 'diskutil':
      return diskutilEscalation(args, segment)
    case 'su':
      return escalate(
        'su',
        'su switches to another account, outside the identity this run was given.',
        segment
      )
    case 'chmod':
      return recursiveFlagEscalation(
        'chmod_recursive',
        'chmod -R rewrites permissions across a whole tree.',
        args,
        segment
      )
    case 'chown':
      return recursiveFlagEscalation(
        'chown_recursive',
        'chown -R reassigns ownership across a whole tree.',
        args,
        segment
      )
    case 'launchctl':
      return serviceManagerEscalation(
        'launchctl',
        LAUNCHCTL_READ_SUBCOMMANDS,
        'launchctl loads, unloads or restarts system services.',
        args,
        segment
      )
    case 'systemctl':
      return serviceManagerEscalation(
        'systemctl',
        SYSTEMCTL_READ_SUBCOMMANDS,
        'systemctl starts, stops or disables system services.',
        args,
        segment
      )
    case 'killall':
      return escalate(
        'killall',
        'killall kills every matching process, including ones this run did not start.',
        segment
      )
    case 'git':
      return gitEscalation(args, segment)
    default:
      break
  }
  if (head.startsWith('mkfs')) {
    return escalate('mkfs', 'mkfs formats a filesystem, erasing what is on it.', segment)
  }
  if (SHELL_HEADS.has(head)) return shellScriptEscalation(args)
  return null
}

/** `bash -c '<script>'` — classify the inner script, not the wrapper. */
function shellScriptEscalation(args: readonly string[]): DestructiveShellAskEscalation | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-c' || token === '--command' || token.startsWith('--command=')) {
      const script = token.startsWith('--command=')
        ? token.slice('--command='.length)
        : args[index + 1]
      return script ? destructiveShellAskEscalation(script) : null
    }
  }
  return null
}

/**
 * TARGET-AWARE. `rm -rf node_modules` / `dist` / `build` is what a coding agent
 * does all day; `rm -rf /`, `~`, `..`, `$HOME` and bare `*` are not. This is the
 * no-workspace-root mirror of ShellCommandTierPolicy's
 * `pathProvablyInsideWorkspace`: a RELATIVE path with no `..` segment is inside
 * the tree by construction for any cwd the run can have, so it stays silent.
 * Everything the parser cannot prove — absolute, `~`, `$VAR`, a `..` segment, a
 * glob in the FIRST path segment, `.` itself, or no target at all — takes the
 * prompt.
 */
function rmEscalation(
  args: readonly string[],
  segment: string,
  cwdProven: boolean,
  workspaceRoot: string | null
): DestructiveShellAskEscalation | null {
  let recursive = false
  let seenDashDash = false
  const targets: string[] = []
  for (const token of args) {
    if (!seenDashDash && token === '--') {
      seenDashDash = true
      continue
    }
    if (!seenDashDash && token.startsWith('-')) {
      if (token === '--recursive') recursive = true
      else if (/^-[A-Za-z]+$/.test(token) && /[rR]/.test(token)) recursive = true
      continue
    }
    targets.push(token)
  }
  if (!recursive) return null
  if (targets.length === 0) {
    return escalate('rm_recursive', 'Recursive delete with no readable target path.', segment)
  }
  const unproven = targets.find(
    (target) => !cwdProven || !isContainedDeletionTarget(target, workspaceRoot)
  )
  if (unproven === undefined) return null
  return escalate(
    'rm_recursive',
    `Recursive delete of ${unproven}, which is not a plain path inside the project.`,
    segment
  )
}

function isContainedDeletionTarget(target: string, workspaceRoot: string | null): boolean {
  const normalized = target.replace(/^(?:\.\/)+/, '')
  if (!normalized || normalized === '.' || normalized === '..') return false
  // Expansion and globs hide the real operand from a static read, whatever the
  // root is. A glob BELOW a literal first segment (`dist/*`) stays confined to
  // it, so only the first segment is screened.
  if (normalized.includes('$') || normalized.includes('`')) return false
  if (GLOB_CHARACTER.test(normalized.split('/')[0])) return false
  // With a workspace root in hand this is exactly the repo's existing
  // containment proof, so the hold and Full Access's "always approve in
  // workspace" carve-out agree on what inside means — including the absolute
  // in-workspace form (`rm -rf /repo/node_modules`) that agents do emit.
  if (workspaceRoot) {
    // The root itself is not "inside": deleting the whole checkout is the one
    // in-workspace delete worth a prompt, and it costs nothing — no routine
    // command names it.
    if (path.isAbsolute(normalized) && path.resolve(normalized) === workspaceRoot) return false
    return pathProvablyInsideWorkspace(normalized, workspaceRoot)
  }
  if (normalized.startsWith('/') || normalized.startsWith('~')) return false
  return !normalized.split('/').some((part) => part === '..')
}

/**
 * NOT target-aware: the path operand says where `find` starts walking, not what
 * the predicate matches, so containment cannot be proven from it. Narrower than
 * `isCatastrophicDeletionShellCommand` on purpose — that one holds on ANY
 * `-exec`, which needlessly escalates `find . -name '*.ts' -exec grep -l x {} +`.
 */
function findEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-delete') {
      return escalate('find_delete', 'find -delete removes every file it matches.', segment)
    }
    if (token !== '-exec' && token !== '-execdir' && token !== '-ok' && token !== '-okdir') {
      continue
    }
    const exec = unwrap(args.slice(index + 1), false)
    if (!exec) continue
    const execHead = (exec.argv[0] ?? '').replace(STRIPPABLE_BIN_PREFIX, '')
    if (!exec.sudo && !FIND_DESTRUCTIVE_EXEC_HEADS.has(execHead)) continue
    return escalate(
      'find_delete',
      `find ${token} runs ${exec.sudo ? 'sudo' : execHead} on every file it matches.`,
      segment
    )
  }
  return null
}

/**
 * NOT target-aware. `truncate -s 0` is near-zero frequency for a coding agent,
 * so the false-positive cost of always asking is near zero, while silent
 * in-place emptying is exactly the data loss this list exists to surface.
 */
function truncateEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    let size: string | undefined
    if (token === '-s' || token === '--size') size = args[index + 1]
    else if (token.startsWith('--size=')) size = token.slice('--size='.length)
    else if (/^-s.+/.test(token)) size = token.slice(2)
    if (size === undefined || !/^0+$/.test(size)) continue
    return escalate('truncate_zero', 'truncate -s 0 empties the file in place.', segment)
  }
  return null
}

function ddEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  const target = args.find((token) => /^of=\/dev\//.test(token))
  if (target === undefined) return null
  return escalate('dd_device', `dd ${target} writes straight over a device.`, segment)
}

function diskutilEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  if (!args[0]?.startsWith('erase')) return null
  return escalate('diskutil_erase', `diskutil ${args[0]} erases a disk or volume.`, segment)
}

function recursiveFlagEscalation(
  ruleId: DestructiveShellRuleId,
  reason: string,
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  const recursive = args.some(
    (token) => token === '--recursive' || (/^-[A-Za-z]+$/.test(token) && /[rR]/.test(token))
  )
  return recursive ? escalate(ruleId, reason, segment) : null
}

function serviceManagerEscalation(
  ruleId: DestructiveShellRuleId,
  readSubcommands: ReadonlySet<string>,
  reason: string,
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  const subcommand = args.find((token) => !token.startsWith('-')) ?? ''
  if (readSubcommands.has(subcommand)) return null
  return escalate(ruleId, reason, segment)
}

function gitEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  let index = 0
  while (index < args.length && args[index].startsWith('-')) {
    index += GIT_GLOBAL_VALUE_FLAGS.has(args[index]) ? 2 : 1
  }
  const rest = args.slice(index + 1)
  switch (args[index] ?? '') {
    case 'reset':
      return gitResetEscalation(rest, segment)
    case 'checkout':
      return gitCheckoutEscalation(rest, segment)
    case 'restore':
      return gitRestoreEscalation(rest, segment)
    case 'clean':
      return gitCleanEscalation(rest, segment)
    case 'push':
      return gitPushEscalation(rest, segment)
    case 'branch':
      return gitBranchEscalation(rest, segment)
    case 'tag':
      return gitTagEscalation(rest, segment)
    case 'filter-branch':
      return escalate(
        'git_filter_branch',
        'git filter-branch rewrites every commit in the repository.',
        segment
      )
    case 'stash':
      return gitStashEscalation(rest, segment)
    default:
      return null
  }
}

/** Past `--`, a token is a pathspec — a literal `--hard` there is a path. */
function hasFlagBeforeDoubleDash(args: readonly string[], flag: string): boolean {
  for (const token of args) {
    if (token === '--') return false
    if (token === flag) return true
  }
  return false
}

/** `.`, `./`, `*`, `:/`, an absolute path, `~`, or anything reaching through `..`. */
function isWholeTreePathspec(token: string): boolean {
  if (token.startsWith('/') || token.startsWith('~')) return true
  if (token === ':/' || token.startsWith(':/')) return true
  if (token.split('/').some((part) => part === '..')) return true
  const normalized = token.replace(/^(?:\.\/)+/, '')
  return normalized === '' || normalized === '.' || normalized === '*'
}

/** `--soft` / `--mixed` / bare `git reset` only move the index. */
function gitResetEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  if (!hasFlagBeforeDoubleDash(args, '--hard')) return null
  return escalate(
    'git_reset_hard',
    'git reset --hard discards every uncommitted change in the worktree.',
    segment
  )
}

/**
 * TARGET-AWARE. `git checkout -- src/App.tsx` reverts one file an agent just
 * touched; `git checkout -- .` throws away the whole worktree. Only the
 * whole-tree form and an explicit `--force` escalate. A branch is never named
 * `.` or `*`, so a positional without `--` is safe to screen the same way.
 */
function gitCheckoutEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  let afterDoubleDash = false
  const beforeDoubleDash: string[] = []
  const pathspecs: string[] = []
  for (const token of args) {
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && token.startsWith('-')) {
      if (token === '-f' || token === '--force') {
        return escalate(
          'git_checkout_discard',
          'git checkout --force overwrites uncommitted changes in the worktree.',
          segment
        )
      }
      continue
    }
    if (afterDoubleDash) pathspecs.push(token)
    else beforeDoubleDash.push(token)
  }
  const candidates = afterDoubleDash ? pathspecs : beforeDoubleDash
  const target = candidates.find(isWholeTreePathspec)
  if (target === undefined) return null
  return escalate(
    'git_checkout_discard',
    `git checkout ${target} throws away every uncommitted change under that path.`,
    segment
  )
}

/**
 * TARGET-AWARE, and staged-aware. `git restore --staged <path>` only unstages —
 * the worktree copy survives, so it never escalates. Discarding the worktree
 * across the whole tree does.
 */
function gitRestoreEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  let afterDoubleDash = false
  let staged = false
  let worktree = false
  const pathspecs: string[] = []
  for (const token of args) {
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && token.startsWith('-')) {
      if (token === '-S' || token === '--staged') staged = true
      else if (token === '-W' || token === '--worktree') worktree = true
      continue
    }
    pathspecs.push(token)
  }
  if (staged && !worktree) return null
  const target = pathspecs.find(isWholeTreePathspec) ?? pathspecs[0]
  if (target === undefined) return null
  return escalate(
    'git_restore_discard',
    `git restore ${target} overwrites every uncommitted change under that path.`,
    segment
  )
}

/**
 * NOT target-aware. `git clean -f` deletes UNTRACKED files, which by definition
 * no commit can bring back — the one delete in this set with no recovery path.
 * `-n` / `--dry-run` only lists, and clean without force does nothing.
 */
function gitCleanEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  let force = false
  let dryRun = false
  for (const token of args) {
    if (token === '--') break
    if (!token.startsWith('-')) continue
    if (token === '--force') force = true
    else if (token === '--dry-run') dryRun = true
    else if (/^-[A-Za-z]+$/.test(token)) {
      if (token.includes('f')) force = true
      if (token.includes('n')) dryRun = true
    }
  }
  if (!force || dryRun) return null
  return escalate(
    'git_clean_force',
    'git clean -f deletes untracked files that no commit can restore.',
    segment
  )
}

function gitPushEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  for (const token of args) {
    if (token === '--') break
    const forced =
      token === '--force' ||
      token === '--force-with-lease' ||
      token.startsWith('--force-with-lease=') ||
      (/^-[A-Za-z]+$/.test(token) && token.includes('f'))
    if (!forced) continue
    return escalate(
      'git_push_force',
      `git push ${token} rewrites history other people have already pulled.`,
      segment
    )
  }
  return null
}

/** `-d` refuses to drop unmerged work; `-D` (or `-d --force`) does not. */
function gitBranchEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  let deleting = false
  let forced = false
  for (const token of args) {
    if (token === '--') break
    if (token === '--delete') deleting = true
    else if (token === '--force') forced = true
    else if (/^-[A-Za-z]+$/.test(token)) {
      if (token.includes('D')) return gitBranchForceDelete(segment)
      if (token.includes('d')) deleting = true
      if (token.includes('f')) forced = true
    }
  }
  return deleting && forced ? gitBranchForceDelete(segment) : null
}

function gitBranchForceDelete(segment: string): DestructiveShellAskEscalation {
  return escalate(
    'git_branch_force_delete',
    'git branch -D deletes a branch even when its commits are unmerged.',
    segment
  )
}

function gitTagEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  for (const token of args) {
    if (token === '--') break
    if (token === '--delete' || (/^-[A-Za-z]+$/.test(token) && token.includes('d'))) {
      return escalate('git_tag_delete', 'git tag -d removes a release tag.', segment)
    }
  }
  return null
}

/**
 * Bare `git stash` (and `push`/`save`) silently empties the worktree — the
 * classic "where did my changes go". `drop` / `clear` destroy stashed work
 * outright. `list` / `show` read, and `apply` / `pop` RESTORE, so they stay
 * silent.
 */
function gitStashEscalation(
  args: readonly string[],
  segment: string
): DestructiveShellAskEscalation | null {
  const subcommand = args.find((token) => !token.startsWith('-')) ?? ''
  if (subcommand === 'drop' || subcommand === 'clear') {
    return escalate('git_stash', `git stash ${subcommand} destroys stashed work for good.`, segment)
  }
  if (GIT_STASH_NON_DESTRUCTIVE_SUBCOMMANDS.has(subcommand)) return null
  if (subcommand !== '' && subcommand !== 'push' && subcommand !== 'save') return null
  return escalate(
    'git_stash',
    'git stash takes every uncommitted change out of the worktree.',
    segment
  )
}

/**
 * `curl … | sh` / `wget … | bash`. Operator kinds are not preserved by the
 * segment splitter, so the proof is shape-based instead: a shell head with no
 * script operand and no `-c` can only be executing its STDIN, and that only
 * matters once a fetch has appeared in the same command. `curl -sL url -o
 * file.tgz` has no such segment and stays silent; `curl url && bash setup.sh`
 * names a file and stays silent too.
 */
function pipeToShellEscalation(command: string): DestructiveShellAskEscalation | null {
  let sawFetch = false
  for (const segment of segmentsOf(command)) {
    const unwrapped = argvOf(segment, false)
    if (!unwrapped || unwrapped.argv.length === 0) continue
    const head = unwrapped.argv[0].replace(STRIPPABLE_BIN_PREFIX, '')
    if (FETCH_HEADS.has(head)) {
      sawFetch = true
      continue
    }
    if (!sawFetch || !SHELL_HEADS.has(head)) continue
    if (!readsScriptFromStdin(unwrapped.argv.slice(1))) continue
    return escalate(
      'pipe_to_shell',
      `${head} executes the downloaded bytes without anyone reading them first.`,
      segment
    )
  }
  return null
}

function readsScriptFromStdin(args: readonly string[]): boolean {
  for (const token of args) {
    if (token === '-' || token === '-s') continue
    if (!token.startsWith('-')) return false
    if (token === '-c' || token === '--command' || token.startsWith('--command=')) return false
  }
  return true
}

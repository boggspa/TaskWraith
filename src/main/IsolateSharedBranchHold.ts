/**
 * Ask-hold for git branch/worktree MUTATION shell commands from Ensemble
 * seats whose chat Isolate policy pins the shared checkout ('off' — the
 * composer's "Shared" setting, and the default when unset).
 *
 * RULING (perms-tier session, 2026-08-04, following bc81364e5): this is an
 * ASK-HOLD folded into `neverAutoAllow` at both approval gates — NOT a hard
 * deny. Attended runs keep a user-blessed escape hatch (the prompt);
 * unattended/background lanes fail safe because approval timeouts
 * auto-deny. EffectiveRunPermissions is deliberately NOT involved: the
 * Isolate policy is chat-scoped mutable authority orthogonal to the
 * HMAC-signed run posture — a Full Access seat under pinned Shared must
 * still hold.
 *
 * POLARITY — the exact inverse of ReadOnlyGitShellCommand, so the parsing
 * choices differ on purpose:
 *  - isReadOnlyGitShellCommand AUTO-ALLOWS, so it fails CLOSED: anything it
 *    cannot fully parse falls back to the normal (prompting) policy path.
 *  - This classifier RESTRICTS (forces a prompt), so unparseable input must
 *    return false — holding every unrecognized command would break normal
 *    workflows. It therefore recognizes intent generously (no SAFE_CHARSET
 *    gate, value-taking git global flags are skipped so `git -C ../x
 *    worktree add` still matches, unknown extra flags on a recognized
 *    creation form still hold) but never claims a command it cannot see is
 *    a mutation.
 *  - Residue (accepted by the ruling): compound/wrapped commands
 *    (`cd x && git worktree add …`) evade recognition — that class is the
 *    open #54 surface. The Ensemble prompt shell still forbids the action
 *    under pinned Shared, and receipts/audits record what ran.
 */

import type { AgenticServiceId, ChatRecord } from './store/types'
import { resolveEnsembleFanoutIsolationPolicy } from './store/types'
import { shellCommandFromRawCommand } from './ReadOnlyGitShellCommand'

const MAX_COMMAND_LENGTH = 800

/** git global flags whose value arrives as the NEXT token (skip both). */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace'
])

const WORKTREE_MUTATION_SUBCOMMANDS = new Set(['add', 'move', 'remove'])

const CHECKOUT_CREATION_FLAGS = new Set(['-b', '-B', '--orphan'])
const SWITCH_CREATION_FLAGS = new Set(['-c', '-C', '--create', '--force-create', '--orphan'])

/** Explicit ref-mutation flags: any one of these makes `git branch` a hold. */
const BRANCH_MUTATION_FLAGS = new Set([
  '-c',
  '-C',
  '--copy',
  '-m',
  '-M',
  '--move',
  '-d',
  '-D',
  '--delete',
  '-f',
  '--force',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '-t',
  '--track',
  '--edit-description'
])

/** Read/listing flags that keep `git branch` a read despite being present. */
const BRANCH_READ_FLAGS = new Set([
  '-l',
  '--list',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '--show-current',
  '--color',
  '--no-color',
  '--column',
  '--no-column',
  '-i',
  '--ignore-case'
])

/** Read flags that consume the NEXT token as their value. */
const BRANCH_READ_VALUE_FLAGS = new Set([
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format'
])

const BRANCH_READ_PREFIXES = [
  '--sort=',
  '--format=',
  '--color=',
  '--column=',
  '--contains=',
  '--no-contains=',
  '--merged=',
  '--no-merged=',
  '--points-at=',
  '--abbrev='
]

function hasCreationFlagBeforeDoubleDash(
  tokens: readonly string[],
  flags: ReadonlySet<string>
): boolean {
  for (const token of tokens) {
    // Past `--`, tokens are pathspecs — a literal `-b` there is a path.
    if (token === '--') return false
    if (flags.has(token)) return true
    if (token === '--orphan' || token.startsWith('--orphan=')) return true
  }
  return false
}

/**
 * `git branch …` holds when it carries an explicit mutation flag, or a
 * positional branch name outside list mode (bare `git branch newname`
 * CREATES). Bare/listing/query forms stay reads. Tokens after `--` are
 * positionals for branch (git treats them as names/patterns).
 */
function isBranchMutationInvocation(tokens: readonly string[]): boolean {
  let positional = false
  let listMode = false
  let afterDoubleDash = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && token.startsWith('-')) {
      if (BRANCH_MUTATION_FLAGS.has(token)) return true
      if (BRANCH_READ_VALUE_FLAGS.has(token)) {
        index += 1
        continue
      }
      if (BRANCH_READ_FLAGS.has(token)) {
        if (token === '-l' || token === '--list') listMode = true
        continue
      }
      if (BRANCH_READ_PREFIXES.some((prefix) => token.startsWith(prefix))) continue
      // Unknown flag: not provably a mutation on its own — keep scanning for
      // an explicit creation signal (a positional still counts below).
      continue
    }
    positional = true
  }
  return positional && !listMode
}

/**
 * Does this shell command (string, argv array, or `sh -c` wrapper) create,
 * move, or remove a git branch/worktree? Recognition-oriented — see the
 * polarity note in the module doc.
 */
export function isBranchOrWorktreeMutationShellCommand(command: unknown): boolean {
  const normalized = shellCommandFromRawCommand(command)
  if (typeof normalized !== 'string') return false
  const trimmed = normalized.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return false
  const tokens = trimmed.split(/\s+/)
  if (tokens[0] !== 'git') return false

  let index = 1
  while (index < tokens.length && tokens[index].startsWith('-')) {
    index += GIT_GLOBAL_VALUE_FLAGS.has(tokens[index]) ? 2 : 1
  }
  const subcommand = tokens[index] ?? ''
  const rest = tokens.slice(index + 1)
  switch (subcommand) {
    case 'worktree':
      return WORKTREE_MUTATION_SUBCOMMANDS.has(rest[0] ?? '')
    case 'checkout':
      return hasCreationFlagBeforeDoubleDash(rest, CHECKOUT_CREATION_FLAGS)
    case 'switch':
      return hasCreationFlagBeforeDoubleDash(rest, SWITCH_CREATION_FLAGS)
    case 'branch':
      return isBranchMutationInvocation(rest)
    default:
      return false
  }
}

export interface IsolateSharedBranchHoldArgs {
  service: AgenticServiceId | null | undefined
  /** Raw command value — string, argv array, or preview-extracted string. */
  shellCommand: unknown
  /** True when the run carries an EnsembleRunIdentity (seat lane/turn). */
  isEnsembleRun: boolean
  /** The run's chat, for the chat-scoped Isolate policy. */
  chat: Pick<ChatRecord, 'ensemble'> | null | undefined
}

/**
 * The composed gate predicate: ensemble seat + chat Isolate policy pinned to
 * the shared checkout + a branch/worktree mutation command. Solo runs, chats
 * without ensemble config, and Worktrees/Any policies never hold (Worktrees
 * stays prompt-level by the ruling; Any is the agent's-choice regime).
 */
export function isIsolateSharedBranchHold(args: IsolateSharedBranchHoldArgs): boolean {
  if (args.service !== 'shellCommands') return false
  if (!args.isEnsembleRun) return false
  const ensemble = args.chat?.ensemble
  if (!ensemble) return false
  if (resolveEnsembleFanoutIsolationPolicy(ensemble.fanoutIsolation) !== 'off') return false
  return isBranchOrWorktreeMutationShellCommand(args.shellCommand)
}

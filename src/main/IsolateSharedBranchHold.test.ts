import { describe, expect, it } from 'vitest'
import {
  isBranchOrWorktreeMutationShellCommand,
  isIsolateSharedBranchHold
} from './IsolateSharedBranchHold'
import type { ChatRecord } from './store/types'

describe('isBranchOrWorktreeMutationShellCommand', () => {
  it('recognizes worktree add/move/remove and not the read/admin verbs', () => {
    expect(isBranchOrWorktreeMutationShellCommand('git worktree add ../lane-1')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git worktree add -b feat ../lane-1')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git worktree move ../a ../b')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git worktree remove ../lane-1')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git worktree list')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git worktree prune')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git worktree lock ../lane-1')).toBe(false)
  })

  it('recognizes checkout/switch creation flags and not plain switches or file restores', () => {
    expect(isBranchOrWorktreeMutationShellCommand('git checkout -b feature/x')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git checkout -B feature/x origin/main')).toBe(
      true
    )
    expect(isBranchOrWorktreeMutationShellCommand('git checkout --orphan fresh')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git switch -c feature/x')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git switch --create feature/x')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git checkout main')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git checkout -- src/file.ts')).toBe(false)
    // Past `--`, a literal -b is a pathspec, not a creation flag.
    expect(isBranchOrWorktreeMutationShellCommand('git checkout -- -b')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git switch main')).toBe(false)
  })

  it('classifies git branch forms by mutation flags and bare-name creation', () => {
    expect(isBranchOrWorktreeMutationShellCommand('git branch feature/x')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git branch feature/x origin/main')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git branch -d old')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git branch -D old')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git branch -m old new')).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git branch -c a b')).toBe(true)
    expect(
      isBranchOrWorktreeMutationShellCommand('git branch --set-upstream-to=origin/x mybranch')
    ).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git branch')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git branch -a')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git branch -vv')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git branch --show-current')).toBe(false)
    // List-mode positionals are patterns, not names.
    expect(isBranchOrWorktreeMutationShellCommand('git branch --list feat-star')).toBe(false)
    // Value-taking read flags consume their positional.
    expect(isBranchOrWorktreeMutationShellCommand('git branch --contains abc123')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git branch --merged main')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git branch --sort=-committerdate -a')).toBe(
      false
    )
  })

  it('sees through argv arrays, sh -c wrappers, and git global flags', () => {
    expect(isBranchOrWorktreeMutationShellCommand(['git', 'checkout', '-b', 'x'])).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand(['sh', '-c', 'git switch -c x'])).toBe(true)
    expect(isBranchOrWorktreeMutationShellCommand('git -C ../elsewhere worktree add ../p')).toBe(
      true
    )
    expect(isBranchOrWorktreeMutationShellCommand('git --no-pager branch newname')).toBe(true)
  })

  it('never claims commands it cannot see are mutations (restriction polarity)', () => {
    expect(isBranchOrWorktreeMutationShellCommand('git status')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('git commit -m "add worktree support"')).toBe(
      false
    )
    // Compound commands are upstream-unparseable residue — never held.
    expect(isBranchOrWorktreeMutationShellCommand('cd x && git worktree add ../p')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('checkout -b x')).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand(null)).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand(undefined)).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand({ command: 'git checkout -b x' })).toBe(false)
    expect(isBranchOrWorktreeMutationShellCommand('')).toBe(false)
  })
})

describe('isIsolateSharedBranchHold', () => {
  const chatWith = (fanoutIsolation?: unknown): Pick<ChatRecord, 'ensemble'> =>
    ({
      ensemble: {
        enabled: true,
        maxParticipants: 5,
        participants: [],
        ...(fanoutIsolation !== undefined ? { fanoutIsolation } : {})
      }
    }) as never

  const base = {
    service: 'shellCommands' as const,
    shellCommand: 'git checkout -b feature/x',
    isEnsembleRun: true
  }

  it('holds an ensemble seat creation command under pinned Shared (default and explicit)', () => {
    expect(isIsolateSharedBranchHold({ ...base, chat: chatWith() })).toBe(true)
    expect(isIsolateSharedBranchHold({ ...base, chat: chatWith('off') })).toBe(true)
  })

  it('never holds under Worktrees or Any policies (Worktrees stays prompt-level)', () => {
    expect(isIsolateSharedBranchHold({ ...base, chat: chatWith('worktree') })).toBe(false)
    expect(isIsolateSharedBranchHold({ ...base, chat: chatWith('any') })).toBe(false)
  })

  it('is scoped to ensemble seats, shellCommands, and ensemble chats only', () => {
    expect(isIsolateSharedBranchHold({ ...base, isEnsembleRun: false, chat: chatWith() })).toBe(
      false
    )
    expect(isIsolateSharedBranchHold({ ...base, service: 'fileChanges', chat: chatWith() })).toBe(
      false
    )
    expect(isIsolateSharedBranchHold({ ...base, chat: { ensemble: undefined } as never })).toBe(
      false
    )
    expect(isIsolateSharedBranchHold({ ...base, chat: null })).toBe(false)
  })

  it('passes non-mutation commands through untouched', () => {
    expect(
      isIsolateSharedBranchHold({ ...base, shellCommand: 'git status', chat: chatWith() })
    ).toBe(false)
    expect(
      isIsolateSharedBranchHold({ ...base, shellCommand: 'git checkout main', chat: chatWith() })
    ).toBe(false)
  })
})

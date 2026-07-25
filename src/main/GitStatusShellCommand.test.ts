import { describe, expect, it } from 'vitest'
import {
  isReadOnlyGitStatusCommand,
  shellCommandFromApprovalPreview,
  shellCommandFromRawCommand
} from './GitStatusShellCommand'

describe('isReadOnlyGitStatusCommand', () => {
  it('accepts the pure git status forms agents actually run', () => {
    for (const command of [
      'git status',
      '  git status  ',
      'git status --porcelain',
      'git status --porcelain=v2 --branch',
      'git status -sb',
      'git status -s -b',
      'git status --short --branch',
      'git status -z --porcelain',
      'git status -uall',
      'git status --untracked-files=all',
      'git status --ignored=matching',
      'git status --no-renames --ahead-behind',
      'git status --show-stash',
      'git --no-pager status',
      'git --no-optional-locks status --porcelain',
      'git status -- src/main',
      'git status src/renderer/App.tsx',
      'git status -v'
    ]) {
      expect(isReadOnlyGitStatusCommand(command), command).toBe(true)
    }
  })

  it('rejects everything that is not exactly a git status invocation', () => {
    for (const command of [
      '',
      'git',
      'git stash',
      'git statusx',
      'gitk status',
      'Git status',
      '/usr/bin/git status',
      'git commit -m x',
      'git add .',
      'ls -la',
      'git log --oneline'
    ]) {
      expect(isReadOnlyGitStatusCommand(command), command).toBe(false)
    }
  })

  it('rejects compound commands, redirects, substitution, and quoting outright', () => {
    for (const command of [
      'git status && rm -rf /',
      'git status; ls',
      'git status | tee /tmp/out',
      'git status > /tmp/out',
      'git status < /etc/passwd',
      'git status & whoami',
      'git status `whoami`',
      'git status $(whoami)',
      "git status 'x'",
      'git status "x"',
      'git status *',
      'git status ~/repo',
      'git status\nrm -rf /',
      'git status \\; ls'
    ]) {
      expect(isReadOnlyGitStatusCommand(command), command).toBe(false)
    }
  })

  it('rejects the known git escalation vectors before the subcommand', () => {
    for (const command of [
      // core.fsmonitor executes an arbitrary program ON git status.
      'git -c core.fsmonitor=/tmp/evil status',
      'git -c status.showUntrackedFiles=all status',
      'git -C /somewhere/else status',
      'git --git-dir=/tmp/x status',
      'git --work-tree=/tmp/x status',
      'git --exec-path=/tmp/x status',
      'git -p status',
      'git --paginate status',
      'git --output=/tmp/f status',
      'git --namespace=x status'
    ]) {
      expect(isReadOnlyGitStatusCommand(command), command).toBe(false)
    }
  })

  it('rejects unknown status flags, env prefixes, and oversized input', () => {
    expect(isReadOnlyGitStatusCommand('git status --output=/tmp/f')).toBe(false)
    expect(isReadOnlyGitStatusCommand('git status --column=always,dense --bogus')).toBe(false)
    expect(isReadOnlyGitStatusCommand('GIT_PAGER=evil git status')).toBe(false)
    expect(isReadOnlyGitStatusCommand('VAR=1 git status')).toBe(false)
    expect(isReadOnlyGitStatusCommand(`git status ${'a'.repeat(500)}`)).toBe(false)
    expect(isReadOnlyGitStatusCommand(42)).toBe(false)
    expect(isReadOnlyGitStatusCommand(null)).toBe(false)
    expect(isReadOnlyGitStatusCommand(['git', 'status'])).toBe(false)
  })
})

describe('shellCommandFromRawCommand', () => {
  it('passes strings through and unwraps sh -c wrappers', () => {
    expect(shellCommandFromRawCommand('git status')).toBe('git status')
    expect(shellCommandFromRawCommand(['bash', '-lc', 'git status'])).toBe('git status')
    expect(shellCommandFromRawCommand(['sh', '-c', 'git status -sb'])).toBe('git status -sb')
    expect(shellCommandFromRawCommand(['/bin/zsh', '-c', 'git status'])).toBe('git status')
    expect(shellCommandFromRawCommand(['git', 'status', '--porcelain'])).toBe(
      'git status --porcelain'
    )
  })

  it('fails closed on non-string shapes', () => {
    expect(shellCommandFromRawCommand(undefined)).toBeNull()
    expect(shellCommandFromRawCommand({ command: 'git status' })).toBeNull()
    expect(shellCommandFromRawCommand(['git', 42])).toBeNull()
  })

  it('keeps wrapper scripts intact so the classifier sees the whole payload', () => {
    const wrapped = shellCommandFromRawCommand(['bash', '-lc', 'git status && rm -rf /'])
    expect(wrapped).toBe('git status && rm -rf /')
    expect(isReadOnlyGitStatusCommand(wrapped)).toBe(false)
    // A 4-part exec is NOT an -c wrapper; the join starts with bash → rejected.
    const joined = shellCommandFromRawCommand(['bash', '-lc', 'git', 'status'])
    expect(isReadOnlyGitStatusCommand(joined)).toBe(false)
  })
})

describe('shellCommandFromApprovalPreview', () => {
  it('prefers the raw tool input over the display string', () => {
    expect(
      shellCommandFromApprovalPreview({
        kind: 'command',
        command: 'git status (summary text)',
        params: { command: 'git status' }
      })
    ).toBe('git status')
    expect(
      shellCommandFromApprovalPreview({
        kind: 'command',
        command: 'bash -lc git status',
        params: { command: ['bash', '-lc', 'git status'] }
      })
    ).toBe('git status')
  })

  it('falls back to the display command and fails closed otherwise', () => {
    expect(shellCommandFromApprovalPreview({ kind: 'command', command: 'git status' })).toBe(
      'git status'
    )
    expect(shellCommandFromApprovalPreview({ params: {} })).toBeNull()
    expect(shellCommandFromApprovalPreview(null)).toBeNull()
    expect(shellCommandFromApprovalPreview('git status')).toBeNull()
  })
})

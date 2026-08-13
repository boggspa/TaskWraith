import { describe, expect, it } from 'vitest'
import {
  isReadOnlyGitShellCommand,
  shellCommandFromApprovalPreview,
  shellCommandFromRawCommand
} from './ReadOnlyGitShellCommand'

describe('isReadOnlyGitShellCommand — git status', () => {
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
      expect(isReadOnlyGitShellCommand(command), command).toBe(true)
    }
  })

  it('rejects everything that is not exactly a read subcommand invocation', () => {
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
      // show / blame deliberately stay gated on both lanes.
      'git show HEAD',
      'git blame src/main/index.ts'
    ]) {
      expect(isReadOnlyGitShellCommand(command), command).toBe(false)
    }
  })
})

describe('isReadOnlyGitShellCommand — git diff', () => {
  it('accepts the read-only diff forms agents actually run', () => {
    for (const command of [
      'git diff',
      'git diff --stat',
      'git diff --cached',
      'git diff --staged --name-only',
      'git diff HEAD~1..HEAD',
      'git diff main...feature --stat',
      'git diff HEAD -- src/main/index.ts',
      'git diff --name-status -M',
      'git diff --diff-filter=AM --name-only',
      'git diff -U0 --no-color',
      'git diff --word-diff=color',
      'git diff --compact-summary',
      'git diff --check',
      'git --no-pager diff --shortstat',
      'git diff --merge-base main',
      'git diff -w -b',
      'git diff --no-ext-diff --no-textconv'
    ]) {
      expect(isReadOnlyGitShellCommand(command), command).toBe(true)
    }
  })

  it('rejects the diff escalation and exfiltration vectors', () => {
    for (const command of [
      // Reads ANY file on disk, no repo required.
      'git diff --no-index /etc/passwd /dev/null',
      // Writes a file even on a read subcommand.
      'git diff --output=/tmp/out',
      'git diff --output /tmp/out',
      // External program execution.
      'git diff --ext-diff',
      'git diff --textconv',
      'git -p diff',
      'git --paginate diff',
      'git -c core.pager=evil diff',
      'git -C /somewhere/else diff',
      'git diff -O/tmp/orderfile',
      // Shell metacharacters.
      'git diff > /tmp/x',
      'git diff | tee /tmp/x',
      'git diff && rm -rf /',
      "git diff 'HEAD'"
    ]) {
      expect(isReadOnlyGitShellCommand(command), command).toBe(false)
    }
  })
})

describe('isReadOnlyGitShellCommand — git rev-list', () => {
  it('accepts the narrow commit-count forms used for local/upstream inspection', () => {
    for (const command of [
      'git rev-list --count HEAD',
      'git rev-list --count origin/master..master',
      'git --no-pager rev-list --count HEAD~5..HEAD'
    ]) {
      expect(isReadOnlyGitShellCommand(command), command).toBe(true)
    }
  })

  it('rejects the unscreened rev-list option surface', () => {
    for (const command of [
      'git rev-list --alternate-refs',
      'git rev-list --all',
      'git rev-list --objects HEAD',
      'git rev-list --filter=blob:none HEAD'
    ]) {
      expect(isReadOnlyGitShellCommand(command), command).toBe(false)
    }
  })
})

describe('isReadOnlyGitShellCommand — git log', () => {
  it('accepts the read-only log forms agents actually run', () => {
    for (const command of [
      'git log',
      'git log --oneline -10',
      'git log --oneline -n10',
      'git log -n 20 --graph --decorate',
      'git log --max-count=5 --stat',
      'git log HEAD~5..HEAD --oneline',
      'git log --pretty=format:%H %s',
      'git log --format=%h --date=iso-strict',
      'git log --since=2.weeks --author=chris@example.com',
      'git log --grep=fix --no-merges',
      'git log --follow -- src/main/index.ts',
      'git log -S needle --oneline',
      'git log -Gpattern -p',
      'git log --first-parent --all',
      'git log v1.8.0..HEAD --reverse',
      'git log HEAD^ --name-status',
      'git --no-pager log --oneline'
    ]) {
      expect(isReadOnlyGitShellCommand(command), command).toBe(true)
    }
  })

  it('rejects the log escalation vectors and slack flag shapes', () => {
    for (const command of [
      // gpg execution.
      'git log --show-signature',
      // Pager exec is position-sensitive: global -p rejected…
      'git -p log',
      'git --paginate log',
      // …file output and drivers rejected.
      'git log --output=/tmp/x',
      'git log --ext-diff',
      'git -c core.fsmonitor=/tmp/evil log',
      'git --git-dir=/tmp/x log',
      'git --exec-path=/tmp/x log',
      // Bare -n prefix must not slack-match junk.
      'git log -nonsense',
      'git log -n10x',
      // Word-initial tilde expands in the shell.
      'git log ~/secrets',
      // Braces stay out of the charset (@{u}, format field selectors).
      'git log @{u}',
      'git log --pretty=format:%(trailers)'
    ]) {
      expect(isReadOnlyGitShellCommand(command), command).toBe(false)
    }
  })
})

describe('isReadOnlyGitShellCommand — shared fail-closed shape', () => {
  it('rejects compound commands, substitution, env prefixes, and oversized input', () => {
    expect(isReadOnlyGitShellCommand('git status && rm -rf /')).toBe(false)
    expect(isReadOnlyGitShellCommand('git log; ls')).toBe(false)
    expect(isReadOnlyGitShellCommand('git diff `whoami`')).toBe(false)
    expect(isReadOnlyGitShellCommand('git log $(whoami)')).toBe(false)
    expect(isReadOnlyGitShellCommand('VAR=1 git status')).toBe(false)
    expect(isReadOnlyGitShellCommand('GIT_PAGER=evil git log')).toBe(false)
    expect(isReadOnlyGitShellCommand(`git log ${'a'.repeat(500)}`)).toBe(false)
    expect(isReadOnlyGitShellCommand(42)).toBe(false)
    expect(isReadOnlyGitShellCommand(null)).toBe(false)
    expect(isReadOnlyGitShellCommand(['git', 'log'])).toBe(false)
  })

  it('keeps mid-token revision characters but rejects them token-initially', () => {
    expect(isReadOnlyGitShellCommand('git log HEAD~3')).toBe(true)
    expect(isReadOnlyGitShellCommand('git log HEAD^')).toBe(true)
    expect(isReadOnlyGitShellCommand('git diff ~/x')).toBe(false)
  })

  it('rejects Object.prototype keys used as the git subcommand', () => {
    for (const key of [
      'constructor',
      '__proto__',
      'valueOf',
      'toString',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString'
    ]) {
      expect(isReadOnlyGitShellCommand(`git ${key}`), key).toBe(false)
      expect(isReadOnlyGitShellCommand(`git ${key} --oneline`), key).toBe(false)
    }
  })
})

describe('shellCommandFromRawCommand', () => {
  it('passes strings through and unwraps sh -c wrappers', () => {
    expect(shellCommandFromRawCommand('git status')).toBe('git status')
    expect(shellCommandFromRawCommand(['bash', '-lc', 'git log --oneline'])).toBe(
      'git log --oneline'
    )
    expect(shellCommandFromRawCommand(['sh', '-c', 'git diff --stat'])).toBe('git diff --stat')
    expect(shellCommandFromRawCommand(['/bin/zsh', '-c', 'git status'])).toBe('git status')
    expect(shellCommandFromRawCommand(['git', 'diff', '--cached'])).toBe('git diff --cached')
  })

  it('fails closed on non-string shapes', () => {
    expect(shellCommandFromRawCommand(undefined)).toBeNull()
    expect(shellCommandFromRawCommand({ command: 'git status' })).toBeNull()
    expect(shellCommandFromRawCommand(['git', 42])).toBeNull()
  })

  it('keeps wrapper scripts intact so the classifier sees the whole payload', () => {
    const wrapped = shellCommandFromRawCommand(['bash', '-lc', 'git log && rm -rf /'])
    expect(wrapped).toBe('git log && rm -rf /')
    expect(isReadOnlyGitShellCommand(wrapped)).toBe(false)
    // A 4-part exec is NOT an -c wrapper; the join starts with bash → rejected.
    const joined = shellCommandFromRawCommand(['bash', '-lc', 'git', 'log'])
    expect(isReadOnlyGitShellCommand(joined)).toBe(false)
  })
})

describe('shellCommandFromApprovalPreview', () => {
  it('prefers the raw tool input over the display string', () => {
    expect(
      shellCommandFromApprovalPreview({
        kind: 'command',
        command: 'git log (summary text)',
        params: { command: 'git log --oneline' }
      })
    ).toBe('git log --oneline')
    expect(
      shellCommandFromApprovalPreview({
        kind: 'command',
        command: 'bash -lc git diff',
        params: { command: ['bash', '-lc', 'git diff'] }
      })
    ).toBe('git diff')
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

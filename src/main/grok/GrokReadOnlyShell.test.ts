import { describe, it, expect } from 'vitest'
import {
  isReadOnlyShellCommand,
  extractShellCommandFromToolCall,
  grokReadOnlyShellRequestAllowed
} from './GrokReadOnlyShell'

describe('isReadOnlyShellCommand — allows genuine read-only recon', () => {
  const allowed = [
    'ls',
    'ls -la',
    'pwd',
    'cat README.md',
    'head -100 file.txt',
    'tail -n 20 log.txt',
    'grep -rn "foo" src',
    'grep -o bar file',
    'rg --files',
    'find . -maxdepth 3 -type f',
    "find . -maxdepth 3 -type f ! -path './.git/*'",
    'git log --oneline -10',
    'git status',
    'git diff HEAD~1',
    'git show abc123',
    'git remote -v',
    'git remote show origin',
    'git branch -a',
    'git branch --list',
    'git tag -l',
    'git config --get user.name',
    'git config --list',
    'git stash list',
    'git config --get user.name',
    'wc -l file',
    'stat file',
    'rg --files',
    'rg -n pattern src',
    'cat x | uniq -c',
    'uniq input.txt',
    // `-p` AFTER the subcommand is `--patch` (a read), not the global pager.
    'git log -p',
    'git log -p -3',
    'git show -p HEAD',
    // The exact command from the reported failing turn:
    "ls -la && git log --oneline -10 2>/dev/null; git remote -v 2>/dev/null; find . -maxdepth 3 -type f ! -path './.git/*' 2>/dev/null | head -80",
    // Pipes of read commands + benign stderr discard:
    'cat package.json | jq .name',
    'git log --oneline | head -20',
    'grep -c TODO src/**/*.ts 2>/dev/null'
  ]
  it.each(allowed)('allows: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true)
  })
})

describe('isReadOnlyShellCommand — denies mutations & bypasses (fail closed)', () => {
  const denied = [
    // Direct mutations
    'rm -rf /',
    'rm file.txt',
    'mv a b',
    'cp a b',
    'mkdir foo',
    'touch newfile',
    'chmod +x script.sh',
    'ln -s a b',
    'dd if=/dev/zero of=x',
    'truncate -s 0 f',
    // Redirection writes a file
    'echo hacked > file.txt',
    'echo x >> log',
    'cat a > b',
    'ls -la 1> out.txt',
    'find . -type f > list.txt',
    // Redirect to /dev/null is fine, but a real target hidden after it is not
    'ls 2>/dev/null > stolen',
    // Pipe into a mutating command
    'cat urls | xargs rm',
    'find . -name "*.tmp" | xargs rm -f',
    'ls | tee out.txt',
    // Command substitution / process substitution
    'echo $(rm -rf .)',
    'cat `whoami`.log',
    'diff <(rm x) y',
    // git write subcommands
    'git commit -m x',
    'git add .',
    'git push',
    'git fetch',
    'git pull',
    'git checkout main',
    'git switch -c feat',
    'git reset --hard',
    'git clean -fd',
    'git rm file',
    'git stash',
    'git stash pop',
    'git branch -d old',
    'git branch newbranch',
    'git tag v1.0',
    'git tag -a v1 -m msg',
    'git config user.name "attacker"',
    'git remote add evil https://x',
    'git remote set-url origin https://x',
    'git -C /other log',
    'git -c core.pager=touch\\ pwned log',
    // find that executes
    'find . -name x -delete',
    'find . -type f -exec rm {} ;',
    'find . -exec touch {} +',
    // Script / arbitrary interpreter execution
    './evil.sh',
    '/bin/sh -c "rm x"',
    'bash -c "rm x"',
    'sh script.sh',
    'python -c "import os; os.remove(\'x\')"',
    "node -e \"require('fs').unlinkSync('x')\"",
    'npm install',
    'pip install evil',
    'sudo rm -rf /',
    'env FOO=bar rm x',
    'FOO=bar ls',
    'eval "rm x"',
    'exec rm x',
    // sed / awk can write in place → not on the allowlist
    'sed -i s/a/b/ file',
    'awk "{print > \\"f\\"}" x',
    'sort -o out.txt file',
    'tee file',
    // Empty / nonsense
    '',
    '   ',
    ';;;',
    '&&',
    '| rm x'
  ]
  it.each(denied)('denies: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  // Bypasses found + empirically confirmed by an adversarial security review.
  const adversarialBypasses = [
    // RCE: ripgrep runs an arbitrary program per file.
    'rg --pre /bin/sh needle somefile.txt',
    'rg --pre=/bin/sh needle file',
    'rg --hostname-bin /bin/sh -n foo file',
    // File write via a program's own positional / flag (no shell redirect).
    'xxd -r -p payload.txt /tmp/evil.sh',
    'xxd file.bin out.bin',
    'tree -o /tmp/out.txt',
    'sort -o out.txt file',
    'git log --output=/tmp/pwned.txt',
    'git log --output=file',
    'git diff --output=file',
    'git show --output=file HEAD',
    // git config set-forms with a decoy trailing read flag (the .some() bug).
    'git config user.email pwned@evil.com --get',
    'git config --replace-all user.email pwned@evil.com --get',
    'git config --add core.hooksPath /tmp/evilhooks --get',
    'git config --unset user.email --get',
    'git config --get user.email pwned@evil.com',
    // git forced external-program execution (pager / ext-diff / textconv).
    'git -p log',
    'git --paginate log',
    'git log --ext-diff',
    'git log --textconv',
    'git grep -O pattern',
    'git grep --open-files-in-pager foo',
    // uniq's OUTPUT positional writes a file.
    'uniq input.txt output.txt'
  ]
  it.each(adversarialBypasses)('denies confirmed bypass: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  it('denies a read-only prefix chained with a mutation', () => {
    expect(isReadOnlyShellCommand('ls -la && rm -rf .')).toBe(false)
    expect(isReadOnlyShellCommand('git log; git push')).toBe(false)
    expect(isReadOnlyShellCommand('cat a | grep b | tee out')).toBe(false)
  })

  it('handles non-string input', () => {
    expect(isReadOnlyShellCommand(null)).toBe(false)
    expect(isReadOnlyShellCommand(undefined)).toBe(false)
    expect(isReadOnlyShellCommand(42 as unknown as string)).toBe(false)
  })
})

describe('extractShellCommandFromToolCall', () => {
  it('reads the command from rawInput / input / parameters', () => {
    expect(extractShellCommandFromToolCall({ rawInput: { command: 'ls -la' } })).toBe('ls -la')
    expect(extractShellCommandFromToolCall({ input: { command: 'pwd' } })).toBe('pwd')
    expect(extractShellCommandFromToolCall({ parameters: { command: 'git status' } })).toBe(
      'git status'
    )
    expect(extractShellCommandFromToolCall({ command: 'cat x' })).toBe('cat x')
  })
  it('returns null when no command present', () => {
    expect(extractShellCommandFromToolCall(null)).toBeNull()
    expect(extractShellCommandFromToolCall({ rawInput: { path: 'x' } })).toBeNull()
    expect(extractShellCommandFromToolCall({ rawInput: { command: '   ' } })).toBeNull()
  })
})

describe('grokReadOnlyShellRequestAllowed', () => {
  it('allows a read-only execute request (the reported run_terminal_command case)', () => {
    expect(
      grokReadOnlyShellRequestAllowed({
        toolKind: 'execute',
        toolName: 'run_terminal_command',
        rawToolCall: {
          rawInput: {
            command:
              "ls -la && git log --oneline -10 2>/dev/null; git remote -v 2>/dev/null; find . -maxdepth 3 -type f ! -path './.git/*' 2>/dev/null | head -80"
          }
        }
      })
    ).toBe(true)
  })
  it('denies a mutating execute request', () => {
    expect(
      grokReadOnlyShellRequestAllowed({
        toolKind: 'execute',
        toolName: 'run_terminal_command',
        rawToolCall: { rawInput: { command: 'rm -rf build' } }
      })
    ).toBe(false)
  })
  it('denies when the command cannot be extracted (fail closed)', () => {
    expect(
      grokReadOnlyShellRequestAllowed({ toolKind: 'execute', toolName: 'run_terminal_command' })
    ).toBe(false)
  })
  it('ignores non-shell tool kinds', () => {
    expect(
      grokReadOnlyShellRequestAllowed({
        toolKind: 'edit',
        toolName: 'write_file',
        rawToolCall: { rawInput: { command: 'ls' } }
      })
    ).toBe(false)
  })
})

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
    'git grep -n "foo" src',
    'git grep -n "toolbar" swift/ || git grep -n "StudioOverlay" swift/',
    'git -c core.fsmonitor=false grep -i "effectpreview" src/main/ipc/ src/preload/ src/renderer/ || echo "NO_MATCHES"',
    "sed -n '1,10p' file",
    'rg --files',
    'find . -maxdepth 3 -type f',
    "find . -maxdepth 3 -type f ! -path './.git/*'",
    'wc -l file',
    'stat file',
    'date',
    'hostname',
    'rg --files',
    'rg -n pattern src',
    "rg 'foo$|bar[0-9]{2}?' .",
    'cat x | uniq -c',
    'uniq input.txt',
    // Pipes of read commands + benign stderr discard:
    'cat package.json | jq .name',
    'grep -c TODO src/**/*.ts 2>/dev/null',
    "cat <<<'${(e)PAYLOAD}'"
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
    // Dual-mode commands outside the generic proof allowlist.
    'file README.md',
    'file -C -m ./magic',
    'file --compile -m ./magic',
    'date 0712120026',
    'date --set 2026-07-12',
    'hostname changed',
    'printf hello',
    'printf -v GIT_PAGER /usr/bin/false',
    'printf -vGIT_PAGER /usr/bin/false',
    // Redirection writes a file
    'echo hacked > file.txt',
    'echo x >> log',
    'cat a > b',
    'ls -la 1> out.txt',
    'find . -type f > list.txt',
    'echo x >&1pwn',
    'echo x 2>&1err',
    'echo x 1>&2out',
    'echo x >&2both',
    'cat <&0input',
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
    // Git stays on the shared fail-closed read surface.
    'git',
    'git --version',
    'git branch -a',
    'git branch -mnew-name',
    'git branch -uorigin/master',
    'git branch --set-upstream-to=origin/master',
    'git branch --edit-des',
    'git grep --open-files-in-page foo',
    'git --config-env=core.fsmonitor=SHELL status --short',
    'git -c core.fsmonitor=/bin/evil grep foo || echo NO_MATCHES',
    'printf -v GIT_PAGER /usr/bin/false; git grep --open-files-in-page foo',
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
    'uniq -- input.txt --output',
    "uniq -- input.txt '-output'",
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
    'uniq input.txt output.txt',
    'uniq -- input.txt --output',
    "uniq -- input.txt '-output'",
    // Prefixes are kept outside the proof surface even where the local
    // BSD/GNU build rejects the abbreviation today.
    'find . -dele',
    'find . -execd echo {} ;',
    'rg --pr /bin/sh needle file',
    'rg --hostname-b /bin/sh needle file'
  ]
  it.each(adversarialBypasses)('denies confirmed bypass: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  const quotedMutationTokens = [
    "find . '-exec' touch /tmp/pwned '{}' ';'",
    'find . "-exec" touch /tmp/pwned "{}" ";"',
    "find . '-delete'",
    'find . "-delete"',
    "find . -'exec' touch /tmp/pwned '{}' ';'",
    "find . -e''xec touch /tmp/pwned '{}' ';'",
    "rg '--pre' /bin/sh needle file",
    'rg "--pre" /bin/sh needle file',
    "rg '--pre=/bin/sh' needle file",
    "rg --'pre' /bin/sh needle file",
    "rg --p''re=/bin/sh needle file",
    "rg '--hostname-bin' /bin/sh needle file",
    "git log --ext-''diff"
  ]
  it.each(quotedMutationTokens)('denies quoted semantic mutation token: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  const dynamicExpansionBypasses = [
    'find . $DANGER',
    'find . ${DANGER}',
    'find . "$DANGER"',
    'find . -{delete,print}',
    'find . -*',
    "find . $'-delete'",
    "find . $'\\x2ddelete'",
    'rg $PRE /bin/sh needle file',
    'rg "$PRE" /bin/sh needle file',
    'rg --{pre,regexp} /bin/sh needle file',
    "rg $'--pre' /bin/sh needle file",
    "rg --p$'re'=/bin/sh needle file",
    "git log --ext-$'diff'",
    'git log --ext-{diff,nope}',
    'find . ${(e)DANGER}',
    'rg "${(e)PRE}" /bin/sh needle file',
    "find /tmp /tmp/*(e:'touch /tmp/pwn':)",
    "rg /tmp/*(e:'touch /tmp/pwn':) needle"
  ]
  it.each(dynamicExpansionBypasses)('denies dynamic shell argv expansion: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  const lineContinuationBypasses = [
    ['find . -de\\', 'lete'].join('\n'),
    ['rg --pr\\', 'e /bin/sh needle file'].join('\n'),
    ['git log --ext-\\', 'diff'].join('\n'),
    ['find . "-de\\', 'lete"'].join('\n'),
    ['find . -de\\', 'lete'].join('\r\n'),
    ['rg --pr\\', 'e /bin/sh needle file'].join('\r\n'),
    ['git log --ext-\\', 'diff'].join('\r\n'),
    ['find . "-de\\', 'lete"'].join('\r\n')
  ]
  it.each(lineContinuationBypasses)('denies shell line-continuation bypass: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  const redirectExpansionBypasses = [
    'cat <<<${(e)PAYLOAD}',
    'cat <${(e)INPUT}',
    'cat <<<"${(e)PAYLOAD}"',
    "cat <*(e:'touch${IFS}/tmp/x':)"
  ]
  it.each(redirectExpansionBypasses)('denies expansion hidden in input redirect: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  it('denies a read-only prefix chained with a mutation', () => {
    expect(isReadOnlyShellCommand('ls -la && rm -rf .')).toBe(false)
    expect(isReadOnlyShellCommand('git log; git push')).toBe(false)
    expect(isReadOnlyShellCommand('cat a | grep b | tee out')).toBe(false)
  })

  it('allows descriptor-only duplication at a real shell boundary', () => {
    expect(isReadOnlyShellCommand('echo x 2>&1')).toBe(true)
    expect(isReadOnlyShellCommand('echo x 1>&2')).toBe(true)
    expect(isReadOnlyShellCommand('echo x >&2')).toBe(true)
    expect(isReadOnlyShellCommand('echo x 2>&1 | head -1')).toBe(true)
    expect(isReadOnlyShellCommand('echo x 1>&2; pwd')).toBe(true)
    expect(isReadOnlyShellCommand('echo x >&2 && pwd')).toBe(true)
    expect(isReadOnlyShellCommand('cat README.md <&0')).toBe(true)
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
  it('allows shared-classifier Git reads inside a safe recon sequence', () => {
    expect(
      grokReadOnlyShellRequestAllowed({
        toolKind: 'execute',
        toolName: 'run_terminal_command',
        rawToolCall: {
          rawInput: {
            command:
              "ls -la && git log --oneline -10 2>/dev/null; git status --short; find . -maxdepth 3 -type f ! -path './.git/*' 2>/dev/null | head -80"
          }
        }
      })
    ).toBe(true)
  })
  it('allows the exact read-only shell sequence from the July 12 QA denial', () => {
    expect(
      grokReadOnlyShellRequestAllowed({
        toolKind: 'execute',
        toolName: 'run_terminal_command',
        rawToolCall: {
          rawInput: {
            command:
              'ls "/Users/chrisizatt/Documents/Test 1"/test_*.py 2>/dev/null | wc -l; rg -n "mcp_|write_file|AppShot|Swift|triangle" "/Users/chrisizatt/Documents/Test 1" --glob \'*.py\' --glob \'*.md\' 2>/dev/null | head -40'
          }
        }
      })
    ).toBe(true)
  })
  it('keeps quoted shell operators inside read-only arguments and fails closed on malformed quotes', () => {
    expect(isReadOnlyShellCommand("rg 'foo|bar;baz&qux' . | head -20")).toBe(true)
    expect(isReadOnlyShellCommand("rg 'foo|bar . | head -20")).toBe(false)
    expect(isReadOnlyShellCommand('rg foo . \\')).toBe(false)
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

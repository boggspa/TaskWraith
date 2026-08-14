import { describe, expect, it } from 'vitest'
import {
  isPromptFreeReadOnlyShellCommand,
  promptFreeReadOnlyShellReason
} from './PromptFreeReadOnlyShell'

describe('promptFreeReadOnlyShellReason', () => {
  it('keeps basic Git reads prompt-free, including inside safe command sequences', () => {
    expect(promptFreeReadOnlyShellReason('git status --porcelain')).toBe('readonly_shell')
    expect(promptFreeReadOnlyShellReason('git log --oneline -10')).toBe('readonly_shell')
    expect(promptFreeReadOnlyShellReason('git diff --check')).toBe('readonly_shell')
    expect(
      promptFreeReadOnlyShellReason(
        'git log -n 5 --oneline && git rev-list --count origin/master..master'
      )
    ).toBe('inspection_shell')
    expect(promptFreeReadOnlyShellReason('git rev-parse HEAD && git status --porcelain')).toBe(
      'inspection_shell'
    )
    expect(
      promptFreeReadOnlyShellReason(
        'git grep -n "toolbar" swift/ || git grep -n "StudioOverlay" swift/'
      )
    ).toBe('inspection_shell')
    expect(
      promptFreeReadOnlyShellReason(
        'git -c core.fsmonitor=false grep -i "effectpreview" src/main/ipc/ src/preload/ src/renderer/ || echo "NO_MATCHES"'
      )
    ).toBe('inspection_shell')
    expect(promptFreeReadOnlyShellReason('ls -la && git status --short')).toBe('inspection_shell')
  })

  it('accepts the read-only scout commands observed in the approval ledger', () => {
    for (const command of [
      'df -h ~',
      'printenv CARGO_HOME RUSTUP_HOME CARGO_TARGET_DIR TASKWRAITH_LOCK_OWNER_ID',
      "find . -maxdepth 1 -type f \\( -name '.WORK-IN-PROGRESS-*' -o -name 'SHIP-HOLD*' \\) -print",
      'find .local-only/spikes/studio-companion-bakeoff -maxdepth 4 -print 2>/dev/null',
      'du -sh /Users/example/.cargo /Users/example/.rustup 2>/dev/null',
      "ls -l /opt/homebrew/bin/rustup 2>/dev/null\nfind /opt/homebrew/Cellar -maxdepth 2 -iname 'rust*' -print 2>/dev/null"
    ]) {
      expect(promptFreeReadOnlyShellReason(command), command).toBe('inspection_shell')
    }
  })

  it('normalizes argv and shell-wrapper command shapes', () => {
    expect(promptFreeReadOnlyShellReason(['git', 'status', '--short'])).toBe('readonly_shell')
    expect(promptFreeReadOnlyShellReason(['/bin/zsh', '-lc', 'find . -maxdepth 2 -type f'])).toBe(
      'inspection_shell'
    )
  })

  it('fails closed on Git writes, destructive find, unsafe redirects, and mixed mutations', () => {
    for (const command of [
      'git add .',
      'git commit -m scout',
      'git push origin master',
      'find . -delete',
      'find . -exec touch {} +',
      'find . -type f > inventory.txt',
      'ls -la && rm -rf build',
      'cat package.json | tee copy.json',
      'node -e process.exit()'
    ]) {
      expect(isPromptFreeReadOnlyShellCommand(command), command).toBe(false)
    }
  })
})

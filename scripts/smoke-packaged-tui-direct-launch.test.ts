import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('packaged TUI direct production Host launch', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
    'utf8'
  )

  it('spawns the packaged production Host launcher directly with a disposable profile', () => {
    expect(source).toContain("path.join(resourcesDir, 'host-bin')")
    expect(source).toContain("'taskwraith-host.cmd'")
    expect(source).toContain('const hostArgs = [')
    expect(source).toContain("'--profile',")
    expect(source).not.toContain("const hostArgs = ['serve'")
    expect(source).toContain("'--muse-binary'")
    expect(source).toContain("'--snapshot', '--no-start-host', '--user-data'")
  })

  it('uses safe Windows cmd invocation and never uses App/LaunchServices fallbacks', () => {
    expect(source).toContain('createWindowsCmdInvocation(launcher, args)')
    expect(source).not.toContain("'/usr/bin/open'")
    expect(source).not.toContain("'/usr/bin/ditto'")
    expect(source).not.toContain('isTaskWraithAlreadyRunning')
    expect(source).not.toContain('TASKWRAITH_TUI_APP_EXECUTABLE')
    expect(source).not.toContain('--taskwraith-headless-host')
    expect(source).not.toContain('--taskwraith-headless-parent')
  })

  it('skips the live control smoke for a package this host cannot execute, failing closed only on demand', () => {
    // 1.9.7 recovery run 33638521120: the win32-arm64 sibling packaged on the
    // x64 runner failed this smoke outright, where the launcher/help smokes and
    // 1.9.6 skipped it. The static checks already validated that payload.
    expect(source).toContain('if (!canLikelyExecPackage(packageTarget)) {')
    expect(source).toContain('console.log(`packaged TUI live control smoke skipped: ${reason}`)')
    expect(source).toMatch(
      /if \(!canLikelyExecPackage\(packageTarget\)\) \{[\s\S]*?TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST === '1'[\s\S]*?fail\([\s\S]*?console\.log\(`packaged TUI live control smoke skipped: \$\{reason\}`\)\s*return\s*\}/
    )
    expect(source).not.toContain('fail(`packaged TUI live control smoke cannot execute')
  })

  it('requires exact child shutdown and Host artifact cleanup while retaining identity', () => {
    expect(source).toContain("['stop', '--profile', userDataPath]")
    expect(source).toContain('packaged authenticated Host stop failed')
    expect(source).toContain("spawned.kill('SIGTERM')")
    expect(source).toContain('waitForChildExit(spawned, 10_000)')
    expect(source).toContain("'taskwraith-host-authority-v1.json'")
    expect(source).toContain("'host-install-identity.json'")
  })
})

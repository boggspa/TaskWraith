import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('packaged TUI disposable macOS host launch', () => {
  it('launches the ad-hoc copy inner executable without Launch Services', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )

    expect(source).toContain("const macosDir = path.join(packageRoot, 'Contents', 'MacOS')")
    expect(source).toContain("assertExecutable(found, 'packaged macOS App executable')")
    expect(source).toContain(
      'const appExecutable = resolvePackagedAppExecutable(smokePackageRoot, packageTarget)'
    )
    expect(source).not.toContain("command: '/usr/bin/open'")
  })

  it('copies the disposable app across mounted DMG volume boundaries', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )

    expect(source).toContain("'/usr/bin/ditto'")
    expect(source).toContain('TASKWRAITH_TUI_BUNDLE_COPY_TIMEOUT_MS')
    expect(source).not.toContain("['-cR', packageRoot, smokePackageRoot]")
  })

  it('preserves cmd.exe quoting when launching a packaged Windows TUI', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )

    expect(source).toContain('...invocation.spawnOptions')
  })

  it('bounds retries while Windows releases disposable Chromium profile files', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )

    expect(source).toContain('removeSmokeTree(userDataPath)')
    expect(source).toContain('maxRetries: 10')
    expect(source).toContain('retryDelay: 100')
  })

  it('makes packaged tw auto-start and authenticate its disposable windowless Host', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )
    const start = source.indexOf('async function runPackagedHostLiveRoundTrip')
    const end = source.indexOf('\nfunction removeSmokeTree', start)
    const roundTrip = source.slice(start, end)

    expect(roundTrip).toContain('taskwraith-host-v2.json')
    expect(roundTrip).toContain("TASKWRAITH_TUI_PACKAGE_SMOKE: '1'")
    expect(roundTrip).toContain('TASKWRAITH_TUI_APP_EXECUTABLE: appExecutable')
    expect(roundTrip).toContain('assertSmokeHostCommand(appPid, userDataPath, packageTarget)')
    expect(roundTrip).toContain('waitForSmokeHostShutdown(appPid, discoveryPath, 10_000)')
    expect(roundTrip).toContain('appPid = null')
    expect(roundTrip).toContain('shutdownProven = true')
    expect(roundTrip).toContain('preserving disposable package-smoke artifacts')
    expect(roundTrip).not.toContain('stopProcess(')
    expect(roundTrip).not.toContain("'--no-start-host'")
    expect(roundTrip).not.toContain('app = spawn(')
  })

  it('verifies the exact windowless smoke command on Windows before cleanup', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )

    expect(source).toContain("executable: 'powershell.exe'")
    expect(source).toContain('Get-CimInstance Win32_Process')
    expect(source).toContain(
      'command.includes(`--taskwraith-package-smoke-user-data=${userDataPath}`)'
    )
  })
})

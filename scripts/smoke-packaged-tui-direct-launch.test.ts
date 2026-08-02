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
    expect(source).toContain('command: resolvePackagedAppExecutable(packageRoot, packageTarget)')
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
})

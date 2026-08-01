import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('packaged TUI disposable macOS host launch', () => {
  it('launches the ad-hoc clone inner executable without Launch Services', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )

    expect(source).toContain("const macosDir = path.join(packageRoot, 'Contents', 'MacOS')")
    expect(source).toContain("assertExecutable(found, 'packaged macOS App executable')")
    expect(source).toContain('command: resolvePackagedAppExecutable(packageRoot, packageTarget)')
    expect(source).not.toContain("command: '/usr/bin/open'")
  })

  it('preserves cmd.exe quoting when launching a packaged Windows TUI', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-tui.cjs'),
      'utf8'
    )

    expect(source).toContain('...invocation.spawnOptions')
  })
})

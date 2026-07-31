import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []
const sourceScript = path.join(process.cwd(), 'ios', 'TaskWraithApp', 'scripts', 'bump-build.sh')

function fixture(projectYml: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-ios-bump-'))
  tempDirs.push(root)
  const appDir = path.join(root, 'TaskWraithApp')
  const scriptsDir = path.join(appDir, 'scripts')
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(scriptsDir, { recursive: true })
  fs.mkdirSync(binDir)
  fs.copyFileSync(sourceScript, path.join(scriptsDir, 'bump-build.sh'))
  fs.writeFileSync(path.join(appDir, 'project.yml'), projectYml)
  const xcodegenPath = path.join(binDir, 'xcodegen')
  // @portability-ok — this suite exercises the iOS build script, which is
  // macOS-only by construction: it shells out to `xcodegen` and Xcode, and every
  // case here already spawns `bash` to run bump-build.sh. A Windows launcher
  // would not make the test runnable there, only make the fixture lie about it.
  fs.writeFileSync(xcodegenPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

  return {
    projectPath: path.join(appDir, 'project.yml'),
    run: (args: string[] = []) =>
      spawnSync('bash', [path.join(scriptsDir, 'bump-build.sh'), ...args], {
        cwd: appDir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` }
      })
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('iOS build-number bump script', () => {
  it('increments every single-, double-, and bare YAML scalar while preserving quote style', () => {
    const setup = fixture(`
targets:
  app:
    CURRENT_PROJECT_VERSION: '86'
  extension:
    CURRENT_PROJECT_VERSION: "86"
  widget:
    CURRENT_PROJECT_VERSION: 86
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)'
`)

    const result = setup.run()
    expect(result.status).toBe(0)
    expect(fs.readFileSync(setup.projectPath, 'utf8')).toContain("CURRENT_PROJECT_VERSION: '87'")
    expect(fs.readFileSync(setup.projectPath, 'utf8')).toContain('CURRENT_PROJECT_VERSION: "87"')
    expect(fs.readFileSync(setup.projectPath, 'utf8')).toContain('CURRENT_PROJECT_VERSION: 87')
    expect(fs.readFileSync(setup.projectPath, 'utf8')).toContain(
      "CFBundleVersion: '$(CURRENT_PROJECT_VERSION)'"
    )
  })

  it('accepts an explicit greater build number', () => {
    const setup = fixture("CURRENT_PROJECT_VERSION: '86'\n")

    expect(setup.run(['100']).status).toBe(0)
    expect(fs.readFileSync(setup.projectPath, 'utf8')).toBe("CURRENT_PROJECT_VERSION: '100'\n")
  })

  it('rejects non-increasing input without modifying the project', () => {
    const source = 'CURRENT_PROJECT_VERSION: "86"\n'
    const setup = fixture(source)

    const result = setup.run(['86'])
    expect(result.status).not.toBe(0)
    expect(fs.readFileSync(setup.projectPath, 'utf8')).toBe(source)
  })

  it('rejects divergent target build numbers without partially updating them', () => {
    const source = `
CURRENT_PROJECT_VERSION: '86'
CURRENT_PROJECT_VERSION: "87"
`
    const setup = fixture(source)

    const result = setup.run(['100'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('values disagree')
    expect(fs.readFileSync(setup.projectPath, 'utf8')).toBe(source)
  })
})

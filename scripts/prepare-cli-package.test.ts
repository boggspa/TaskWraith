import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

function fixture(overrides: { rootVersion?: string; cliVersion?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-cli-package-'))
  roots.push(root)
  const packageRoot = join(root, 'packages', 'cli')
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  mkdirSync(join(root, 'out', 'tui', 'tui'), { recursive: true })
  mkdirSync(join(root, 'out', 'host', 'host-runtime'), { recursive: true })
  mkdirSync(join(root, 'out', 'host', 'host-node'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ version: overrides.rootVersion ?? '1.2.3', private: true })
  )
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'taskwraith',
      version: overrides.cliVersion ?? '1.2.3',
      bin: {
        taskwraith: 'bin/taskwraith.cjs',
        tw: 'bin/taskwraith.cjs',
        'taskwraith-host': 'bin/taskwraith-host.cjs'
      }
    })
  )
  // @portability-ok: fixture bytes copied and read back verbatim — never executed
  writeFileSync(join(packageRoot, 'bin', 'taskwraith.cjs'), '#!/usr/bin/env node\n')
  writeFileSync(join(packageRoot, 'bin', 'taskwraith-host.cjs'), '#!/usr/bin/env node\n')
  writeFileSync(join(root, 'LICENSE'), 'fixture license')
  // @portability-ok: fixture bytes copied and read back verbatim — never executed
  writeFileSync(join(root, 'out', 'tui', 'tui', 'cli.js'), '#!/usr/bin/env node\n')
  writeFileSync(join(root, 'out', 'tui', 'tui', 'cli.js.map'), 'omit me')
  // @portability-ok: fixture bytes copied and read back verbatim — never executed
  writeFileSync(join(root, 'out', 'host', 'host-runtime', 'cli.js'), '#!/usr/bin/env node\n')
  writeFileSync(join(root, 'out', 'host', 'host-node', 'provider.js'), 'require("node-pty")\n')
  return { root, packageRoot }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('prepare CLI package', () => {
  it('copies only executable JavaScript plus package identity and license', async () => {
    const { root, packageRoot } = fixture()
    const { prepareCliPackage } = await import('./prepare-cli-package.cjs')
    const dist = prepareCliPackage({ repoRoot: root, packageRoot, build: false })

    // @portability-ok: data round-trip — asserts the copied file still contains the fixture shebang
    expect(readFileSync(join(dist, 'tui', 'tui', 'cli.js'), 'utf8')).toContain('/usr/bin/env node')
    expect(existsSync(join(dist, 'tui', 'tui', 'cli.js.map'))).toBe(false)
    expect(readFileSync(join(dist, 'LICENSE'), 'utf8')).toBe('fixture license')
    expect(JSON.parse(readFileSync(join(dist, 'PACKAGE.json'), 'utf8'))).toMatchObject({
      name: 'taskwraith',
      version: '1.2.3',
      runtime: 'system-node'
    })
    expect(readFileSync(join(dist, 'host', 'host-node', 'provider.js'), 'utf8')).toContain(
      'node-pty'
    )
  })

  it('rejects version drift before writing the package payload', async () => {
    const { root, packageRoot } = fixture({ cliVersion: '1.2.2' })
    const { prepareCliPackage } = await import('./prepare-cli-package.cjs')
    expect(() => prepareCliPackage({ repoRoot: root, packageRoot, build: false })).toThrow(
      /must match root/
    )
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false)
  })

  it('rejects undeclared runtime dependencies and removes the partial payload', async () => {
    const { root, packageRoot } = fixture()
    writeFileSync(
      join(root, 'out', 'host', 'host-node', 'provider.js'),
      'require("unexpected-runtime")\n'
    )
    const { prepareCliPackage } = await import('./prepare-cli-package.cjs')
    expect(() => prepareCliPackage({ repoRoot: root, packageRoot, build: false })).toThrow(
      /undeclared external modules: unexpected-runtime/
    )
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false)
  })

  it('refuses to clean through a symlinked dist directory', async () => {
    const { root, packageRoot } = fixture()
    const target = mkdtempSync(join(tmpdir(), 'taskwraith-cli-package-target-'))
    roots.push(target)
    writeFileSync(join(target, 'preserved'), 'keep')
    symlinkSync(target, join(packageRoot, 'dist'))
    chmodSync(target, 0o700)

    const { cleanCliPackage } = await import('./prepare-cli-package.cjs')
    expect(() => cleanCliPackage({ repoRoot: root, packageRoot })).toThrow(/plain directory/)
    expect(readFileSync(join(target, 'preserved'), 'utf8')).toBe('keep')
  })
})

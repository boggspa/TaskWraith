import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { resolveBuilderArgs } = require('./run-electron-builder.cjs') as {
  resolveBuilderArgs: (args: string[], root: string) => string[]
}
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const roots: string[] = []

function source(version: string, distribution: string): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-build-identity-'))
  roots.push(root)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ version, taskwraithRelease: { distribution } })
  )
  for (const file of [
    'electron-builder.yml',
    'electron-builder.release.yml',
    'electron-builder.debut.yml'
  ]) {
    writeFileSync(join(root, file), readFileSync(join(repoRoot, file)))
  }
  mkdirSync(join(root, 'resources'))
  writeFileSync(
    join(root, 'resources/identity-handoff.json'),
    readFileSync(join(repoRoot, 'resources/identity-handoff.json'))
  )
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaging distribution selection', () => {
  it('packages the final beta from the declared legacy identity', () => {
    expect(resolveBuilderArgs(['--mac', '--publish', 'never'], source('1.9.9', 'beta'))).toEqual([
      '--mac',
      '--publish',
      'never',
      '--config',
      'electron-builder.yml'
    ])
  })

  it.each(['0.1.1', '1.0.0', '2.0.0'])(
    'keeps the public identity after an ordinary bump to %s',
    (version) => {
      expect(resolveBuilderArgs(['--win', '--x64'], source(version, 'release'))).toEqual([
        '--win',
        '--x64',
        '--config',
        'electron-builder.release.yml'
      ])
    }
  )

  it('keeps property overrides while selecting the public configuration', () => {
    expect(
      resolveBuilderArgs(['--mac', '-c.mac.notarize=true'], source('0.1.1', 'release'))
    ).toEqual(['--mac', '-c.mac.notarize=true', '--config', 'electron-builder.release.yml'])
  })

  it.each([
    ['--config', 'electron-builder.debut.yml'],
    ['--config=electron-builder.debug.yml'],
    ['-c', 'electron-builder.debut.yml'],
    ['-c=electron-builder.debug.yml']
  ])('preserves the explicit configuration in %j', (...args) => {
    expect(resolveBuilderArgs(args, source('1.9.9', 'beta'))).toEqual(args)
  })

  it('refuses a debut package before the frozen source version is declared', () => {
    expect(() =>
      resolveBuilderArgs(['--config', 'electron-builder.debut.yml'], source('1.9.8', 'beta'))
    ).toThrow()
  })

  it('rejects a missing explicit configuration without starting a packager', () => {
    expect(() => resolveBuilderArgs(['--config', '--mac'], '/not-read')).toThrow(
      'A builder config path is required.'
    )
  })

  it('rejects an unknown distribution before spawning a packager', () => {
    expect(() => resolveBuilderArgs(['--mac'], source('0.1.1', 'typo'))).toThrow()
  })
})

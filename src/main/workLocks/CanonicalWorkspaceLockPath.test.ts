import * as fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CanonicalWorkspaceLockPathError,
  type CanonicalWorkspaceLockPathFs,
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'

const temporaryPaths: string[] = []

function canonicalRealpath(path: string): string {
  const realpath =
    typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync
  return realpath(path)
}

function temporaryDirectory(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `taskwraith-lock-path-${label}-`))
  temporaryPaths.push(path)
  return path
}

function directorySymlink(target: string, path: string): void {
  fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    fs.rmSync(path, { recursive: true, force: true })
  }
})

describe('CanonicalWorkspaceLockPath', () => {
  it('coalesces a symlink alias with its physical target', () => {
    const root = temporaryDirectory('symlink-alias')
    const physicalDirectory = join(root, 'physical')
    const aliasDirectory = join(root, 'alias')
    fs.mkdirSync(physicalDirectory)
    fs.writeFileSync(join(physicalDirectory, 'file.ts'), 'export {}\n')
    directorySymlink(physicalDirectory, aliasDirectory)

    const physical = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: join(physicalDirectory, 'file.ts')
    })
    const alias = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: join(aliasDirectory, 'file.ts')
    })

    expect(alias.canonicalPath).toBe(physical.canonicalPath)
    expect(alias.physicalIdentity).toBe(physical.physicalIdentity)
    expect(alias.containment.relativeTargetPath).toBe('physical/file.ts')
  })

  it('uses device and inode identity to coalesce hard-link aliases', () => {
    const root = temporaryDirectory('hardlink')
    const original = join(root, 'original.ts')
    const alias = join(root, 'alias.ts')
    fs.writeFileSync(original, 'export const value = 1\n')
    fs.linkSync(original, alias)

    const originalResolution = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: original
    })
    const aliasResolution = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: alias
    })

    expect(aliasResolution.canonicalPath).not.toBe(originalResolution.canonicalPath)
    expect(aliasResolution.targetIdentity.kind).toBe('existing')
    expect(aliasResolution.physicalIdentity).toBe(originalResolution.physicalIdentity)
  })

  it('folds case aliases only when injected filesystem behavior is insensitive', () => {
    const identities = new Map<string, { canonical: string; dev: bigint; ino: bigint }>([
      ['/', { canonical: '/', dev: 1n, ino: 1n }],
      ['/repo', { canonical: '/Repo', dev: 1n, ino: 2n }],
      ['/repo/src', { canonical: '/Repo/Src', dev: 1n, ino: 3n }]
    ])
    const fakeFs: CanonicalWorkspaceLockPathFs = {
      realpathSync: (path) => {
        const entry = identities.get(path.toLocaleLowerCase('en-US'))
        if (!entry) throw missingPath(path)
        return entry.canonical
      },
      lstatSync: (path) => {
        const entry = identities.get(path.toLocaleLowerCase('en-US'))
        if (!entry) throw missingPath(path)
        return { dev: entry.dev, ino: entry.ino }
      }
    }

    const upper = resolveCanonicalWorkspaceLockPath({
      rootPath: '/Repo',
      targetPath: '/Repo/Src/New/File.ts',
      pathFlavor: 'posix',
      caseSensitive: false,
      fs: fakeFs
    })
    const lower = resolveCanonicalWorkspaceLockPath({
      rootPath: '/repo',
      targetPath: '/repo/src/new/file.ts',
      pathFlavor: 'posix',
      caseSensitive: false,
      fs: fakeFs
    })

    expect(upper.comparisonPath).toBe('/repo/src/new/file.ts')
    expect(upper.canonicalPath).toBe('/Repo/Src/New/File.ts')
    expect(lower.comparisonPath).toBe(upper.comparisonPath)
    expect(lower.physicalIdentity).toBe(upper.physicalIdentity)
    expect(
      resolveCanonicalWorkspaceLockPath({
        rootPath: '/repo',
        targetPath: '/repo/src/new/file.ts',
        pathFlavor: 'posix',
        caseSensitive: true,
        fs: fakeFs
      }).comparisonPath
    ).not.toBe(upper.comparisonPath)
  })

  it('preserves executable path case on an injected case-sensitive filesystem', () => {
    const root = temporaryDirectory('case-sensitive-macos')
    const mixedDirectory = join(root, 'MiXeD')
    const mixedFile = join(mixedDirectory, 'TaRgEt.ts')
    fs.mkdirSync(mixedDirectory)
    fs.writeFileSync(mixedFile, 'export const exact = true\n')

    const resolution = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: mixedFile,
      caseSensitive: true
    })

    expect(resolution.canonicalPath).toBe(canonicalRealpath(mixedFile))
    expect(resolution.comparisonPath).toBe(resolution.canonicalPath)
    expect(resolution.canonicalPath.replace(/\\/g, '/').endsWith('/MiXeD/TaRgEt.ts')).toBe(true)
  })

  it('derives a planned identity from the deepest existing physical ancestor', () => {
    const root = temporaryDirectory('planned')
    const existingDirectory = join(root, 'src')
    fs.mkdirSync(existingDirectory)
    const target = join(existingDirectory, 'nested', 'future.ts')

    const resolution = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: target
    })

    expect(resolution.targetExists).toBe(false)
    expect(resolution.targetIdentity).toMatchObject({
      kind: 'planned',
      normalizedSuffix: 'nested/future.ts'
    })
    expect(resolution.containment.existingAncestorCanonicalPath).toBe(
      canonicalRealpath(existingDirectory)
    )
    expect(resolution.canonicalPath).toBe(
      join(canonicalRealpath(existingDirectory), 'nested', 'future.ts')
    )
  })

  it('rejects lexical and symlink escapes from the selected root', () => {
    const parent = temporaryDirectory('escape')
    const root = join(parent, 'workspace')
    const outside = join(parent, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'secret.ts'), 'secret\n')
    directorySymlink(outside, join(root, 'escape'))

    expect(() =>
      resolveCanonicalWorkspaceLockPath({
        rootPath: root,
        targetPath: '../outside/secret.ts'
      })
    ).toThrowError(
      expect.objectContaining<Partial<CanonicalWorkspaceLockPathError>>({
        code: 'outside_root'
      })
    )
    expect(() =>
      resolveCanonicalWorkspaceLockPath({
        rootPath: root,
        targetPath: join(root, 'escape', 'secret.ts')
      })
    ).toThrow('resolves outside')

    fs.symlinkSync(join(outside, 'missing-directory'), join(root, 'dangling'))
    expect(() =>
      resolveCanonicalWorkspaceLockPath({
        rootPath: root,
        targetPath: join(root, 'dangling', 'future.ts')
      })
    ).toThrow(/dangling or unresolvable/i)
  })

  it('preserves trailing-space filename bytes instead of aliasing a sibling', () => {
    const root = temporaryDirectory('trailing-space')
    const plain = join(root, 'file.ts')
    const spaced = join(root, 'file.ts ')
    fs.writeFileSync(plain, 'plain\n')
    fs.writeFileSync(spaced, 'spaced\n')

    const plainResolution = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: plain
    })
    const spacedResolution = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: spaced
    })

    expect(spacedResolution.canonicalPath.endsWith('file.ts ')).toBe(true)
    expect(spacedResolution.canonicalPath).not.toBe(plainResolution.canonicalPath)
    expect(spacedResolution.physicalIdentity).not.toBe(plainResolution.physicalIdentity)
  })

  it('rejects an ancestor symlink swap when re-verifying before commit', () => {
    const root = temporaryDirectory('swap')
    const first = join(root, 'first')
    const second = join(root, 'second')
    const alias = join(root, 'current')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    directorySymlink(first, alias)

    const acquired = resolveCanonicalWorkspaceLockPath({
      rootPath: root,
      targetPath: join(alias, 'nested', 'future.ts')
    })
    fs.unlinkSync(alias)
    directorySymlink(second, alias)

    const verification = verifyCanonicalWorkspaceLockPath(acquired)
    expect(verification).toMatchObject({
      ok: false,
      reason: 'changed',
      changedFields: expect.arrayContaining([
        'canonicalTargetPath',
        'physicalIdentity',
        'existingAncestorCanonicalPath',
        'existingAncestorIdentity'
      ])
    })
  })

  it('rejects a selected workspace-root symlink swap before commit', () => {
    const parent = temporaryDirectory('root-swap')
    const first = join(parent, 'first-workspace')
    const second = join(parent, 'second-workspace')
    const selected = join(parent, 'selected-workspace')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    fs.writeFileSync(join(first, 'file.ts'), 'first\n')
    fs.writeFileSync(join(second, 'file.ts'), 'second\n')
    directorySymlink(first, selected)

    const acquired = resolveCanonicalWorkspaceLockPath({
      rootPath: selected,
      targetPath: join(selected, 'file.ts')
    })
    fs.unlinkSync(selected)
    directorySymlink(second, selected)

    expect(verifyCanonicalWorkspaceLockPath(acquired)).toMatchObject({
      ok: false,
      reason: 'changed',
      changedFields: expect.arrayContaining([
        'canonicalRootPath',
        'rootIdentity',
        'canonicalTargetPath',
        'physicalIdentity'
      ])
    })
  })
})

function missingPath(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

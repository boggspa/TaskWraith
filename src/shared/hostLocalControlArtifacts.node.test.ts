import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  publishPrivateLocalControlArtifact,
  readPrivateLocalControlArtifact,
  removeOwnedPrivateLocalControlArtifact
} from './hostLocalControlArtifacts.node'

const paths: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'host-local-artifact-'))
  paths.push(path)
  return path
}

afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

describe('host local-control artifacts', () => {
  it('atomically publishes/reads owner-only artifacts and removes only its exact inode', () => {
    const path = join(directory(), 'token')
    const ownership = publishPrivateLocalControlArtifact(path, 'token-value\n', 128)
    expect(readPrivateLocalControlArtifact(path, 128)).toBe('token-value\n')
    const successor = join(directory(), 'successor')
    writeFileSync(successor, 'successor\n', { mode: 0o600 })
    renameSync(successor, path)
    removeOwnedPrivateLocalControlArtifact(ownership)
    expect(readPrivateLocalControlArtifact(path, 128)).toBe('successor\n')
  })

  it('rejects symlink, loose-mode, and oversized artifacts', () => {
    const root = directory()
    const target = join(root, 'target')
    const artifact = join(root, 'artifact')
    writeFileSync(target, 'token\n', { mode: 0o600 })
    symlinkSync(target, artifact)
    expect(() => readPrivateLocalControlArtifact(artifact, 128)).toThrow('unsafe')
    rmSync(artifact)
    writeFileSync(artifact, 'token\n', { mode: 0o644 })
    chmodSync(artifact, 0o644)
    expect(() => readPrivateLocalControlArtifact(artifact, 128)).toThrow('owner-only')
    chmodSync(artifact, 0o600)
    writeFileSync(artifact, 'x'.repeat(129), { mode: 0o600 })
    expect(() => readPrivateLocalControlArtifact(artifact, 128)).toThrow('size')
  })

  it('propagates exact-owned unlink failures during direct and post-rename cleanup', () => {
    const root = directory()
    const path = join(root, 'token')
    const ownership = publishPrivateLocalControlArtifact(path, 'token\n', 128)
    expect(() =>
      removeOwnedPrivateLocalControlArtifact(ownership, () => {
        throw new Error('owned unlink failed')
      })
    ).toThrow('owned unlink failed')
    expect(readPrivateLocalControlArtifact(path, 128)).toBe('token\n')

    expect(() =>
      publishPrivateLocalControlArtifact(path, 'next\n', 128, {
        afterRename: () => {
          throw new Error('post-rename failure')
        },
        unlink: () => {
          throw new Error('post-rename owned unlink failed')
        }
      })
    ).toThrow('post-rename owned unlink failed')
    expect(readPrivateLocalControlArtifact(path, 128)).toBe('next\n')
  })
})

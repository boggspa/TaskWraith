import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  readScopedDirectory,
  readScopedRegularFile,
  ScopedPathTargetMissingError,
  setScopedPathAccessTestHookForTests,
  updateScopedUtf8File,
  writeScopedUtf8FileWithLegacyCreate
} from './ScopedPathAccess'

const tempPaths: string[] = []

function tempDir(prefix: string): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempPaths.push(result)
  return result
}

afterEach(() => {
  setScopedPathAccessTestHookForTests(undefined)
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true })
  }
})

describe('ScopedPathAccess', () => {
  it('reads a regular file through a stable nofollow descriptor', async () => {
    const rootPath = tempDir('tw-scoped-read-')
    const targetPath = path.join(rootPath, 'notes.txt')
    fs.writeFileSync(targetPath, 'safe text')

    const result = await readScopedRegularFile(
      { rootPath, targetPath },
      { maxBytes: 100 }
    )

    expect(result.buffer.toString('utf8')).toBe('safe text')
  })

  it('denies a parent symlink swap before returning file bytes', async () => {
    const rootPath = tempDir('tw-scoped-read-root-')
    const outside = tempDir('tw-scoped-read-outside-')
    const parentPath = path.join(rootPath, 'nested')
    const originalParent = path.join(rootPath, 'nested-original')
    const targetPath = path.join(parentPath, 'secret.txt')
    fs.mkdirSync(parentPath)
    fs.writeFileSync(targetPath, 'workspace bytes')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside bytes')
    setScopedPathAccessTestHookForTests((stage) => {
      if (stage !== 'after_directory_snapshot') return
      fs.renameSync(parentPath, originalParent)
      fs.symlinkSync(outside, parentPath, 'dir')
    })

    await expect(
      readScopedRegularFile({ rootPath, targetPath }, { maxBytes: 100 })
    ).rejects.toThrow()
  })

  it('denies a directory swap before returning entries', async () => {
    const rootPath = tempDir('tw-scoped-list-root-')
    const outside = tempDir('tw-scoped-list-outside-')
    const targetPath = path.join(rootPath, 'nested')
    const originalTarget = path.join(rootPath, 'nested-original')
    fs.mkdirSync(targetPath)
    fs.writeFileSync(path.join(targetPath, 'inside.txt'), 'inside')
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside')
    setScopedPathAccessTestHookForTests((stage) => {
      if (stage !== 'after_directory_snapshot') return
      fs.renameSync(targetPath, originalTarget)
      fs.symlinkSync(outside, targetPath, 'dir')
    })

    await expect(readScopedDirectory({ rootPath, targetPath })).rejects.toThrow()
  })

  it('denies a parent swap before an existing write or replace mutates bytes', async () => {
    const rootPath = tempDir('tw-scoped-write-root-')
    const outside = tempDir('tw-scoped-write-outside-')
    const parentPath = path.join(rootPath, 'nested')
    const originalParent = path.join(rootPath, 'nested-original')
    const targetPath = path.join(parentPath, 'notes.txt')
    const outsideTarget = path.join(outside, 'notes.txt')
    fs.mkdirSync(parentPath)
    fs.writeFileSync(targetPath, 'replace OLD')
    fs.writeFileSync(outsideTarget, 'outside OLD')
    setScopedPathAccessTestHookForTests((stage) => {
      if (stage !== 'before_write_commit') return
      fs.renameSync(parentPath, originalParent)
      fs.symlinkSync(outside, parentPath, 'dir')
    })

    await expect(
      updateScopedUtf8File(
        { rootPath, targetPath },
        { maxBytes: 100, update: (current) => current.replace('OLD', 'NEW') }
      )
    ).rejects.toThrow()
    expect(fs.readFileSync(path.join(originalParent, 'notes.txt'), 'utf8')).toBe('replace OLD')
    expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('outside OLD')
  })

  it('restores prior bytes on the same descriptor when a commit fails after truncate', async () => {
    const rootPath = tempDir('tw-scoped-write-rollback-')
    const targetPath = path.join(rootPath, 'notes.txt')
    fs.writeFileSync(targetPath, 'original bytes')
    setScopedPathAccessTestHookForTests((stage) => {
      if (stage === 'after_write_truncate') {
        const error = new Error('simulated ENOSPC') as NodeJS.ErrnoException
        error.code = 'ENOSPC'
        throw error
      }
    })

    await expect(
      updateScopedUtf8File(
        { rootPath, targetPath },
        { maxBytes: 100, update: () => 'replacement bytes' }
      )
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('original bytes')
  })

  it('reports a missing target without creating an artifact in the descriptor-safe updater', async () => {
    const rootPath = tempDir('tw-scoped-new-file-')
    const targetPath = path.join(rootPath, 'new.txt')

    await expect(
      updateScopedUtf8File(
        { rootPath, targetPath },
        { maxBytes: 100, update: () => 'new content' }
      )
    ).rejects.toBeInstanceOf(ScopedPathTargetMissingError)
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('preserves brokered write_file creation semantics, including missing parents', async () => {
    const rootPath = tempDir('tw-scoped-new-parent-')
    const targetPath = path.join(rootPath, 'missing', 'nested', 'new.txt')

    const result = await writeScopedUtf8FileWithLegacyCreate(
      { rootPath, targetPath },
      { maxBytes: 100, content: 'new content' }
    )

    expect(result.created).toBe(true)
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('new content')
  })

  it.each([
    ['oversized content', 'x'.repeat(101)],
    ['NUL content', 'before\0after'],
    ['malformed Unicode content', '\ud800']
  ])('rejects %s before creating a new file', async (_label, content) => {
    const rootPath = tempDir('tw-scoped-invalid-create-')
    const targetPath = path.join(rootPath, 'nested', 'new.txt')

    await expect(
      writeScopedUtf8FileWithLegacyCreate(
        { rootPath, targetPath },
        { maxBytes: 100, content }
      )
    ).rejects.toThrow()
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('denies a created-parent swap before opening a new file leaf', async () => {
    const rootPath = tempDir('tw-scoped-create-swap-root-')
    const outside = tempDir('tw-scoped-create-swap-outside-')
    const parentPath = path.join(rootPath, 'missing')
    const originalParent = path.join(rootPath, 'missing-original')
    const targetPath = path.join(parentPath, 'nested', 'new.txt')
    const outsideNested = path.join(outside, 'nested')
    fs.mkdirSync(outsideNested)
    setScopedPathAccessTestHookForTests((stage) => {
      if (stage !== 'after_directory_snapshot') return
      fs.renameSync(parentPath, originalParent)
      fs.symlinkSync(outside, parentPath, 'dir')
    })

    await expect(
      writeScopedUtf8FileWithLegacyCreate(
        { rootPath, targetPath },
        { maxBytes: 100, content: 'new content' }
      )
    ).rejects.toThrow()
    expect(fs.existsSync(path.join(outsideNested, 'new.txt'))).toBe(false)
  })
})

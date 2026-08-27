import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  readScopedDirectory,
  readScopedRegularFile,
  readScopedRegularFileLineWindow,
  ScopedPathTargetMissingError,
  setScopedPathAccessTestHookForTests,
  updateScopedUtf8File,
  writeScopedUtf8FileWithLegacyCreate
} from './ScopedPathAccess'

const tempPaths: string[] = []

// realpathSync() expands the temp root up front (e.g. Windows 8.3 short names
// like C:\Users\RUNNER~1, macOS /var -> /private/var) so test paths match the
// product's realpath-canonicalized root exactly.
const tempRoot = fs.realpathSync(os.tmpdir())

function tempDir(prefix: string): string {
  const result = fs.mkdtempSync(path.join(tempRoot, prefix))
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

  // S4 — the streaming line-window read opens its OWN descriptor, so the jail
  // has to hold there independently. The contract test pins that the guard
  // CALLS are present; these prove the guards actually REFUSE. A source pin
  // alone would still pass if a guard were called with the wrong argument.
  it('serves a bounded line window through a stable nofollow descriptor', async () => {
    const rootPath = tempDir('tw-scoped-window-')
    const targetPath = path.join(rootPath, 'notes.txt')
    fs.writeFileSync(targetPath, 'one\ntwo\nthree\nfour\nfive')

    const result = await readScopedRegularFileLineWindow(
      { rootPath, targetPath },
      { startLine: 2, maxLines: 2 },
      { maxWindowBytes: 100 }
    )

    expect(result.window.toString('utf8')).toBe('two\nthree')
    expect(result.totalLines).toBe(5)
    expect(result.endLine).toBe(3)
  })

  it('denies a parent symlink swap before returning window bytes', async () => {
    const rootPath = tempDir('tw-scoped-window-root-')
    const outside = tempDir('tw-scoped-window-outside-')
    const parentPath = path.join(rootPath, 'nested')
    const originalParent = path.join(rootPath, 'nested-original')
    const targetPath = path.join(parentPath, 'secret.txt')
    fs.mkdirSync(parentPath)
    fs.writeFileSync(targetPath, 'workspace bytes\nsecond line')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside bytes\nsecond line')
    setScopedPathAccessTestHookForTests((stage) => {
      if (stage !== 'after_directory_snapshot') return
      fs.renameSync(parentPath, originalParent)
      fs.symlinkSync(outside, parentPath, 'dir')
    })

    await expect(
      readScopedRegularFileLineWindow(
        { rootPath, targetPath },
        { startLine: 1, maxLines: 5 },
        { maxWindowBytes: 100 }
      )
    ).rejects.toThrow()
  })

  it('refuses a line-window target outside the authorized root', async () => {
    const rootPath = tempDir('tw-scoped-window-jail-')
    const outside = tempDir('tw-scoped-window-escape-')
    const targetPath = path.join(outside, 'secret.txt')
    fs.writeFileSync(targetPath, 'outside bytes')

    // Vacuity guard: the file really is readable, so the refusal below is the
    // jail refusing, not a missing fixture quietly passing the assertion.
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('outside bytes')

    await expect(
      readScopedRegularFileLineWindow(
        { rootPath, targetPath },
        { startLine: 1, maxLines: 1 },
        { maxWindowBytes: 100 }
      )
    ).rejects.toThrow('outside the authorized filesystem root')
    // Parity: the window path must be no weaker than the buffered path.
    await expect(
      readScopedRegularFile({ rootPath, targetPath }, { maxBytes: 100 })
    ).rejects.toThrow('outside the authorized filesystem root')
  })

  it('refuses a symlinked line-window target instead of following it', async () => {
    const rootPath = tempDir('tw-scoped-window-link-')
    const outside = tempDir('tw-scoped-window-linked-')
    const realPath = path.join(outside, 'secret.txt')
    const linkPath = path.join(rootPath, 'alias.txt')
    fs.writeFileSync(realPath, 'outside bytes')
    fs.symlinkSync(realPath, linkPath, 'file')

    // Vacuity guard: following the link WOULD leak the outside bytes.
    expect(fs.readFileSync(linkPath, 'utf8')).toBe('outside bytes')

    await expect(
      readScopedRegularFileLineWindow(
        { rootPath, targetPath: linkPath },
        { startLine: 1, maxLines: 1 },
        { maxWindowBytes: 100 }
      )
    ).rejects.toThrow()
    // Parity with the buffered reader on the same fixture.
    await expect(
      readScopedRegularFile({ rootPath, targetPath: linkPath }, { maxBytes: 100 })
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

  // The swap simulation renames a directory that has an open descriptor
  // inside it — Windows EPERMs that rename, so the scenario is POSIX-only
  // (the no-open-handle swap siblings still run on Windows).
  it.skipIf(process.platform === 'win32')(
    'denies a parent swap before an existing write or replace mutates bytes',
    async () => {
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

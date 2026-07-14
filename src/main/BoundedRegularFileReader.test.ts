import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { constants } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readBoundedRegularFile,
  readBoundedRegularFileHandle
} from './BoundedRegularFileReader'

const tempPaths: string[] = []

function makeTempDir(): string {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-bounded-read-'))
  tempPaths.push(tempPath)
  return tempPath
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true })
  }
})

describe('readBoundedRegularFile', () => {
  it('reads an exact-limit regular file from its opened descriptor', async () => {
    const target = path.join(makeTempDir(), 'audit.json')
    fs.writeFileSync(target, '12345678')

    const raw = await readBoundedRegularFile(target, { maxBytes: 8 })

    expect(raw.toString('utf8')).toBe('12345678')
  })

  it('rejects a final-component symlink without following it', async () => {
    const dir = makeTempDir()
    const target = path.join(dir, 'real.json')
    const alias = path.join(dir, 'alias.json')
    fs.writeFileSync(target, '{}')
    fs.symlinkSync(target, alias, 'file')

    await expect(
      readBoundedRegularFile(alias, {
        maxBytes: 1024,
        regularFileErrorMessage: 'Audit bundle verification requires a regular file.'
      })
    ).rejects.toThrow('Audit bundle verification requires a regular file.')
  })

  it('rejects directories and other non-regular files', async () => {
    const target = makeTempDir()

    await expect(
      readBoundedRegularFile(target, {
        maxBytes: 1024,
        regularFileErrorMessage: 'regular files only'
      })
    ).rejects.toThrow('regular files only')
  })

  it('enforces the configured size bound using the opened descriptor stat', async () => {
    const target = path.join(makeTempDir(), 'oversize.json')
    fs.writeFileSync(target, '123456789')

    await expect(
      readBoundedRegularFile(target, {
        maxBytes: 8,
        sizeLimitErrorMessage: 'audit bundle is too large'
      })
    ).rejects.toThrow('audit bundle is too large')
  })

  it('rejects an invalid byte limit before opening the path', async () => {
    await expect(
      readBoundedRegularFile('/path/need/not/exist', { maxBytes: Number.NaN })
    ).rejects.toThrow('non-negative safe-integer byte limit')
  })
})

describe('readBoundedRegularFileHandle', () => {
  it('reads the opened inode after its path is replaced', async () => {
    const dir = makeTempDir()
    const target = path.join(dir, 'audit.json')
    const original = path.join(dir, 'original.json')
    fs.writeFileSync(target, 'original bundle')
    const fileHandle = await fs.promises.open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW
    )

    try {
      fs.renameSync(target, original)
      fs.writeFileSync(target, 'replacement bundle')

      const raw = await readBoundedRegularFileHandle(fileHandle, { maxBytes: 64 })

      expect(raw.toString('utf8')).toBe('original bundle')
    } finally {
      await fileHandle.close()
    }
  })

  it('probes no more than one byte beyond the configured bound', async () => {
    const reads: number[] = []
    const fileHandle = {
      stat: async () => ({
        isFile: () => true,
        size: 4n,
        dev: 1n,
        ino: 2n
      }),
      read: async (_buffer: Buffer, _offset: number, length: number) => {
        reads.push(length)
        return { bytesRead: length, buffer: _buffer }
      }
    }

    await expect(
      readBoundedRegularFileHandle(fileHandle as never, {
        maxBytes: 4,
        sizeLimitErrorMessage: 'too large'
      })
    ).rejects.toThrow('too large')
    expect(reads).toEqual([5])
  })
})

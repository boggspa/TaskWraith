import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { constants } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatReadFileLineWindow,
  readBoundedLineWindowHandle,
  readBoundedRegularFile,
  readBoundedRegularFileHandle,
  resolveReadFileLineWindowRequest
} from './BoundedRegularFileReader'
import { windowReadFileText } from './mcp/ReadFileWindow'

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

// ── S4: read_file's documented remedy must actually work ───────────────────

async function streamWindowText(
  target: string,
  args: { offset?: unknown; limit?: unknown },
  maxWindowBytes = 1_000_000
): Promise<string | null> {
  const request = resolveReadFileLineWindowRequest(args)
  if (!request) return null
  const fileHandle = await fs.promises.open(target, constants.O_RDONLY)
  try {
    const result = await readBoundedLineWindowHandle(fileHandle, request, { maxWindowBytes })
    return formatReadFileLineWindow({
      windowText: result.window.toString('utf8'),
      startLine: result.startLine,
      endLine: result.endLine,
      totalLines: result.totalLines
    })
  } finally {
    await fileHandle.close()
  }
}

describe('readBoundedLineWindowHandle', () => {
  it('serves a window from a file that the whole-file cap refuses outright', async () => {
    // This IS the S4 bug: read_file tells agents to pass offset/limit for a
    // large file, then rejects the whole file before windowing ever runs.
    const target = path.join(makeTempDir(), 'monolith.ts')
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1} ${'x'.repeat(80)}`)
    fs.writeFileSync(target, lines.join('\n'))

    await expect(
      readBoundedRegularFile(target, {
        maxBytes: 1_000,
        sizeLimitErrorMessage: 'File is too large to read through the MCP bridge.'
      })
    ).rejects.toThrow('File is too large to read through the MCP bridge.')

    const fileHandle = await fs.promises.open(target, constants.O_RDONLY)
    try {
      const result = await readBoundedLineWindowHandle(
        fileHandle,
        { startLine: 300, maxLines: 3 },
        { maxWindowBytes: 1_000 }
      )
      expect(result.totalLines).toBe(400)
      expect(result.startLine).toBe(300)
      expect(result.endLine).toBe(302)
      expect(result.truncated).toBe(false)
      expect(result.window.toString('utf8').split('\n')).toEqual([
        lines[299],
        lines[300],
        lines[301]
      ])
    } finally {
      await fileHandle.close()
    }
  })

  it('matches the whole-file path byte-for-byte across window shapes', async () => {
    // Anti-drift: two read paths now answer the same question, so they must
    // never disagree. If ReadFileWindow.ts changes, this goes red.
    const contents = ['a\nb\nc\nd\ne', 'a\nb\nc\n', '', 'single line, no newline', 'x\n\ny']
    const argShapes: Array<{ offset?: number; limit?: number }> = [
      { offset: 2 },
      { limit: 2 },
      { offset: 2, limit: 2 },
      { offset: 1, limit: 1 },
      { offset: 3, limit: 100 },
      { offset: 99 }
    ]

    const dir = makeTempDir()
    for (const [contentIndex, content] of contents.entries()) {
      const target = path.join(dir, `sample-${contentIndex}.txt`)
      fs.writeFileSync(target, content)
      for (const args of argShapes) {
        const streamed = await streamWindowText(target, args)
        const wholeFile = windowReadFileText(content, args)
        expect(streamed, `${JSON.stringify({ content, args })}`).toBe(wholeFile)
      }
    }
  })

  it('leaves whole-file reads alone: no offset and no limit is not a window', () => {
    expect(resolveReadFileLineWindowRequest({})).toBeNull()
    expect(resolveReadFileLineWindowRequest({ offset: 0, limit: 0 })).toBeNull()
    expect(resolveReadFileLineWindowRequest({ offset: 'nonsense' })).toBeNull()
  })

  it('clamps a runaway limit and defaults an offset-only window', () => {
    expect(resolveReadFileLineWindowRequest({ offset: 5, limit: 10_000_000 })).toEqual({
      startLine: 5,
      maxLines: 5_000
    })
    expect(resolveReadFileLineWindowRequest({ offset: 5 })).toEqual({
      startLine: 5,
      maxLines: 2_000
    })
  })

  it('caps the returned window and reports the truncation', async () => {
    const target = path.join(makeTempDir(), 'wide.txt')
    fs.writeFileSync(target, ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'].join('\n'))
    const fileHandle = await fs.promises.open(target, constants.O_RDONLY)
    try {
      const result = await readBoundedLineWindowHandle(
        fileHandle,
        { startLine: 1, maxLines: 3 },
        { maxWindowBytes: 12 }
      )
      expect(result.truncated).toBe(true)
      expect(result.window.length).toBe(12)
      expect(result.totalLines).toBe(3)
    } finally {
      await fileHandle.close()
    }
  })

  it('refuses to scan an unbounded file instead of reading it', async () => {
    const fileHandle = {
      stat: async () => ({ isFile: () => true, size: BigInt(64 * 1024 * 1024 + 1) }),
      read: async () => {
        throw new Error('the scan gate must fire before any read')
      }
    }

    await expect(
      readBoundedLineWindowHandle(
        fileHandle as never,
        { startLine: 1, maxLines: 10 },
        { maxWindowBytes: 1_000, scanLimitErrorMessage: 'too large to scan' }
      )
    ).rejects.toThrow('too large to scan')
  })

  it('rejects a non-regular opened target', async () => {
    const fileHandle = {
      stat: async () => ({ isFile: () => false, size: 0n }),
      read: async () => ({ bytesRead: 0 })
    }

    await expect(
      readBoundedLineWindowHandle(
        fileHandle as never,
        { startLine: 1, maxLines: 1 },
        { maxWindowBytes: 10, regularFileErrorMessage: 'regular files only' }
      )
    ).rejects.toThrow('regular files only')
  })
})

describe('scoped line-window read keeps the whole-file security sequence', () => {
  // The window path opens its own descriptor, so it must repeat EVERY guard the
  // whole-file read performs. Asserted on source because the alternative is
  // discovering a dropped identity check by reading a file outside the jail.
  const scopedSource = fs.readFileSync(new URL('./ScopedPathAccess.ts', import.meta.url), 'utf8')
  const windowReader = scopedSource.slice(
    scopedSource.indexOf('export async function readScopedRegularFileLineWindow('),
    scopedSource.indexOf('export async function readScopedDirectory(')
  )

  it('repeats every guard the buffered read performs', () => {
    expect(windowReader.length).toBeGreaterThan(0)
    for (const guard of [
      'normalizeAuthority(authority, false)',
      'snapshotDirectoryChain(rootPath, dirname(targetPath))',
      'requireRegularTarget(targetPath)',
      'openNoFollow(targetPath, constants.O_RDONLY)',
      'requireOpenedTarget(',
      'assertDirectoryChainStable(directorySnapshot)',
      'assertPathMatchesOpenedFile(targetPath, openedStat)',
      'fileHandle.close()'
    ]) {
      expect(windowReader, guard).toContain(guard)
    }
  })

  it('never widens the byte cap that protects the bridge', () => {
    // The window is bounded by construction; the cap must not be raised to
    // make large reads "work".
    expect(scopedSource).not.toContain('MAX_EDITOR_FILE_BYTES')
    expect(windowReader).toContain('maxWindowBytes: options.maxWindowBytes')
  })
})

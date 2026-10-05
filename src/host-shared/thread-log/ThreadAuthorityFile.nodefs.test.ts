/**
 * The steps the authority file takes on the real filesystem. The crash cases
 * prove the order of the steps on a disk in memory; this proves that each step
 * of the real one does what its name says, a sync above all, by recording the
 * calls that reach Node's promise filesystem.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode)
    calls.push(
      `open ${String(file)} ${String(flags)}${mode === undefined ? '' : ` ${mode.toString(8)}`}`
    )
    const sync = handle.sync.bind(handle)
    const close = handle.close.bind(handle)
    if (String(file).endsWith('in-pieces.txt')) {
      // A system that hands a file over one byte at a time.
      const read = handle.read.bind(handle)
      handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
        read(buffer, offset, Math.min(length, 1), position)) as typeof handle.read
    }
    handle.sync = async () => {
      calls.push(`sync ${String(file)}`)
      await sync()
    }
    handle.close = async () => {
      calls.push(`close ${String(file)}`)
      await close()
    }
    return handle
  }
  const mkdir = (async (directory: string, options: unknown) => {
    calls.push(`mkdir ${directory} ${JSON.stringify(options)}`)
    return actual.mkdir(directory, options as Parameters<typeof actual.mkdir>[1])
  }) as typeof actual.mkdir
  const rename: typeof actual.rename = async (from, to) => {
    calls.push(`rename ${String(from)} -> ${String(to)}`)
    await actual.rename(from, to)
  }
  const unlink: typeof actual.unlink = async (file) => {
    calls.push(`unlink ${String(file)}`)
    await actual.unlink(file)
  }
  return {
    ...actual,
    default: { ...actual, open, mkdir, rename, unlink },
    open,
    mkdir,
    rename,
    unlink
  }
})

import {
  NODE_THREAD_AUTHORITY_FS,
  ThreadAuthorityFiles,
  threadAuthorityDirectory,
  threadAuthorityFilePath,
  type ThreadAuthorityRecord
} from './ThreadAuthorityFile'

const PREFIX = 'owner-thread-authority-node-'
const roots: string[] = []

/**
 * Removes a folder this file made with mkdtemp under the temporary folder,
 * and refuses anything else.
 */
function removeTemporary(directory: string): void {
  const own = os.tmpdir() + path.sep + PREFIX
  if (
    directory === os.tmpdir() ||
    !directory.startsWith(own) ||
    directory.includes(path.sep, own.length)
  ) {
    throw new Error(`Refusing to remove ${directory}`)
  }
  fs.rmSync(directory, { recursive: true, force: true })
}

afterEach(() => {
  calls.length = 0
  while (roots.length > 0) removeTemporary(roots.pop()!)
})

function profile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  roots.push(root)
  return root
}

const RECORD: ThreadAuthorityRecord = {
  threadId: 'thread-1',
  writer: { writerId: 'writer-a', pid: 4242 },
  epoch: { host: 'host-1', grant: 3 },
  grantedAtRevision: 17,
  grantedAt: 1_780_000_000_000
}

/** Windows cannot open a directory to sync it, so no call is made for one there. */
const directorySync = (directory: string): string[] =>
  process.platform === 'win32'
    ? []
    : [`open ${directory} r`, `sync ${directory}`, `close ${directory}`]

describe('authority files on the real filesystem', () => {
  it('syncs the temporary file before the rename and the directories after it', async () => {
    const root = profile()
    const directory = threadAuthorityDirectory(root)
    const file = threadAuthorityFilePath(root, 'thread-1')
    const files = new ThreadAuthorityFiles(root)

    await files.write(RECORD)

    expect(calls).toEqual([
      `mkdir ${directory} {"recursive":true,"mode":448}`,
      ...directorySync(root),
      `open ${file}.tmp w 600`,
      `sync ${file}.tmp`,
      `close ${file}.tmp`,
      `rename ${file}.tmp -> ${file}`,
      ...directorySync(directory)
    ])
    expect(await files.read('thread-1')).toEqual({ kind: 'held', record: RECORD })
  })

  it('syncs the directory after removing the file', async () => {
    const root = profile()
    const directory = threadAuthorityDirectory(root)
    const file = threadAuthorityFilePath(root, 'thread-1')
    const files = new ThreadAuthorityFiles(root)
    await files.write(RECORD)
    calls.length = 0

    expect(await files.remove('thread-1')).toBe(true)

    expect(calls).toEqual([`unlink ${file}`, `unlink ${file}.tmp`, ...directorySync(directory)])
  })

  it('opens a file to read it, closes it, and syncs nothing; a listing syncs the directory first', async () => {
    const root = profile()
    const directory = threadAuthorityDirectory(root)
    const file = threadAuthorityFilePath(root, 'thread-1')
    const files = new ThreadAuthorityFiles(root)
    await files.write(RECORD)
    calls.length = 0

    await files.read('thread-1')
    await files.list()

    expect(calls).toEqual([
      `open ${file} r`,
      `close ${file}`,
      ...directorySync(directory),
      `open ${file} r`,
      `close ${file}`
    ])
  })

  it('reads the whole file when the system hands it over in pieces', async () => {
    const root = profile()
    const file = path.join(root, 'in-pieces.txt')
    fs.writeFileSync(file, 'abcdefghij')

    expect(await NODE_THREAD_AUTHORITY_FS.readFile(file, 64)).toBe('abcdefghij')
    expect(await NODE_THREAD_AUTHORITY_FS.readFile(file, 4)).toBe('abcd')
  })

  it('reads no more of a file than it is asked for, and closes it when the read fails', async () => {
    const root = profile()
    const file = path.join(root, 'long.txt')
    fs.writeFileSync(file, 'abcdefghij')

    expect(await NODE_THREAD_AUTHORITY_FS.readFile(file, 4)).toBe('abcd')
    expect(await NODE_THREAD_AUTHORITY_FS.readFile(file, 64)).toBe('abcdefghij')

    calls.length = 0
    fs.mkdirSync(path.join(root, 'folder'))
    await expect(NODE_THREAD_AUTHORITY_FS.readFile(path.join(root, 'folder'), 4)).rejects.toThrow()
    expect(calls.filter((call) => call.startsWith('close'))).toHaveLength(
      calls.filter((call) => call.startsWith('open')).length
    )
  })
})

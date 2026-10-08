/**
 * The power-loss double has to be right in both directions before a writer's
 * test can lean on it: it must keep what a sync made safe and nothing else.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countSyncs, watchCrashDisk, type CrashDisk } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-crash-disk-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

describe('the sync counter', () => {
  it('records Windows sync requests without pinning files or pretending to model a power cut', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    const file = path.join(root, 'old.txt')
    const replacement = path.join(root, 'replacement.txt')
    fs.writeFileSync(file, 'old')
    const disk = watchCrashDisk(root, { platform: 'win32' })
    try {
      await expect(disk.port.syncFile(file)).resolves.toBe('synced')
      fs.writeFileSync(replacement, 'new')
      fs.renameSync(replacement, file)
      const fd = fs.openSync(file, 'r+')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      expect(disk.paid).toEqual(['file:old.txt'])
      expect(disk.issued).toEqual(['file:old.txt'])
      expect(fs.readFileSync(file, 'utf8')).toBe('new')
      expect(() => disk.powerLoss()).toThrow('POSIX power-loss model is unavailable on Windows')
      expect(fs.readFileSync(file, 'utf8')).toBe('new')
    } finally {
      disk.dispose()
      removeTemporaryDirectory(root)
    }
  })

  it('counts every sync issued through node:fs, lets each one happen, and stops when it is done', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    const syncs = countSyncs()
    try {
      // Opened for writing: Windows will not flush a file opened to read.
      const fd = fs.openSync(path.join(root, 'a.txt'), 'w')
      fs.fsyncSync(fd)
      fs.fdatasyncSync(fd)
      await new Promise<void>((resolve, reject) =>
        fs.fsync(fd, (error) => (error ? reject(error) : resolve()))
      )
      await new Promise<void>((resolve, reject) =>
        fs.fdatasync(fd, (error) => (error ? reject(error) : resolve()))
      )
      fs.closeSync(fd)
      expect(syncs.issued).toEqual(['fsyncSync', 'fdatasyncSync', 'fsync', 'fdatasync'])

      // The real call still runs: it is the one that knows this descriptor is closed.
      expect(() => fs.fsyncSync(fd)).toThrow('EBADF')
      expect(syncs.issued).toHaveLength(5)

      syncs.dispose()
      expect(() => fs.fsyncSync(fd)).toThrow('EBADF')
      expect(syncs.issued).toHaveLength(5)
    } finally {
      syncs.dispose()
      removeTemporaryDirectory(root)
    }
  })
})

describe.skipIf(process.platform === 'win32')('the power-loss double', () => {
  let root: string
  let disk: CrashDisk

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    fs.writeFileSync(path.join(root, 'old.txt'), 'there before')
    disk = watchCrashDisk(root)
  })

  afterEach(() => {
    disk.dispose()
    removeTemporaryDirectory(root)
  })

  const file = (name: string): string => path.join(root, name)
  const left = (): Record<string, string> =>
    Object.fromEntries(
      fs
        .readdirSync(root)
        .sort()
        .map((name) => [name, fs.readFileSync(file(name), 'utf8')])
    )
  const syncFile = (name: string): void => {
    const fd = fs.openSync(file(name), 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }
  const syncRoot = (): void => {
    const fd = fs.openSync(root, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  it('keeps what was there when it started watching', () => {
    disk.powerLoss()
    expect(left()).toEqual({ 'old.txt': 'there before' })
  })

  it('drops a file that was written and never synced', () => {
    fs.writeFileSync(file('new.txt'), 'written')
    disk.powerLoss()
    expect(left()).toEqual({ 'old.txt': 'there before' })
  })

  it('drops a file whose bytes were synced and whose name was not', () => {
    fs.writeFileSync(file('new.txt'), 'written')
    syncFile('new.txt')
    disk.powerLoss()
    expect(left()).toEqual({ 'old.txt': 'there before' })
  })

  it('brings a file back empty when its name was synced and its bytes were not', () => {
    fs.writeFileSync(file('new.txt'), 'written')
    syncRoot()
    disk.powerLoss()
    expect(left()).toEqual({ 'new.txt': '', 'old.txt': 'there before' })
  })

  it('keeps a file as it was at its sync, and drops what was written after', () => {
    fs.writeFileSync(file('new.txt'), 'written')
    syncFile('new.txt')
    syncRoot()
    fs.appendFileSync(file('new.txt'), ' and more')
    fs.appendFileSync(file('old.txt'), ' and more')
    disk.powerLoss()
    expect(left()).toEqual({ 'new.txt': 'written', 'old.txt': 'there before' })
  })

  it('brings back a removed file until its directory is synced', () => {
    fs.unlinkSync(file('old.txt'))
    disk.powerLoss()
    expect(left()).toEqual({ 'old.txt': 'there before' })
    fs.unlinkSync(file('old.txt'))
    syncRoot()
    disk.powerLoss()
    expect(left()).toEqual({})
  })

  it('puts a renamed file back under its old name until its directory is synced', () => {
    fs.renameSync(file('old.txt'), file('moved.txt'))
    disk.powerLoss()
    expect(left()).toEqual({ 'old.txt': 'there before' })
    fs.renameSync(file('old.txt'), file('moved.txt'))
    syncRoot()
    disk.powerLoss()
    expect(left()).toEqual({ 'moved.txt': 'there before' })
  })

  it('never takes a new file under an old name for the file that was there', () => {
    // The removal and the new file are both unsynced, so the old one comes back.
    fs.unlinkSync(file('old.txt'))
    fs.writeFileSync(file('old.txt'), 'a different file')
    syncFile('old.txt')
    disk.powerLoss()
    expect(left()).toEqual({ 'old.txt': 'there before' })
  })

  it('keeps a directory made inside the root only once the root is synced', () => {
    fs.mkdirSync(file('inner'))
    fs.writeFileSync(path.join(root, 'inner', 'a.txt'), 'inside')
    const fd = fs.openSync(path.join(root, 'inner', 'a.txt'), 'r')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    const inner = fs.openSync(file('inner'), 'r')
    fs.fsyncSync(inner)
    fs.closeSync(inner)
    disk.powerLoss()
    expect(fs.existsSync(file('inner'))).toBe(false)

    fs.mkdirSync(file('inner'))
    syncRoot()
    fs.writeFileSync(path.join(root, 'inner', 'a.txt'), 'inside')
    disk.powerLoss()
    expect(fs.readdirSync(file('inner'))).toEqual([])
  })

  it('counts the syncs the code issues, sync and async, and pays through the port without counting', async () => {
    fs.writeFileSync(file('new.txt'), 'written')
    syncFile('new.txt')
    const fd = fs.openSync(file('new.txt'), 'r')
    await new Promise<void>((resolve, reject) =>
      fs.fsync(fd, (error) => (error ? reject(error) : resolve()))
    )
    fs.fdatasyncSync(fd)
    fs.closeSync(fd)
    syncRoot()
    expect(disk.issued).toEqual(['file:new.txt', 'file:new.txt', 'file:new.txt', 'directory:.'])

    fs.appendFileSync(file('new.txt'), ' and more')
    await expect(disk.port.syncFile(file('new.txt'))).resolves.toBe('synced')
    await expect(disk.port.syncDirectory(root)).resolves.toBe('synced')
    await expect(disk.port.syncFile(file('never.txt'))).resolves.toBe('missing')
    await expect(disk.port.syncDirectory(file('never'))).resolves.toBe('missing')
    expect(disk.paid).toEqual(['file:new.txt', 'directory:.'])
    expect(disk.issued).toHaveLength(4)
    disk.powerLoss()
    expect(left()).toEqual({ 'new.txt': 'written and more', 'old.txt': 'there before' })
  })

  it('keeps a path the system is said to have written out by itself', () => {
    fs.writeFileSync(file('new.txt'), 'written')
    disk.flushedAnyway(file('new.txt'))
    disk.flushedAnyway(root)
    disk.powerLoss()
    expect(left()).toEqual({ 'new.txt': 'written', 'old.txt': 'there before' })
    expect(disk.issued).toEqual([])
    expect(disk.paid).toEqual([])
  })

  it('gives the real sync calls back when it is done', () => {
    const watching = fs.fsyncSync
    disk.dispose()
    expect(fs.fsyncSync).not.toBe(watching)
    disk = watchCrashDisk(root)
  })
})

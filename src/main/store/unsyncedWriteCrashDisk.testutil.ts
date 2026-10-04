/**
 * A power loss, for tests of writers that do not sync after they write.
 *
 * The code under test writes real files under one directory. This watches
 * every sync it issues through `node:fs`, and every sync a thread barrier pays
 * through the port below, and remembers what each one made safe: a file sync
 * keeps that file's bytes as they are then, a directory sync keeps that
 * directory's names as they are then. `powerLoss()` rewrites the directory to
 * hold only that. A name that was safe without its bytes comes back as an
 * empty file; a name never made safe does not come back at all.
 *
 * That is the worst a power loss can do. A real one may also keep some of what
 * was never synced, and `flushedAnyway` says so for one path.
 *
 * POSIX only: Windows has no directory sync to watch, and its file numbers do
 * not fit a JavaScript number exactly. `countSyncs` works everywhere.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { vi } from 'vitest'
import type { ThreadDurabilityPort } from './ThreadDurabilityDebt'

export interface CrashDisk {
  /** Hand this to a debt ledger: each call makes one path safe. */
  readonly port: ThreadDurabilityPort
  /** Syncs the code under test issued itself, oldest first, as `file:<name>` or `directory:<name>`. */
  readonly issued: string[]
  /** Syncs paid through `port`, oldest first, in the same form. */
  readonly paid: string[]
  /** The system wrote this path out by itself: made safe, and not counted as a sync. */
  flushedAnyway(target: string): void
  /** Leave only what was made safe, and start again from there. */
  powerLoss(): void
  dispose(): void
}

export interface SyncCount {
  /** One entry for each sync issued through `node:fs`, oldest first: the name of the call. */
  readonly issued: string[]
  dispose(): void
}

/** Count the syncs issued through `node:fs` and let each one happen. */
export function countSyncs(): SyncCount {
  const issued: string[] = []
  const spies = (['fsyncSync', 'fdatasyncSync', 'fsync', 'fdatasync'] as const).map((name) => {
    const real = fs[name] as (...args: unknown[]) => unknown
    return vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
      issued.push(name)
      return real(...args)
    }) as never)
  })
  syncBuiltinESMExports()
  return {
    issued,
    dispose: () => {
      for (const spy of spies) spy.mockRestore()
      syncBuiltinESMExports()
    }
  }
}

type Tree = Map<string, Tree | Buffer>

export function watchCrashDisk(root: string): CrashDisk {
  /** Bytes each file had when it was last made safe, by inode. */
  let bytes = new Map<number, Buffer>()
  /** Names each directory had when it was last made safe, by inode. */
  let names = new Map<number, Map<string, { inode: number; directory: boolean }>>()
  /**
   * One open descriptor for every inode remembered above. While it is open the
   * system cannot give that inode's number to a new file, so a number names
   * one file for as long as this is watching.
   */
  let held = new Map<number, number>()
  const issued: string[] = []
  const paid: string[] = []

  const hold = (inode: number, target: string): number => {
    let fd = held.get(inode)
    if (fd === undefined) {
      fd = fs.openSync(target, 'r')
      held.set(inode, fd)
    }
    return fd
  }

  const keepFile = (inode: number, target: string): void => {
    const fd = hold(inode, target)
    const size = fs.fstatSync(fd).size
    const content = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = fs.readSync(fd, content, offset, size - offset, offset)
      if (count === 0) break
      offset += count
    }
    bytes.set(inode, content.subarray(0, offset))
  }

  const keepDirectory = (inode: number, target: string): void => {
    hold(inode, target)
    const entries = new Map<string, { inode: number; directory: boolean }>()
    for (const name of fs.readdirSync(target)) {
      const entry = path.join(target, name)
      const stat = fs.lstatSync(entry)
      if (!stat.isFile() && !stat.isDirectory()) continue
      hold(stat.ino, entry)
      entries.set(name, { inode: stat.ino, directory: stat.isDirectory() })
    }
    names.set(inode, entries)
  }

  /** Everything under the root as it is now counts as safe. */
  const keepEverything = (directory: string): void => {
    keepDirectory(fs.statSync(directory).ino, directory)
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name)
      const stat = fs.lstatSync(entry)
      if (stat.isDirectory()) keepEverything(entry)
      else if (stat.isFile()) keepFile(stat.ino, entry)
    }
  }

  /** Where under the root an inode is to be found now. */
  const locate = (inode: number, directory = root): string | null => {
    if (fs.statSync(directory).ino === inode) return directory
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name)
      const stat = fs.lstatSync(entry)
      if (stat.ino === inode) return entry
      if (stat.isDirectory()) {
        const found = locate(inode, entry)
        if (found) return found
      }
    }
    return null
  }

  const keep = (target: string, log: string[] | null): void => {
    const stat = fs.statSync(target)
    const kind = stat.isDirectory() ? 'directory' : 'file'
    log?.push(`${kind}:${path.relative(root, target) || '.'}`)
    if (stat.isDirectory()) keepDirectory(stat.ino, target)
    else keepFile(stat.ino, target)
  }

  /** A sync issued on a descriptor. One for a file outside the root is counted and nothing more. */
  const observe = (fd: number): void => {
    const target = locate(fs.fstatSync(fd).ino)
    if (target) keep(target, issued)
    else issued.push('elsewhere')
  }

  const later = (fd: number, done: (error: NodeJS.ErrnoException | null) => void): void => {
    let failure: NodeJS.ErrnoException | null = null
    try {
      observe(fd)
    } catch (error) {
      failure = error as NodeJS.ErrnoException
    }
    queueMicrotask(() => done(failure))
  }

  const spies = [
    vi.spyOn(fs, 'fsyncSync').mockImplementation(observe),
    vi.spyOn(fs, 'fdatasyncSync').mockImplementation(observe),
    vi.spyOn(fs, 'fsync').mockImplementation(later as typeof fs.fsync),
    vi.spyOn(fs, 'fdatasync').mockImplementation(later as typeof fs.fdatasync)
  ]
  syncBuiltinESMExports()
  keepEverything(root)

  const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

  const port: ThreadDurabilityPort = {
    syncFile: async (target) => {
      try {
        keep(target, paid)
      } catch (error) {
        if (gone(error)) return 'missing'
        throw error
      }
      return 'synced'
    },
    syncDirectory: async (target) => {
      try {
        keep(target, paid)
      } catch (error) {
        if (gone(error)) return 'missing'
        throw error
      }
      return 'synced'
    }
  }

  const release = (): void => {
    for (const fd of held.values()) fs.closeSync(fd)
    held = new Map()
  }

  const safeTree = (inode: number): Tree => {
    const tree: Tree = new Map()
    for (const [name, entry] of names.get(inode) ?? []) {
      tree.set(
        name,
        entry.directory ? safeTree(entry.inode) : (bytes.get(entry.inode) ?? Buffer.alloc(0))
      )
    }
    return tree
  }

  const write = (directory: string, tree: Tree): void => {
    for (const [name, content] of tree) {
      const entry = path.join(directory, name)
      if (Buffer.isBuffer(content)) fs.writeFileSync(entry, content)
      else {
        fs.mkdirSync(entry)
        write(entry, content)
      }
    }
  }

  return {
    port,
    issued,
    paid,
    flushedAnyway: (target) => keep(target, null),
    powerLoss: () => {
      const tree = safeTree(fs.statSync(root).ino)
      release()
      for (const name of fs.readdirSync(root)) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true })
      }
      write(root, tree)
      bytes = new Map()
      names = new Map()
      keepEverything(root)
    },
    dispose: () => {
      release()
      for (const spy of spies) spy.mockRestore()
      syncBuiltinESMExports()
    }
  }
}

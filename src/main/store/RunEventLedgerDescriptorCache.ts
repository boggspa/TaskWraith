import fs from 'node:fs'
import path from 'node:path'
import {
  MainDurabilityFlusher,
  type DurabilityFile,
  type DurabilityClass
} from './MainDurabilityFlusher'
import { MainDurabilityDirectoryLeases, type DirectoryLease } from './MainDurabilityDirectoryLeases'
import type { DurabilityDependency } from './MainDurabilityFlusher'

interface Entry {
  fd: number
  file: DurabilityFile
  end: number
  directory?: DurabilityFile
  dependencies?: DurabilityDependency[]
  pendingDirectory?: string
}

/** Main owns synchronous page-cache writes. The injected flusher owns closing
 * registered descriptors. No rollout switch is read here: composition injects
 * this only for exact TASKWRAITH_RUN_EVENT_FLUSHER=1.
 */
export class RunEventLedgerDescriptorCache {
  private readonly entries = new Map<string, Entry>()
  private readonly directories = new Map<string, { file: DurabilityFile; offset: number }>()
  private readonly retiring = new Map<string, Promise<void>>()
  private globalRetirement?: Promise<void>
  private readonly sharedLeases = new Map<string, DirectoryLease>()
  private readonly pendingParents = new Set<string>()
  private readonly pendingCreates = new Set<string>()

  constructor(
    private readonly flusher: MainDurabilityFlusher,
    private readonly limit = 128,
    private readonly directoryLeases?: MainDurabilityDirectoryLeases
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid descriptor capacity')
  }

  append(runId: string, filePath: string, line: string, durability: DurabilityClass): void {
    if (this.globalRetirement || this.retiring.has(runId))
      throw new Error('Ledger retirement in progress')
    let entry = this.entries.get(runId)
    if (!entry) {
      if (this.entries.size >= this.limit) {
        const oldest = this.entries.keys().next().value!
        // Single main turn: drain joins any outstanding operation before forget
        // closes. Entry admission is refused until async retirement settles.
        this.flusher.drainSync()
        this.retireSync([oldest])
      }
      const existed = fs.existsSync(filePath)
      const directoryExisted = fs.existsSync(path.dirname(filePath))
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      if (!directoryExisted && process.platform !== 'win32') {
        if (this.directoryLeases) {
          this.pendingParents.add(path.dirname(path.dirname(filePath)))
        } else {
          // Matches legacy strict cold-mkdir name durability. This setup barrier
          // precedes the file create; leaf-file durability remains deferred.
          const parentFd = fs.openSync(path.dirname(path.dirname(filePath)), 'r')
          try {
            fs.fsyncSync(parentFd)
          } finally {
            fs.closeSync(parentFd)
          }
        }
      }
      for (const parent of this.pendingParents) {
        const debt = this.sharedDirectory(parent).noteMutation()
        this.flusher.noteWrite(debt.file, debt.offset, 'sync')
        this.pendingParents.delete(parent)
      }
      const fd = fs.openSync(filePath, 'a+')
      if (!existed) this.pendingCreates.add(filePath)
      try {
        const stat = fs.fstatSync(fd)
        entry = {
          fd,
          file: this.flusher.open(stat.dev, stat.ino, fd, stat.size, 'run-events'),
          end: stat.size
        }
      } catch (error) {
        fs.closeSync(fd)
        throw error
      }
      this.entries.set(runId, entry)
    }
    if (this.pendingCreates.has(filePath) && process.platform !== 'win32') {
      const directoryPath = path.dirname(filePath)
      if (this.directoryLeases) {
        entry.pendingDirectory = directoryPath
      } else {
        let directory = this.directories.get(directoryPath)
        if (!directory) {
          const directoryFd = fs.openSync(directoryPath, 'r')
          try {
            const identity = fs.fstatSync(directoryFd)
            directory = {
              file: this.flusher.open(identity.dev, identity.ino, directoryFd, 0, 'directory'),
              offset: 0
            }
          } catch (error) {
            fs.closeSync(directoryFd)
            throw error
          }
          this.directories.set(directoryPath, directory)
        }
        directory.offset++
        this.flusher.noteWrite(directory.file, directory.offset, 'soft')
        entry.directory = directory.file
      }
    }
    this.entries.delete(runId)
    this.entries.set(runId, entry)
    if (entry.pendingDirectory) {
      entry.dependencies = [this.sharedDirectory(entry.pendingDirectory).noteMutation()]
      entry.pendingDirectory = undefined
    }
    this.pendingCreates.delete(filePath)
    const size = fs.fstatSync(entry.fd).size
    const byte = Buffer.allocUnsafe(1)
    if (size > 0 && fs.readSync(entry.fd, byte, 0, 1, size - 1) !== 1)
      throw new Error('Unable to read ledger EOF')
    const prefix = size > 0 && byte[0] !== 10 ? '\n' : ''
    let writeError: unknown
    try {
      fs.writeFileSync(entry.fd, prefix + line, 'utf8')
    } catch (error) {
      writeError = error
    }
    try {
      entry.end = fs.fstatSync(entry.fd).size
      const directory =
        entry.directory &&
        [...this.directories.values()].find((row) => row.file === entry!.directory)
      this.flusher.noteWrite(entry.file, entry.end, durability, {
        after:
          entry.dependencies ??
          (directory ? [{ file: directory.file, offset: directory.offset }] : [])
      })
    } catch (error) {
      if (!writeError) throw error
    }
    if (writeError) throw writeError
  }

  awaitDurable(runId: string): Promise<void> {
    const entry = this.entries.get(runId)
    return entry ? this.flusher.awaitDurable(entry.file, entry.end) : Promise.resolve()
  }

  drainSync(): void {
    this.flusher.drainSync()
  }

  retire(runIds?: readonly string[]): Promise<void> {
    if (this.globalRetirement) return this.globalRetirement
    const keys = runIds ?? [...this.entries.keys()]
    const files = keys.flatMap((key) =>
      this.entries.get(key) ? [this.entries.get(key)!.file] : []
    )
    if (!runIds) files.push(...[...this.directories.values()].map((row) => row.file))
    const prior = keys.flatMap((key) => (this.retiring.get(key) ? [this.retiring.get(key)!] : []))
    const promise = Promise.all([...prior, this.flusher.forget(files)])
      .then(async () => {
        for (const key of keys) this.entries.delete(key)
        if (!runIds) {
          this.directories.clear()
          this.pendingParents.clear()
          for (const [directoryPath, lease] of this.sharedLeases) {
            await lease.release()
            this.sharedLeases.delete(directoryPath)
          }
        }
      })
      .finally(() => {
        for (const key of keys) if (this.retiring.get(key) === promise) this.retiring.delete(key)
        if (this.globalRetirement === promise) this.globalRetirement = undefined
      })
    for (const key of keys) this.retiring.set(key, promise)
    if (!runIds) this.globalRetirement = promise
    // Preserve a rejected retirement for callers while avoiding a background
    // rejection when synchronous admission initiated LRU retirement.
    void promise.catch(() => {})
    return promise
  }

  retireSync(runIds?: readonly string[]): void {
    const keys = runIds ?? [...this.entries.keys()]
    const files = keys.flatMap((key) =>
      this.entries.get(key) ? [this.entries.get(key)!.file] : []
    )
    if (!runIds) files.push(...[...this.directories.values()].map((row) => row.file))
    this.flusher.forgetSync(files)
    for (const key of keys) this.entries.delete(key)
    if (!runIds) {
      this.directories.clear()
      this.pendingParents.clear()
      for (const [directoryPath, lease] of this.sharedLeases) {
        lease.releaseSync()
        this.sharedLeases.delete(directoryPath)
      }
    }
  }

  private sharedDirectory(directoryPath: string): DirectoryLease {
    let lease = this.sharedLeases.get(directoryPath)
    if (!lease) {
      lease = this.directoryLeases!.acquire(directoryPath)
      this.sharedLeases.set(directoryPath, lease)
    }
    return lease
  }
}

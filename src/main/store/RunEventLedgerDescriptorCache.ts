import fs from 'node:fs'
import path from 'node:path'
import {
  MainDurabilityFlusher,
  type DurabilityFile,
  type DurabilityClass
} from './MainDurabilityFlusher'

interface Entry {
  fd: number
  file: DurabilityFile
  end: number
  directory?: DurabilityFile
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

  constructor(
    private readonly flusher: MainDurabilityFlusher,
    private readonly limit = 128
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
        // Matches legacy strict cold-mkdir name durability. This setup barrier
        // precedes the file create; leaf-file durability remains deferred.
        const parentFd = fs.openSync(path.dirname(path.dirname(filePath)), 'r')
        try {
          fs.fsyncSync(parentFd)
        } finally {
          fs.closeSync(parentFd)
        }
      }
      const fd = fs.openSync(filePath, 'a+')
      const stat = fs.fstatSync(fd)
      entry = { fd, file: this.flusher.open(stat.dev, stat.ino, fd, stat.size), end: stat.size }
      this.entries.set(runId, entry)
      if (!existed && process.platform !== 'win32') {
        const directoryPath = path.dirname(filePath)
        let directory = this.directories.get(directoryPath)
        if (!directory) {
          const directoryFd = fs.openSync(directoryPath, 'r')
          const identity = fs.fstatSync(directoryFd)
          directory = {
            file: this.flusher.open(identity.dev, identity.ino, directoryFd),
            offset: 0
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
        after: directory ? [{ file: directory.file, offset: directory.offset }] : []
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
      .then(() => {
        for (const key of keys) this.entries.delete(key)
        if (!runIds) this.directories.clear()
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
    if (!runIds) this.directories.clear()
  }
}

import fs from 'node:fs'
import path from 'node:path'
import type { DirectoryLease, MainDurabilityDirectoryLeases } from './MainDurabilityDirectoryLeases'
import type { DurabilityDependency, DurabilityFile } from './MainDurabilityFlusher'

export interface JournalDescriptorFlusher {
  transferDependencies?(
    predecessor: DurabilityFile,
    successor: DurabilityFile,
    offset: number
  ): void
  open(dev: number, ino: number, fd: number, durableOffset?: number): DurabilityFile
  noteWrite(
    file: DurabilityFile,
    end: number,
    durability: 'soft' | 'sync',
    options?: { after?: readonly DurabilityDependency[] }
  ): void
  awaitDurable(file: DurabilityFile, offset: number): Promise<void>
  forget(files: readonly DurabilityFile[]): Promise<void>
  /** Inject only once the adapter implements synchronous in-flight joining. */
  forgetSync?(files: readonly DurabilityFile[]): void
}

interface Entry {
  retired?: boolean
  path: string
  fd: number
  file: DurabilityFile
  end: number
  dependencies: DurabilityDependency[]
}

/** Concrete page-cache writer, opt-in by composition injection only. No flag
 * defaults are changed. Registered descriptors belong to the flusher, including
 * flat directory dependencies covering every newly created ancestor name.
 */
export class IncrementalChatJournalDescriptorCache {
  private creationDebt = new Map<string, string[]>()
  private entries = new Map<string, Entry>()
  private sealed = new Map<string, Entry>()
  private rotationFailures = new Map<string, unknown>()
  private directories = new Map<string, { file: DurabilityFile; offset: number }>()
  private directoryLeases = new Map<string, DirectoryLease>()
  private retiring = new Map<string, Promise<void>>()
  private globalRetirement?: Promise<void>

  constructor(
    private readonly flusher: JournalDescriptorFlusher,
    private readonly options: {
      write?: (fd: number, bytes: Buffer) => void
      maxFiles?: number
      directoryLeases?: Pick<MainDurabilityDirectoryLeases, 'acquire'>
    } = {}
  ) {}

  append(
    chatId: string,
    filePath: string,
    line: string,
    durability: 'deferred' | 'immediate'
  ): void {
    if (this.rotationFailures.has(chatId)) throw this.rotationFailures.get(chatId)
    if (this.globalRetirement || this.retiring.has(chatId))
      throw new Error('Journal retirement in progress')
    const absolute = path.resolve(filePath)
    let entry = this.entries.get(chatId)
    if (entry) {
      const current = fs.statSync(absolute)
      if (
        entry.path !== absolute ||
        current.dev !== entry.file.dev ||
        current.ino !== entry.file.ino
      ) {
        throw new Error('Journal inode replaced; retire before reopening')
      }
    } else {
      if (this.entries.size >= (this.options.maxFiles ?? 128))
        throw new Error('Journal descriptor capacity unavailable')
      const missing: string[] = []
      let directory = path.dirname(absolute)
      while (!fs.existsSync(directory)) {
        missing.unshift(directory)
        const parent = path.dirname(directory)
        if (parent === directory) throw new Error('Missing filesystem root')
        directory = parent
      }
      const existed = fs.existsSync(absolute)
      const debt = this.creationDebt.get(absolute) ?? []
      if (process.platform !== 'win32') {
        for (const created of missing) debt.push(path.dirname(created))
        if (!existed) debt.push(path.dirname(absolute))
      }
      // Persist before mkdir/open/registration: retries must not mistake a
      // created but unregistered name for a pre-existing durable baseline.
      this.creationDebt.set(absolute, [...new Set(debt)])
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      const dependencies: DurabilityDependency[] = []
      // Directory nodes themselves carry no dependencies: every ancestor is
      // declared directly on the journal inode, keeping scheduler depth one.
      const fd = fs.openSync(absolute, 'a+')
      try {
        const stat = fs.fstatSync(fd)
        const file = this.flusher.open(stat.dev, stat.ino, fd, stat.size)
        entry = { path: absolute, fd, file, end: stat.size, dependencies }
        this.entries.set(chatId, entry)
      } catch (error) {
        fs.closeSync(fd)
        throw error
      }
    }
    const debt = this.creationDebt.get(absolute)
    if (debt) {
      // Publish the complete flat set atomically. A throw leaves initialization
      // fenced and all name debt available for the next attempt.
      const dependencies = debt.map((directory) => this.directoryWrite(directory))
      entry.dependencies = dependencies
      this.creationDebt.delete(absolute)
    }
    const predecessor = this.sealed.get(chatId)
    if (
      predecessor &&
      !entry.dependencies.some((dependency) => dependency.file === predecessor.file)
    ) {
      if (!this.flusher.transferDependencies)
        throw new Error('Journal rotation transfer unavailable')
      this.flusher.transferDependencies(predecessor.file, entry.file, predecessor.end)
      // Keep the transferred prerequisite in every later declaration; directory
      // creates stay flat alongside it. The flusher owns original name debt.
      entry.dependencies.push({ file: predecessor.file, offset: predecessor.end })
    }
    let failed = false
    let original: unknown
    try {
      const bytes = Buffer.from(line)
      if (this.options.write) this.options.write(entry.fd, bytes)
      else fs.writeFileSync(entry.fd, bytes)
    } catch (error) {
      failed = true
      original = error
    }
    try {
      entry.end = fs.fstatSync(entry.fd).size
      this.flusher.noteWrite(entry.file, entry.end, durability === 'immediate' ? 'sync' : 'soft', {
        after: entry.dependencies
      })
    } catch (error) {
      if (!failed) throw error
    }
    if (failed) throw original
  }

  awaitDurable(chatId: string): Promise<void> {
    if (this.rotationFailures.has(chatId)) return Promise.reject(this.rotationFailures.get(chatId))
    const entry = this.entries.get(chatId)
    if (entry && this.creationDebt.has(entry.path))
      return Promise.reject(new Error('Journal creation dependencies incomplete'))
    const target = entry ?? this.sealed.get(chatId)
    return target ? this.flusher.awaitDurable(target.file, target.end) : Promise.resolve()
  }

  /** Rename custody without closing, flushing or reusing the predecessor fd. */
  rotate(chatId: string, sealedPath: string): void {
    if (!this.flusher.transferDependencies) throw new Error('Journal rotation transfer unavailable')
    if (this.globalRetirement || this.retiring.has(chatId) || this.sealed.has(chatId))
      throw new Error('Journal rotation unavailable')
    const entry = this.entries.get(chatId)
    if (!entry || this.creationDebt.has(entry.path))
      throw new Error('Journal source not initialized')
    const destination = path.resolve(sealedPath)
    if (fs.existsSync(destination)) throw new Error('Sealed journal already exists')
    fs.renameSync(entry.path, destination)
    this.entries.delete(chatId)
    entry.path = destination
    this.sealed.set(chatId, entry)
    // Register after rename; failures retain custody and refuse future writes.
    try {
      entry.dependencies.push(this.directoryWrite(path.dirname(destination)))
      this.flusher.noteWrite(entry.file, entry.end, 'soft', { after: entry.dependencies })
    } catch (error) {
      this.rotationFailures.set(chatId, error)
      throw error
    }
  }

  retire(ids?: readonly string[]): Promise<void> {
    if (this.globalRetirement) return this.globalRetirement
    const keys = [
      ...new Set(ids ?? [...this.entries.keys(), ...this.sealed.keys(), ...this.retiring.keys()])
    ]
    const prior = keys.flatMap((id) => (this.retiring.has(id) ? [this.retiring.get(id)!] : []))
    const files = keys.flatMap((id) => (this.entries.has(id) ? [this.entries.get(id)!.file] : []))
    files.push(...keys.flatMap((id) => (this.sealed.has(id) ? [this.sealed.get(id)!.file] : [])))
    if (!ids) files.push(...[...this.directories.values()].map((row) => row.file))
    const promise = Promise.all([...prior, this.flusher.forget(files)])
      .then(async () => {
        if (!ids) {
          await Promise.all([...this.directoryLeases.values()].map((lease) => lease.release()))
          this.directoryLeases.clear()
        }
        for (const id of keys) this.entries.delete(id)
        for (const id of keys) this.sealed.delete(id)
        for (const id of keys) this.rotationFailures.delete(id)
        if (!ids) this.directories.clear()
      })
      .finally(() => {
        for (const id of keys) if (this.retiring.get(id) === promise) this.retiring.delete(id)
        if (this.globalRetirement === promise) this.globalRetirement = undefined
      })
    for (const id of keys) this.retiring.set(id, promise)
    if (!ids) this.globalRetirement = promise
    void promise.catch(() => {})
    return promise
  }

  retireSync(ids?: readonly string[]): void {
    if (!this.flusher.forgetSync) throw new Error('Synchronous retirement adapter unavailable')
    const keys = [...new Set(ids ?? [...this.entries.keys(), ...this.sealed.keys()])]
    const files = keys.flatMap((id) => (this.entries.has(id) ? [this.entries.get(id)!.file] : []))
    files.push(...keys.flatMap((id) => (this.sealed.has(id) ? [this.sealed.get(id)!.file] : [])))
    if (!ids) files.push(...[...this.directories.values()].map((row) => row.file))
    this.flusher.forgetSync(files)
    if (!ids) {
      for (const lease of this.directoryLeases.values()) lease.releaseSync()
      this.directoryLeases.clear()
    }
    for (const id of keys) this.entries.delete(id)
    for (const id of keys) this.sealed.delete(id)
    for (const id of keys) this.rotationFailures.delete(id)
    if (!ids) this.directories.clear()
  }

  async awaitDirectoryMutation(directory: string): Promise<void> {
    const dependency = this.directoryWrite(directory)
    await this.flusher.awaitDurable(dependency.file, dependency.offset)
  }

  retireSealedSync(chatId: string): void {
    const entry = this.sealed.get(chatId)
    if (!entry) throw new Error('Sealed custody unavailable')
    const current = fs.statSync(entry.path)
    if (current.dev !== entry.file.dev || current.ino !== entry.file.ino)
      throw new Error('Sealed inode replaced before retirement')
    if (entry.retired) return
    if (!this.flusher.forgetSync) throw new Error('Synchronous retirement adapter unavailable')
    this.flusher.forgetSync([entry.file])
    entry.retired = true
  }

  completeSealedUnlink(chatId: string): void {
    const entry = this.sealed.get(chatId)
    if (!entry?.retired) throw new Error('Sealed retirement incomplete')
    if (fs.existsSync(entry.path)) throw new Error('Sealed unlink incomplete')
    this.sealed.delete(chatId)
  }

  private directoryWrite(directory: string): DurabilityDependency {
    if (this.options.directoryLeases) {
      let lease = this.directoryLeases.get(directory)
      if (!lease) {
        lease = this.options.directoryLeases.acquire(directory)
        this.directoryLeases.set(directory, lease)
      }
      return lease.noteMutation()
    }
    let row = this.directories.get(directory)
    if (!row) {
      const fd = fs.openSync(directory, 'r')
      try {
        const stat = fs.fstatSync(fd)
        row = { file: this.flusher.open(stat.dev, stat.ino, fd), offset: 0 }
        this.directories.set(directory, row)
      } catch (error) {
        fs.closeSync(fd)
        throw error
      }
    }
    this.flusher.noteWrite(row.file, ++row.offset, 'soft')
    return { file: row.file, offset: row.offset }
  }
}

import fs from 'node:fs'
import path from 'node:path'
import type { DurabilityAttachmentPorts, DurabilityParticipant } from './MainDurabilityRuntime'
import type { DurabilityFile, DurabilityDependency } from './MainDurabilityFlusher'
import type { DirectoryLease } from './MainDurabilityDirectoryLeases'

/** Process-local side channel. Never serialize this token into a record or receipt. */
export interface ToolDetailDependency {
  awaitDurable(): Promise<void>
  flushSync(): void
  /** Same-process journal binding only; the strict receipt has already drained these. */
  journalDependencies(): readonly DurabilityDependency[]
}

/** Attempt every dependency even when an earlier synchronous flush fails. */
export function flushToolDetailDependencies(dependencies: readonly ToolDetailDependency[]): void {
  const failures: unknown[] = []
  for (const dependency of dependencies) {
    try {
      dependency.flushSync()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Detail dependency flush failed')
}

interface Entry {
  file: DurabilityFile
  fd: number
  end: number
  directory?: DirectoryLease
  namePending?: boolean
}

export class ToolActivityDetailDurability implements DurabilityParticipant {
  private readonly entries = new Map<string, Entry>()
  private fenced = false
  private readonly ancestorDebt = new Set<string>()
  private readonly ancestorLeases = new Map<string, DirectoryLease>()
  private readonly createdNames = new Set<string>()
  constructor(private readonly ports: DurabilityAttachmentPorts) {}

  append(filePath: string, bytes: Buffer, expectedSize: number): ToolDetailDependency {
    if (this.fenced) throw new Error('Detail durability is fenced')
    let entry = this.entries.get(filePath)
    if (!entry) {
      const directory = path.dirname(filePath)
      let missing = directory
      while (!fs.existsSync(missing)) {
        this.ancestorDebt.add(path.dirname(missing))
        missing = path.dirname(missing)
      }
      fs.mkdirSync(directory, { recursive: true })
      this.flushAncestorDebt()
      const existed = fs.existsSync(filePath)
      // Creation debt precedes registration: an open/register failure must not
      // make retry mistake an unacknowledged new name for a durable old file.
      if (!existed) this.createdNames.add(filePath)
      const fd = fs.openSync(filePath, 'a+')
      try {
        const stat = fs.fstatSync(fd)
        if (stat.size !== expectedSize) throw new Error('Detail artifact changed while staging')
        const file = this.ports.flusher.open(stat.dev, stat.ino, fd, stat.size, 'detail')
        entry = { fd, file, end: stat.size, namePending: this.createdNames.has(filePath) }
        this.entries.set(filePath, entry)
      } catch (error) {
        fs.closeSync(fd)
        throw error
      }
    }
    this.flushAncestorDebt()
    if (entry.namePending && !entry.directory && process.platform !== 'win32')
      entry.directory = this.ports.directoryLeases.acquire(path.dirname(filePath))
    if (fs.fstatSync(entry.fd).size !== expectedSize)
      throw new Error('Detail artifact changed while staging')
    let name: DurabilityDependency | undefined
    let writeFailure: unknown
    try {
      fs.writeFileSync(entry.fd, bytes)
    } catch (error) {
      writeFailure = error
    }
    try {
      entry.end = fs.fstatSync(entry.fd).size
      // Account visible bytes even when name registration fails below.
      this.ports.flusher.noteWrite(entry.file, entry.end, 'soft')
      entry.namePending = entry.directory !== undefined || entry.namePending
      name = entry.directory?.noteMutation()
      entry.namePending = false
      this.createdNames.delete(filePath)
      this.ports.flusher.noteWrite(entry.file, entry.end, 'soft', {
        after: name ? [name] : []
      })
    } catch (debt) {
      if (writeFailure)
        throw new AggregateError(
          [writeFailure, debt],
          'Partial detail write retains durability debt'
        )
      throw debt
    }
    if (writeFailure) throw writeFailure
    const file = entry.file
    const end = entry.end
    return Object.freeze({
      awaitDurable: () => this.ports.flusher.awaitDurable(file, end),
      flushSync: () => this.drainSync(),
      journalDependencies: () => [{ file, offset: end }, ...(name ? [name] : [])]
    })
  }

  fence(): void {
    this.fenced = true
  }
  /** Call under the Store's existing erasure admission fence, before unlink. */
  retireForErasureSync(runDirectories?: readonly string[]): void {
    this.drainSync()
    const roots = runDirectories?.map((directory) => path.resolve(directory))
    const selected = (filePath: string): boolean =>
      !roots ||
      roots.some((root) => {
        const relative = path.relative(root, path.resolve(filePath))
        return (
          relative === '' ||
          (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
        )
      })
    for (const [filePath, entry] of this.entries) {
      if (!selected(filePath)) continue
      this.ports.flusher.forgetSync([entry.file])
      entry.directory?.releaseSync()
      this.entries.delete(filePath)
      this.createdNames.delete(filePath)
    }
    if (!roots) {
      for (const [directory, lease] of this.ancestorLeases) {
        lease.releaseSync()
        this.ancestorLeases.delete(directory)
      }
      this.createdNames.clear()
    }
  }
  drainSync(): void {
    this.flushAncestorDebt()
    for (const [filePath, entry] of this.entries) {
      if (entry.namePending && process.platform !== 'win32') {
        entry.directory ??= this.ports.directoryLeases.acquire(path.dirname(filePath))
        const name = entry.directory.noteMutation()
        this.ports.flusher.noteWrite(entry.file, entry.end, 'soft', { after: [name] })
        entry.namePending = false
        this.createdNames.delete(filePath)
      }
    }
    this.ports.flusher.drainSync()
  }
  private flushAncestorDebt(): void {
    if (process.platform === 'win32') {
      this.ancestorDebt.clear()
      return
    }
    if (!this.ancestorDebt.size) return
    for (const directory of this.ancestorDebt) {
      let lease = this.ancestorLeases.get(directory)
      if (!lease) {
        lease = this.ports.directoryLeases.acquire(directory)
        this.ancestorLeases.set(directory, lease)
      }
      lease.noteMutation()
    }
    // Joins the one outstanding pool operation before any synchronous fsync.
    // Failure retains every ancestor name and lease for the next strict retry.
    this.ports.flusher.drainSync()
    this.ancestorDebt.clear()
  }
  async retire(): Promise<void> {
    this.fenced = true
    for (const [key, entry] of this.entries) {
      await this.ports.flusher.forget([entry.file])
      await entry.directory?.release()
      this.entries.delete(key)
    }
    for (const [directory, lease] of this.ancestorLeases) {
      await lease.release()
      this.ancestorLeases.delete(directory)
    }
  }
}

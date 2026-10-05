import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Composition supplies its existing profile pool; this module starts no worker. */
export interface ThreadCatalogueDurabilityPorts<File> {
  open(dev: number, ino: number, fd: number, durableOffset?: number): File
  noteWrite(file: File, offset: number, durability: 'soft'): void
  awaitDurable(file: File, offset: number): Promise<void>
  forget(files: readonly File[]): Promise<void>
  acquire(directory: string): {
    noteMutation(): { file: File; offset: number }
    release(): Promise<void>
  }
}

export interface ThreadCatalogueDeferredDurability {
  /** True only when this writer prepared a rebuildable publication's directory. */
  prepareDirectory?(filePath: string): boolean
  write(filePath: string, text: string, beforeRename?: () => void, afterRename?: () => void): void
  awaitDurable(): Promise<void>
}

/** Only ordinary Desktop publication heads use this split. Controls stay strict. */
export class ThreadCatalogueDurability<File> implements ThreadCatalogueDeferredDurability {
  private readonly pending = new Set<Promise<void>>()
  private readonly resources = new Map<File, { release(): Promise<void> } | null>()
  private fenced = false
  private visibleWrites = 0
  private durableWrites = 0
  private failures = 0
  private failure: unknown
  constructor(private readonly ports: ThreadCatalogueDurabilityPorts<File>) {}

  write(filePath: string, text: string, beforeRename?: () => void, afterRename?: () => void): void {
    if (this.failure) throw this.failure
    if (this.fenced) throw new Error('Catalogue durability is fenced')
    const temporary = `${filePath}.tmp-${randomUUID()}`
    const fd = fs.openSync(temporary, 'wx', 0o600)
    let registered = false
    try {
      fs.writeFileSync(fd, text)
      const stat = fs.fstatSync(fd)
      const file = this.ports.open(stat.dev, stat.ino, fd, 0)
      registered = true
      this.resources.set(file, null)
      const directory = this.ports.acquire(path.dirname(filePath))
      this.resources.set(file, directory)
      beforeRename?.()
      fs.renameSync(temporary, filePath)
      this.visibleWrites++
      const name = directory.noteMutation()
      this.ports.noteWrite(file, stat.size, 'soft')
      const barrier = Promise.all([
        this.ports.awaitDurable(file, stat.size),
        this.ports.awaitDurable(name.file, name.offset)
      ]).then(async () => {
        await this.ports.forget([file])
        await directory.release()
        this.resources.delete(file)
        this.durableWrites++
      })
      const tracked = barrier
        .catch((error) => {
          this.failure ??= error
          this.failures++
          throw error
        })
        .finally(() => this.pending.delete(tracked))
      this.pending.add(tracked)
      void tracked.catch(() => {})
      // Visible bytes own their file and name debt before extensible callbacks.
      // A callback failure must not let shutdown retire an unflushed head.
      afterRename?.()
    } catch (error) {
      if (!registered) fs.closeSync(fd)
      this.failure = error
      this.failures++
      throw error
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  async awaitDurable(): Promise<void> {
    if (this.failure) throw this.failure
    await Promise.all([...this.pending])
    if (this.failure) throw this.failure
  }

  fence(): void {
    this.fenced = true
  }

  snapshot(): {
    visibleWrites: number
    durableWrites: number
    failures: number
    pending: number
    descriptors: number
    fenced: boolean
  } {
    return {
      visibleWrites: this.visibleWrites,
      durableWrites: this.durableWrites,
      failures: this.failures,
      pending: this.pending.size,
      descriptors: this.resources.size,
      fenced: this.fenced
    }
  }

  /** Caller drains the shared pool before retiring; failures preserve ownership for retry. */
  async retire(): Promise<void> {
    this.fenced = true
    await Promise.allSettled([...this.pending])
    for (const [file, directory] of this.resources) {
      await this.ports.forget([file])
      await directory?.release()
      this.resources.delete(file)
    }
  }
}

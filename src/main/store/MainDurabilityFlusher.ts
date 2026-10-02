/** Pure M5 scheduler. No filesystem adapter or rollout wiring is installed here. */
export type DurabilityClass = 'soft' | 'prompt' | 'sync'

export interface DurabilityFile {
  readonly dev: number
  readonly ino: number
  readonly generation: number
}

export interface DurabilityDependency {
  readonly file: DurabilityFile
  readonly offset: number
}

export interface DurabilitySyncTicket {
  /** Join the already submitted fsync, invoking its completion before returning.
   * An adapter must never implement this by submitting a second fsync.
   */
  joinSync(): void
}

export interface DurabilityFlusherPorts {
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
  fsync(fd: number, complete: (error?: Error) => void): DurabilitySyncTicket
  fsyncSync(fd: number): void
  close(fd: number): void
}

export interface DurabilityFlusherCounters {
  asyncFsyncs: number
  syncFsyncs: number
  strictFsyncs: number
  dependencySyncFsyncs: number
  hardBoundFsyncs: number
  escalations: number
  errors: number
}

interface Waiter {
  offset: number
  resolve(): void
  reject(error: Error): void
}

interface FileState {
  identity: DurabilityFile
  fd: number
  end: number
  durable: number
  dirtySince?: number
  nextDirtySince?: number
  prompt: boolean
  dependencies: Map<FileState, number>
  waiters: Waiter[]
  error?: Error
  forgetting: boolean
  forgotten: boolean
  closeFailed?: boolean
  forgottenPromise?: Promise<void>
  finishForget?: { resolve(): void; reject(error: Error): void }
}

interface Flight {
  file: FileState
  end: number
  started: number
  ticket?: DurabilitySyncTicket
}

/** Owns descriptors registered with open(). Dependencies have depth one.
 * The injected sync-join contract is required to preserve the single-fsync
 * bound when a strict write arrives during an asynchronous fsync.
 */
export class MainDurabilityFlusher {
  readonly counters: DurabilityFlusherCounters = {
    asyncFsyncs: 0,
    syncFsyncs: 0,
    strictFsyncs: 0,
    dependencySyncFsyncs: 0,
    hardBoundFsyncs: 0,
    escalations: 0,
    errors: 0
  }

  private readonly identities = new WeakMap<DurabilityFile, FileState>()
  private readonly files = new Set<FileState>()
  private generation = 0
  private flight?: Flight
  private timer?: unknown
  private pumping = false
  private syncDepth = 0
  private capacity: number

  constructor(
    private readonly ports: DurabilityFlusherPorts,
    capacityPerSecond = 45
  ) {
    if (!Number.isFinite(capacityPerSecond) || capacityPerSecond <= 0) {
      throw new Error('Invalid fsync capacity')
    }
    this.capacity = capacityPerSecond
  }

  open(dev: number, ino: number, fd: number, durableOffset = 0): DurabilityFile {
    this.validateOffset(durableOffset)
    for (const file of this.files.values()) {
      if (
        !file.forgotten &&
        (file.fd === fd || (file.identity.dev === dev && file.identity.ino === ino))
      ) {
        throw new Error('Descriptor or inode is already registered')
      }
    }
    const identity = Object.freeze({ dev, ino, generation: ++this.generation })
    const file: FileState = {
      identity,
      fd,
      end: durableOffset,
      durable: durableOffset,
      prompt: false,
      dependencies: new Map(),
      waiters: [],
      forgetting: false,
      forgotten: false
    }
    this.identities.set(identity, file)
    this.files.add(file)
    return identity
  }

  noteWrite(
    identity: DurabilityFile,
    endOffset: number,
    durability: DurabilityClass,
    options: { after?: readonly DurabilityDependency[] } = {}
  ): void {
    const file = this.active(identity)
    this.validateOffset(endOffset)
    if (endOffset < file.end) throw new Error('Write offset regressed')
    // Validate the complete declaration before changing any state.
    const dependencies = (options.after ?? []).map(({ file: dependency, offset }) => {
      this.validateOffset(offset)
      const target = this.state(dependency)
      if (offset > target.end) throw new Error('Dependency exceeds written extent')
      if (target === file || target.dependencies.size > 0) {
        throw new Error('Dependencies must have depth one')
      }
      return { target, offset }
    })
    if (dependencies.length > 0) {
      for (const other of this.files.values()) {
        if (other.dependencies.has(file)) throw new Error('Dependencies must have depth one')
      }
    }
    for (const { target, offset } of dependencies) {
      file.dependencies.set(target, Math.max(offset, file.dependencies.get(target) ?? 0))
    }
    if (endOffset > file.end) {
      const now = this.ports.now()
      file.dirtySince ??= now
      if (this.flight?.file === file) file.nextDirtySince ??= now
      file.end = endOffset
    }
    file.prompt ||= durability === 'prompt'
    const failedDependency = [...file.dependencies.keys()].some((dependency) => dependency.error)
    if (durability === 'sync' || file.error || failedDependency) {
      if (file.error || failedDependency) this.counters.escalations++
      this.sync(file, durability === 'sync' ? 'strict' : 'escalation')
    }
    this.pump()
  }

  awaitDurable(identity: DurabilityFile, offset: number): Promise<void> {
    const file = this.state(identity)
    this.validateOffset(offset)
    if (offset > file.end) return Promise.reject(new Error('Barrier exceeds written extent'))
    if (file.error) return Promise.reject(file.error)
    if (file.forgotten || this.satisfied(file, offset)) return Promise.resolve()
    if (file.forgetting) return Promise.reject(new Error('File is being forgotten'))
    const promise = new Promise<void>((resolve, reject) => {
      file.waiters.push({ offset, resolve, reject })
    })
    this.pump()
    return promise
  }

  /** Caller must already have durably adopted any covering checkpoint.
   * Closes before resolving, allowing the caller to unlink safely.
   */
  async forget(identities: readonly DurabilityFile[]): Promise<void> {
    const files = identities.map((identity) => this.state(identity))
    const promises = files.map((file) => {
      if (file.forgotten) return Promise.resolve()
      if (file.forgottenPromise) return file.forgottenPromise
      file.forgetting = true
      file.forgottenPromise = new Promise<void>((resolve, reject) => {
        file.finishForget = { resolve, reject }
      })
      return file.forgottenPromise
    })
    for (const file of files) {
      if (this.flight?.file !== file && !file.forgotten) this.finishForget(file)
    }
    this.pump()
    await Promise.all(promises)
  }

  drainSync(): void {
    this.syncDepth++
    try {
      this.joinFlight()
      for (const file of this.files.values()) {
        if (!file.forgetting && !file.forgotten && !this.satisfied(file, file.end)) {
          this.sync(file, 'drain')
        }
      }
    } finally {
      this.syncDepth--
      this.pump()
    }
  }

  snapshot(): {
    dirtyFiles: number
    pendingWaiters: number
    softDeadlineMs: number
    inFlight: number
  } {
    const active = [...this.files.values()].filter((file) => !file.forgotten && !file.forgetting)
    const dirtyFiles = active.filter((file) => file.durable < file.end).length
    return {
      dirtyFiles,
      pendingWaiters: active.reduce((count, file) => count + file.waiters.length, 0),
      softDeadlineMs: Math.min(4000, Math.max(1000, (dirtyFiles / this.capacity) * 1000)),
      inFlight: this.flight ? 1 : 0
    }
  }

  private state(identity: DurabilityFile): FileState {
    const file = this.identities.get(identity)
    if (!file) throw new Error('Unknown file generation')
    return file
  }

  private active(identity: DurabilityFile): FileState {
    const file = this.state(identity)
    if (file.forgetting || file.forgotten) throw new Error('File is being forgotten')
    return file
  }

  private validateOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset')
  }

  private satisfied(file: FileState, offset: number): boolean {
    return (
      (file.forgotten || file.durable >= offset) &&
      [...file.dependencies].every(
        ([dependency, end]) => dependency.forgotten || dependency.durable >= end
      )
    )
  }

  private settle(): void {
    for (const file of this.files.values()) {
      for (const [dependency, end] of file.dependencies) {
        if (dependency.forgotten || dependency.durable >= end) file.dependencies.delete(dependency)
      }
      const pending: Waiter[] = []
      for (const waiter of file.waiters) {
        if (file.forgetting && !file.forgotten && !file.closeFailed) {
          pending.push(waiter)
          continue
        }
        if (file.forgotten || this.satisfied(file, waiter.offset)) waiter.resolve()
        else if (file.error) waiter.reject(file.error)
        else {
          const dependencyError = [...file.dependencies.keys()].find(
            (dependency) => dependency.error && (!dependency.forgetting || dependency.closeFailed)
          )
          if (dependencyError?.error) waiter.reject(dependencyError.error)
          else pending.push(waiter)
        }
      }
      file.waiters = pending
    }
  }

  private fail(file: FileState, error: Error): void {
    file.error = error
    this.counters.errors++
    this.settle()
  }

  private joinFlight(): void {
    const flight = this.flight
    if (!flight) return
    if (!flight.ticket) throw new Error('Fsync adapter reentered before returning its ticket')
    flight.ticket.joinSync()
    if (this.flight === flight)
      throw new Error('Fsync adapter failed its synchronous join contract')
  }

  private sync(file: FileState, reason: 'strict' | 'escalation' | 'hard' | 'drain'): void {
    this.syncDepth++
    try {
      this.joinFlight()
      for (const [dependency, end] of file.dependencies) {
        if (!dependency.forgotten && dependency.durable < end) {
          if (dependency.forgetting) throw new Error('Dependency adoption is not complete')
          this.counters.dependencySyncFsyncs++
          this.syncOne(dependency)
        }
      }
      if (file.durable < file.end || file.error) {
        if (reason === 'strict') this.counters.strictFsyncs++
        if (reason === 'hard') this.counters.hardBoundFsyncs++
        this.syncOne(file)
      }
      this.settle()
    } finally {
      this.syncDepth--
    }
  }

  private syncOne(file: FileState): void {
    this.counters.syncFsyncs++
    try {
      this.ports.fsyncSync(file.fd)
      file.durable = file.end
      file.dirtySince = undefined
      file.nextDirtySince = undefined
      file.prompt = false
      file.error = undefined
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.fail(file, failure)
      throw failure
    }
  }

  private finishForget(file: FileState): void {
    try {
      this.ports.close(file.fd)
      file.forgotten = true
      file.dependencies.clear()
      file.error = undefined
      file.durable = file.end
      this.settle()
      for (const waiter of file.waiters) waiter.resolve()
      file.waiters = []
      this.files.delete(file)
      file.finishForget?.resolve()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      file.closeFailed = true
      this.fail(file, failure)
      file.finishForget?.reject(failure)
    }
  }

  private pump(): void {
    if (this.pumping || this.syncDepth > 0) return
    this.pumping = true
    try {
      if (this.timer !== undefined) this.ports.clearTimer(this.timer)
      this.timer = undefined
      const now = this.ports.now()
      const softDeadline = this.snapshot().softDeadlineMs
      const candidates = [...this.files.values()].filter(
        (file) => !file.forgetting && !file.forgotten && file.durable < file.end && !file.error
      )
      for (const file of candidates) {
        if (now - file.dirtySince! >= 5000) {
          try {
            this.sync(file, 'hard')
          } catch (error) {
            if (!file.error)
              this.fail(file, error instanceof Error ? error : new Error(String(error)))
          }
        }
      }
      const priority = new Map<FileState, number>()
      for (const file of candidates) {
        const rank = file.waiters.length > 0 ? 0 : file.prompt ? 1 : 2
        priority.set(file, Math.min(priority.get(file) ?? 2, rank))
        for (const [dependency, offset] of file.dependencies) {
          if (dependency.durable < offset && !dependency.forgotten) {
            priority.set(dependency, Math.min(priority.get(dependency) ?? 2, rank))
          }
        }
      }
      const due = candidates.filter((file) => {
        if (file.error || file.durable >= file.end) return false
        if (
          [...file.dependencies].some(
            ([dependency, offset]) => !dependency.forgotten && dependency.durable < offset
          )
        ) {
          return false
        }
        return (
          (priority.get(file) ?? 2) < 2 ||
          file.end - file.durable >= 256 * 1024 ||
          now - file.dirtySince! >= softDeadline
        )
      })
      due.sort(
        (a, b) => (priority.get(a) ?? 2) - (priority.get(b) ?? 2) || a.dirtySince! - b.dirtySince!
      )
      if (!this.flight && due[0]) this.start(due[0])
      this.settle()
      const delays = candidates
        .filter((file) => !file.error && file.durable < file.end)
        .map((file) => {
          const age = now - file.dirtySince!
          return Math.max(
            1,
            Math.min(5000 - age, age < softDeadline ? softDeadline - age : 5000 - age)
          )
        })
      if (delays.length > 0) {
        this.timer = this.ports.setTimer(
          () => {
            this.timer = undefined
            this.pump()
          },
          Math.min(...delays)
        )
      }
    } finally {
      this.pumping = false
    }
  }

  private start(file: FileState): void {
    const flight: Flight = { file, end: file.end, started: this.ports.now() }
    this.flight = flight
    file.nextDirtySince = undefined
    this.counters.asyncFsyncs++
    const complete = (error?: Error): void => {
      if (this.flight !== flight) return
      this.flight = undefined
      if (error) this.fail(file, error)
      else {
        file.durable = Math.max(file.durable, flight.end)
        file.dirtySince = file.end > flight.end ? file.nextDirtySince : undefined
        file.nextDirtySince = undefined
        if (file.durable === file.end) file.prompt = false
        const elapsed = this.ports.now() - flight.started
        if (elapsed > 0) this.capacity = this.capacity * 0.8 + (1000 / elapsed) * 0.2
      }
      if (file.forgetting) this.finishForget(file)
      this.settle()
      this.pump()
    }
    try {
      flight.ticket = this.ports.fsync(file.fd, complete)
    } catch (error) {
      complete(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

import { describe, expect, it } from 'vitest'
import {
  MainDurabilityFlusher,
  type DurabilityFile,
  type DurabilityFlusherPorts
} from './MainDurabilityFlusher'

/** The red stub is a scheduler that never flushes. The mutation probes below
 * additionally delete priority inheritance, escalation and the adoption fence.
 */
class VirtualDisk implements DurabilityFlusherPorts {
  time = 0
  latency = 1000 / 45
  failNext = false
  readonly log: { fd: number; kind: 'async' | 'sync' | 'close'; at: number }[] = []
  readonly timers = new Map<number, { at: number; callback(): void }>()
  private timerId = 0
  private active = 0
  maxActive = 0
  readonly activeByFd = new Map<number, number>()
  maxPerFile = 0

  now(): number {
    return this.time
  }

  setTimer(callback: () => void, delayMs: number): number {
    const id = ++this.timerId
    this.timers.set(id, { at: this.time + delayMs, callback })
    return id
  }

  clearTimer(timer: unknown): void {
    this.timers.delete(timer as number)
  }

  fsync(fd: number, complete: (error?: Error) => void): { joinSync(): void } {
    this.log.push({ fd, kind: 'async', at: this.time })
    this.enter(fd)
    const fail = this.failNext
    this.failNext = false
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      this.clearTimer(timer)
      this.leave(fd)
      complete(fail ? new Error('injected fsync failure') : undefined)
    }
    const timer = this.setTimer(finish, this.latency)
    return { joinSync: finish }
  }

  fsyncSync(fd: number): void {
    this.log.push({ fd, kind: 'sync', at: this.time })
    this.enter(fd)
    this.leave(fd)
    if (this.failNext) {
      this.failNext = false
      throw new Error('injected sync failure')
    }
  }

  close(fd: number): void {
    expect(this.activeByFd.get(fd) ?? 0).toBe(0)
    this.log.push({ fd, kind: 'close', at: this.time })
  }

  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.time = end
  }

  private enter(fd: number): void {
    this.active++
    this.activeByFd.set(fd, (this.activeByFd.get(fd) ?? 0) + 1)
    this.maxActive = Math.max(this.maxActive, this.active)
    this.maxPerFile = Math.max(this.maxPerFile, this.activeByFd.get(fd)!)
  }

  private leave(fd: number): void {
    this.active--
    this.activeByFd.set(fd, this.activeByFd.get(fd)! - 1)
  }
}

function setup(): { disk: VirtualDisk; flusher: MainDurabilityFlusher } {
  const disk = new VirtualDisk()
  return { disk, flusher: new MainDurabilityFlusher(disk) }
}

describe('MainDurabilityFlusher pure model', () => {
  it('transfers cold-create debt atomically without fsync and preserves sealed barriers', async () => {
    const { disk, flusher } = setup()
    const directory = flusher.open(1, 1, 10)
    const sealed = flusher.open(1, 2, 11)
    const active = flusher.open(1, 3, 12)
    flusher.noteWrite(directory, 1, 'soft')
    flusher.noteWrite(sealed, 1, 'soft', { after: [{ file: directory, offset: 1 }] })
    flusher.transferDependencies(sealed, active, 1)
    expect(disk.log).toHaveLength(0)
    expect(() => flusher.noteWrite(sealed, 2, 'soft')).toThrow('sealed')
    flusher.noteWrite(active, 1, 'soft')
    const sealedBarrier = flusher.awaitDurable(sealed, 1)
    const activeBarrier = flusher.awaitDurable(active, 1)
    disk.advance(100)
    await Promise.all([sealedBarrier, activeBarrier])
    expect(flusher.counters.syncFsyncs).toBe(0)
    expect(disk.log.map((row) => row.fd)).toEqual([10, 11, 12])
  })

  it('keeps existing sealed waiters and shared-directory errors after custody transfer', async () => {
    const { disk, flusher } = setup()
    const blocker = flusher.open(1, 9, 9)
    const directory = flusher.open(1, 1, 10)
    const sealed = flusher.open(1, 2, 11)
    const active = flusher.open(1, 3, 12)
    flusher.noteWrite(blocker, 1, 'prompt')
    flusher.noteWrite(directory, 1, 'soft')
    flusher.noteWrite(sealed, 1, 'soft', { after: [{ file: directory, offset: 1 }] })
    const sealedRejected = expect(flusher.awaitDurable(sealed, 1)).rejects.toThrow('injected')
    flusher.transferDependencies(sealed, active, 1)
    flusher.noteWrite(active, 1, 'soft')
    const activeRejected = expect(flusher.awaitDurable(active, 1)).rejects.toThrow('injected')
    disk.failNext = true
    disk.advance(100)
    await Promise.all([sealedRejected, activeRejected])
    expect(flusher.counters.errors).toBe(1)
    flusher.noteWrite(active, 2, 'sync')
    await flusher.awaitDurable(sealed, 1)
    await flusher.awaitDurable(active, 2)
  })

  it('aborts invalid transfer without dropping predecessor name debt', async () => {
    const { disk, flusher } = setup()
    const directory = flusher.open(1, 1, 10)
    const sealed = flusher.open(1, 2, 11)
    const active = flusher.open(1, 3, 12)
    flusher.noteWrite(directory, 1, 'soft')
    flusher.noteWrite(sealed, 1, 'soft', { after: [{ file: directory, offset: 1 }] })
    expect(() => flusher.transferDependencies(sealed, active, 2)).toThrow('extent')
    expect(() => flusher.transferDependencies(sealed, sealed, 1)).toThrow('same')
    flusher.noteWrite(sealed, 2, 'sync')
    expect(disk.log.map((row) => row.fd)).toEqual([10, 11])
    await flusher.awaitDurable(sealed, 2)
  })

  it('joins pending cold-create prerequisites before strict successor acknowledgement', async () => {
    const { disk, flusher } = setup()
    const directory = flusher.open(1, 1, 10)
    const sealed = flusher.open(1, 2, 11)
    const active = flusher.open(1, 3, 12)
    flusher.noteWrite(directory, 1, 'soft')
    flusher.noteWrite(sealed, 1, 'soft', { after: [{ file: directory, offset: 1 }] })
    const existing = flusher.awaitDurable(sealed, 1)
    flusher.transferDependencies(sealed, active, 1)
    flusher.noteWrite(active, 1, 'sync')
    await existing
    await flusher.awaitDurable(active, 1)
    expect(disk.maxActive).toBe(1)
    expect(disk.log.map((row) => row.fd)).toEqual([10, 11, 12])
  })
  it('retries a failed close synchronously and settles overlapping asynchronous retirement', async () => {
    const { disk, flusher } = setup()
    const file = flusher.open(1, 1, 10)
    flusher.noteWrite(file, 1, 'soft')
    const realClose = disk.close.bind(disk)
    let attempts = 0
    disk.close = (fd) => {
      if (++attempts === 1) throw new Error('first close failed')
      realClose(fd)
    }
    const asynchronous = expect(flusher.forget([file])).rejects.toThrow('first close failed')
    await asynchronous
    expect(() => flusher.forgetSync([file])).not.toThrow()
    await flusher.forget([file])
    expect(attempts).toBe(2)
    expect(disk.log.map((row) => row.kind)).toEqual(['close'])
    await flusher.awaitDurable(file, 1)
  })
  it('synchronous deletion joins inflight work, closes, and settles concurrent forget', async () => {
    const { disk, flusher } = setup()
    const file = flusher.open(1, 1, 10)
    flusher.noteWrite(file, 1, 'prompt')
    const pending = flusher.forget([file])
    flusher.forgetSync([file])
    await pending
    expect(disk.log.map((row) => row.kind)).toEqual(['async', 'close'])
  })
  it('contains timer hard-bound failures and continues scheduling unaffected files', async () => {
    const { disk, flusher } = setup()
    disk.latency = 6000
    const broken = flusher.open(1, 1, 10)
    const healthy = flusher.open(1, 2, 11)
    flusher.noteWrite(broken, 1, 'prompt')
    disk.advance(10)
    flusher.noteWrite(broken, 2, 'soft')
    flusher.noteWrite(healthy, 1, 'soft')
    disk.failNext = true
    expect(() => disk.advance(4990)).not.toThrow()
    await expect(flusher.awaitDurable(broken, 2)).rejects.toThrow('injected')
    flusher.noteWrite(healthy, 2, 'sync')
    await flusher.awaitDurable(healthy, 2)
    expect(flusher.counters.errors).toBe(1)
  })

  it('adoption waits for close before settling a failed inflight inode and its dependents', async () => {
    const { disk, flusher } = setup()
    const sealed = flusher.open(1, 1, 10)
    const active = flusher.open(1, 2, 11)
    disk.failNext = true
    flusher.noteWrite(sealed, 1, 'prompt')
    flusher.noteWrite(active, 1, 'soft', { after: [{ file: sealed, offset: 1 }] })
    const sealedBarrier = flusher.awaitDurable(sealed, 1)
    const activeBarrier = flusher.awaitDurable(active, 1)
    const forgotten = flusher.forget([sealed])
    disk.advance(80)
    await forgotten
    await sealedBarrier
    await activeBarrier
    expect(disk.log.map(({ kind }) => kind)).toEqual(['async', 'close', 'async'])
  })

  it('failed close preserves adoption failure and rejects affected barriers', async () => {
    const { disk, flusher } = setup()
    const sealed = flusher.open(1, 1, 10)
    disk.failNext = true
    flusher.noteWrite(sealed, 1, 'prompt')
    const barrier = expect(flusher.awaitDurable(sealed, 1)).rejects.toThrow('close failure')
    disk.close = () => {
      throw new Error('close failure')
    }
    const forgotten = expect(flusher.forget([sealed])).rejects.toThrow('close failure')
    disk.advance(30)
    await forgotten
    await barrier
    await expect(flusher.awaitDurable(sealed, 1)).rejects.toThrow('close failure')
  })

  it('bounds concurrency and age for 32 files and 2,000 writes without retaining payloads', async () => {
    const { disk, flusher } = setup()
    const files = Array.from({ length: 32 }, (_, i) => flusher.open(1, i + 1, i + 10))
    const offsets = files.map(() => 0)
    for (let i = 0; i < 2000; i++) {
      const index = i % files.length
      offsets[index] += 1024
      flusher.noteWrite(files[index], offsets[index], 'soft')
      disk.advance(2)
    }
    disk.advance(2000)
    await Promise.all(files.map((file, i) => flusher.awaitDurable(file, offsets[i])))
    expect(disk.maxActive).toBe(1)
    expect(disk.maxPerFile).toBe(1)
    expect(flusher.counters.hardBoundFsyncs).toBe(0)
    expect(flusher.counters.syncFsyncs).toBe(0)
    expect(flusher.snapshot().dirtyFiles).toBe(0)
    expect(flusher.counters.asyncFsyncs).toBeLessThan(200)
  })

  it('flushes 90 files at 45 fsyncs/s within the hard bound', async () => {
    const { disk, flusher } = setup()
    const files = Array.from({ length: 90 }, (_, i) => flusher.open(1, i + 1, i + 10))
    for (const file of files) flusher.noteWrite(file, 200, 'soft')
    expect(flusher.snapshot().softDeadlineMs).toBe(2000)
    disk.advance(4500)
    await Promise.all(files.map((file) => flusher.awaitDurable(file, 200)))
    expect(flusher.counters.asyncFsyncs).toBe(90)
    expect(flusher.counters.hardBoundFsyncs).toBe(0)
    expect(disk.log.at(-1)!.at).toBeLessThan(4000)
  })

  it('clamps the adaptive deadline at four seconds when measured capacity sags', () => {
    const disk = new VirtualDisk()
    const flusher = new MainDurabilityFlusher(disk, 1)
    for (let i = 0; i < 90; i++) flusher.noteWrite(flusher.open(1, i, i), 1, 'soft')
    expect(flusher.snapshot().softDeadlineMs).toBe(4000)
  })

  it('starts at the byte threshold and does not acknowledge bytes appended during fsync', async () => {
    const { disk, flusher } = setup()
    const file = flusher.open(1, 1, 10)
    flusher.noteWrite(file, 256 * 1024 - 1, 'soft')
    expect(disk.log).toEqual([])
    flusher.noteWrite(file, 256 * 1024, 'soft')
    expect(disk.log).toHaveLength(1)
    disk.advance(10)
    flusher.noteWrite(file, 256 * 1024 + 1, 'soft')
    let settled = false
    const barrier = flusher.awaitDurable(file, 256 * 1024 + 1).then(() => {
      settled = true
    })
    disk.advance(15)
    await Promise.resolve()
    expect(settled).toBe(false)
    disk.advance(30)
    await barrier
    expect(disk.log).toHaveLength(2)
  })

  it('inherits barrier priority for both sealed-tail and create-directory dependencies', async () => {
    const { disk, flusher } = setup()
    const blocking = flusher.open(1, 1, 10)
    const prompt = flusher.open(1, 2, 11)
    const sealed = flusher.open(1, 3, 12)
    const directory = flusher.open(1, 4, 13)
    const active = flusher.open(1, 5, 14)
    flusher.noteWrite(blocking, 1, 'prompt')
    flusher.noteWrite(prompt, 1, 'prompt')
    flusher.noteWrite(sealed, 1, 'soft')
    flusher.noteWrite(directory, 1, 'soft')
    flusher.noteWrite(active, 1, 'soft', {
      after: [
        { file: sealed, offset: 1 },
        { file: directory, offset: 1 }
      ]
    })
    const barrier = flusher.awaitDurable(active, 1)
    disk.advance(150)
    await barrier
    expect(disk.log.map(({ fd }) => fd)).toEqual([10, 12, 13, 14, 11])
  })

  it('flushes dependencies synchronously before a strict acknowledgement', () => {
    const { disk, flusher } = setup()
    const directory = flusher.open(1, 1, 10)
    const detail = flusher.open(1, 2, 11)
    const journal = flusher.open(1, 3, 12)
    flusher.noteWrite(directory, 1, 'soft')
    flusher.noteWrite(detail, 100, 'soft')
    flusher.noteWrite(journal, 200, 'sync', {
      after: [
        { file: directory, offset: 1 },
        { file: detail, offset: 100 }
      ]
    })
    expect(disk.log.map(({ fd }) => fd)).toEqual([10, 11, 12])
    expect(flusher.counters.dependencySyncFsyncs).toBe(2)
    expect(flusher.counters.strictFsyncs).toBe(1)
  })

  it('joins an outstanding operation before strict fsync without exceeding concurrency', () => {
    const { disk, flusher } = setup()
    const first = flusher.open(1, 1, 10)
    const second = flusher.open(1, 2, 11)
    flusher.noteWrite(first, 1, 'prompt')
    flusher.noteWrite(second, 1, 'sync')
    expect(disk.maxActive).toBe(1)
    expect(disk.log.map(({ kind }) => kind)).toEqual(['async', 'sync'])
  })

  it('fails barriers closed, leaves errors sticky, and escalates the next write', async () => {
    const { disk, flusher } = setup()
    const file = flusher.open(1, 1, 10)
    disk.failNext = true
    flusher.noteWrite(file, 1, 'prompt')
    const failed = expect(flusher.awaitDurable(file, 1)).rejects.toThrow('injected')
    disk.advance(30)
    await failed
    await expect(flusher.awaitDurable(file, 1)).rejects.toThrow('injected')
    disk.advance(1000)
    expect(disk.log).toHaveLength(1)
    flusher.noteWrite(file, 2, 'soft')
    await flusher.awaitDurable(file, 2)
    expect(flusher.counters.escalations).toBe(1)
    expect(disk.log.at(-1)!.kind).toBe('sync')
  })

  it('keeps a failed synchronous retry sticky until a later successful write', async () => {
    const { disk, flusher } = setup()
    const file = flusher.open(1, 1, 10)
    disk.failNext = true
    expect(() => flusher.noteWrite(file, 1, 'sync')).toThrow('injected')
    disk.failNext = true
    expect(() => flusher.noteWrite(file, 2, 'soft')).toThrow('injected')
    await expect(flusher.awaitDurable(file, 2)).rejects.toThrow('injected')
    flusher.noteWrite(file, 3, 'soft')
    await flusher.awaitDurable(file, 3)
    expect(flusher.counters.escalations).toBe(2)
  })

  it('rejects a dependent barrier on failure and escalates its next write', async () => {
    const { disk, flusher } = setup()
    const detail = flusher.open(1, 1, 10)
    const journal = flusher.open(1, 2, 11)
    disk.failNext = true
    flusher.noteWrite(detail, 1, 'prompt')
    flusher.noteWrite(journal, 1, 'soft', { after: [{ file: detail, offset: 1 }] })
    const failed = expect(flusher.awaitDurable(journal, 1)).rejects.toThrow('injected')
    disk.advance(30)
    await failed
    flusher.noteWrite(journal, 2, 'soft')
    await flusher.awaitDurable(journal, 2)
    expect(flusher.counters.escalations).toBe(1)
    expect(disk.log.map(({ fd, kind }) => `${fd}:${kind}`)).toEqual([
      '10:async',
      '10:sync',
      '11:sync'
    ])
  })

  it('fails closed if an adapter cannot synchronously join the existing operation', () => {
    const disk = new VirtualDisk()
    const ports: DurabilityFlusherPorts = {
      now: () => disk.now(),
      setTimer: (callback, delay) => disk.setTimer(callback, delay),
      clearTimer: (timer) => disk.clearTimer(timer),
      fsync: (fd, complete) => {
        disk.fsync(fd, complete)
        return { joinSync: () => {} }
      },
      fsyncSync: (fd) => disk.fsyncSync(fd),
      close: (fd) => disk.close(fd)
    }
    const flusher = new MainDurabilityFlusher(ports)
    const first = flusher.open(1, 1, 10)
    const second = flusher.open(1, 2, 11)
    flusher.noteWrite(first, 1, 'prompt')
    expect(() => flusher.noteWrite(second, 1, 'sync')).toThrow('join contract')
    expect(disk.log).toHaveLength(1)
    expect(disk.maxActive).toBe(1)
  })

  it('cancels queued work, awaits inflight fsync and closes before adoption discharges barriers', async () => {
    const { disk, flusher } = setup()
    const sealed = flusher.open(1, 1, 10)
    const active = flusher.open(1, 2, 11)
    flusher.noteWrite(sealed, 10, 'prompt')
    flusher.noteWrite(active, 20, 'soft', { after: [{ file: sealed, offset: 10 }] })
    const barrier = flusher.awaitDurable(active, 20)
    let forgotten = false
    const forget = flusher.forget([sealed]).then(() => {
      forgotten = true
    })
    await Promise.resolve()
    expect(forgotten).toBe(false)
    expect(disk.log.map(({ kind }) => kind)).toEqual(['async'])
    disk.advance(80)
    await forget
    await barrier
    expect(disk.log.map(({ fd, kind }) => `${fd}:${kind}`)).toEqual([
      '10:async',
      '10:close',
      '11:async'
    ])
    expect(() => flusher.noteWrite(sealed, 11, 'soft')).toThrow('forgotten')
  })

  it('discharges adopted queued dependencies and does not start their cancelled fsync', async () => {
    const { disk, flusher } = setup()
    const sealed = flusher.open(1, 1, 10)
    const active = flusher.open(1, 2, 11)
    flusher.noteWrite(sealed, 10, 'soft')
    flusher.noteWrite(active, 20, 'soft', { after: [{ file: sealed, offset: 10 }] })
    await flusher.forget([sealed])
    const barrier = flusher.awaitDurable(active, 20)
    disk.advance(30)
    await barrier
    expect(disk.log.map(({ fd, kind }) => `${fd}:${kind}`)).toEqual(['10:close', '11:async'])
  })

  it('keys generations independently of paths, rejects duplicate inode owners and forged identities', async () => {
    const { disk, flusher } = setup()
    const old = flusher.open(1, 42, 10)
    expect(() => flusher.open(1, 42, 11)).toThrow('already registered')
    expect(() => flusher.noteWrite({ ...old }, 1, 'soft')).toThrow('Unknown')
    await flusher.forget([old])
    const fresh = flusher.open(1, 42, 10)
    expect(fresh.generation).toBeGreaterThan(old.generation)
    flusher.noteWrite(fresh, 1, 'soft')
    const barrier = flusher.awaitDurable(fresh, 1)
    disk.advance(30)
    await barrier
  })

  it('rejects transitive dependencies in either declaration order and validates extents atomically', () => {
    const { flusher } = setup()
    const a = flusher.open(1, 1, 10)
    const b = flusher.open(1, 2, 11)
    const c = flusher.open(1, 3, 12)
    flusher.noteWrite(a, 1, 'soft')
    flusher.noteWrite(b, 1, 'soft', { after: [{ file: a, offset: 1 }] })
    expect(() => flusher.noteWrite(c, 1, 'soft', { after: [{ file: b, offset: 1 }] })).toThrow(
      'depth one'
    )
    expect(() => flusher.noteWrite(a, 2, 'soft', { after: [{ file: c, offset: 0 }] })).toThrow(
      'depth one'
    )
    expect(() => flusher.noteWrite(c, 1, 'soft', { after: [{ file: a, offset: 2 }] })).toThrow(
      'extent'
    )
    expect(() => flusher.noteWrite(a, -1, 'soft')).toThrow('offset')
    expect(() => flusher.noteWrite(a, 0, 'soft')).toThrow('regressed')
  })

  it('counts a five-second hard-bound sync and joins existing work first', () => {
    const { disk, flusher } = setup()
    disk.latency = 6000
    const file = flusher.open(1, 1, 10)
    flusher.noteWrite(file, 1, 'prompt')
    disk.advance(10)
    flusher.noteWrite(file, 2, 'soft')
    disk.advance(4990)
    expect(flusher.counters.hardBoundFsyncs).toBe(1)
    expect(disk.maxActive).toBe(1)
    expect(flusher.snapshot().dirtyFiles).toBe(0)
  })

  it('drains dependencies and all remaining files synchronously at teardown', async () => {
    const { disk, flusher } = setup()
    const files: DurabilityFile[] = []
    for (let i = 0; i < 4; i++) {
      const file = flusher.open(1, i, i + 10)
      files.push(file)
      flusher.noteWrite(file, 1, 'soft')
    }
    flusher.drainSync()
    await Promise.all(files.map((file) => flusher.awaitDurable(file, 1)))
    expect(disk.log.map(({ kind }) => kind)).toEqual(['sync', 'sync', 'sync', 'sync'])
    expect(flusher.snapshot().dirtyFiles).toBe(0)
    expect(disk.timers.size).toBe(0)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { MainDurabilityDirectoryLeases } from './MainDurabilityDirectoryLeases'

describe('profile directory leases', () => {
  it('fences shutdown acquisition and waits for participants before final close', async () => {
    const a = registry.acquire(root)
    const b = registry.acquire(root)
    let done = false
    const retirement = registry.retire().then(() => {
      done = true
    })
    expect(() => registry.acquire(root)).toThrow('retired')
    await a.release()
    await Promise.resolve()
    expect(done).toBe(false)
    expect(closed).toHaveLength(0)
    await b.release()
    await retirement
    expect(closed).toHaveLength(1)
  })

  it('registry retirement retries a failed final close without forcing leased descriptors', async () => {
    const lease = registry.acquire(root)
    failClose = true
    await expect(lease.release()).rejects.toThrow('close failed')
    await registry.retire()
    expect(closed).toHaveLength(1)
  })
  let root: string
  let flusher: MainDurabilityFlusher
  let registry: MainDurabilityDirectoryLeases
  let completions: (() => void)[]
  let closed: number[]
  let failClose: boolean
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-directory-leases-'))
    completions = []
    closed = []
    failClose = false
    flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (_fd, done) => {
        const finish = () => done()
        completions.push(finish)
        return { joinSync: finish }
      },
      // This fixture exercises lease accounting; directory flushing is not a
      // Windows syscall. Production consumers omit directory leases there.
      fsyncSync: (fd) => {
        if (process.platform !== 'win32') fs.fsyncSync(fd)
      },
      close: (fd) => {
        if (failClose) {
          failClose = false
          throw new Error('close failed')
        }
        fs.closeSync(fd)
        closed.push(fd)
      }
    })
    registry = new MainDurabilityDirectoryLeases(flusher)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('ledger and journal cold-parent consumers share one fd/token and ordered creation debt', () => {
    const opens = vi.spyOn(fs, 'openSync')
    const ledger = registry.acquire(root)
    const journal = registry.acquire(path.join(root, '.'))
    const a = ledger.noteMutation()
    const b = journal.noteMutation()
    expect(a.file).toBe(b.file)
    expect([a.offset, b.offset]).toEqual([1, 2])
    expect(opens).toHaveBeenCalledTimes(1)
    ledger.releaseSync()
    expect(closed).toHaveLength(0)
    journal.noteMutation()
    journal.releaseSync()
    expect(closed).toHaveLength(1)
  })

  it('retains creation debt after failed registration and covers it on retry', () => {
    const lease = registry.acquire(root)
    const original = flusher.noteWrite.bind(flusher)
    const note = vi.spyOn(flusher, 'noteWrite').mockImplementationOnce(() => {
      throw new Error('registration failed')
    })
    expect(() => lease.noteMutation()).toThrow('registration failed')
    note.mockImplementation(original)
    expect(lease.noteMutation().offset).toBe(2)
    flusher.drainSync()
    lease.releaseSync()
  })

  it('closes unmanaged descriptor when flusher registration collides', () => {
    vi.spyOn(flusher, 'open').mockImplementationOnce(() => {
      throw new Error('collision')
    })
    const close = vi.spyOn(fs, 'closeSync')
    expect(() => registry.acquire(root)).toThrow('collision')
    expect(close).toHaveBeenCalledOnce()
  })

  it('strict file acknowledgements flush the shared flat directory dependency first', () => {
    const lease = registry.acquire(root)
    const debt = lease.noteMutation()
    const fd = fs.openSync(path.join(root, 'created'), 'a+')
    fs.writeSync(fd, '{}\n')
    const stat = fs.fstatSync(fd)
    const file = flusher.open(stat.dev, stat.ino, fd)
    flusher.noteWrite(file, 3, 'sync', { after: [debt] })
    expect(flusher.counters.dependencySyncFsyncs).toBe(1)
    flusher.forgetSync([file])
    lease.releaseSync()
  })

  it('awaits final inflight retirement, blocks acquisition, and fences stale leases across generations', async () => {
    const lease = registry.acquire(root)
    const old = lease.noteMutation()
    const barrier = flusher.awaitDurable(old.file, old.offset)
    const pending = lease.release()
    expect(() => registry.acquire(root)).toThrow('retirement')
    lease.releaseSync()
    await pending
    await barrier
    expect(() => lease.noteMutation()).toThrow('released')
    const next = registry.acquire(root)
    expect(next.noteMutation().file.generation).toBeGreaterThan(old.file.generation)
    lease.releaseSync()
    expect(closed).toHaveLength(1)
    next.releaseSync()
    expect(closed).toHaveLength(2)
  })

  it('retries failed final async close without reviving released mutation authority', async () => {
    const lease = registry.acquire(root)
    lease.noteMutation()
    failClose = true
    await expect(lease.release()).rejects.toThrow('close failed')
    expect(() => registry.acquire(root)).toThrow('retirement')
    expect(() => lease.noteMutation()).toThrow('released')
    await lease.release()
    expect(closed).toHaveLength(1)
    const next = registry.acquire(root)
    next.releaseSync()
  })

  it('retries failed synchronous close and never decrements reference counts twice', async () => {
    const a = registry.acquire(root)
    const b = registry.acquire(root)
    await a.release()
    await a.release()
    failClose = true
    expect(() => b.releaseSync()).toThrow('close failed')
    b.releaseSync()
    await b.release()
    expect(closed).toHaveLength(1)
  })
})

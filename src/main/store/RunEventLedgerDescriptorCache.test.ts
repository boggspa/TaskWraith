import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it, expect } from 'vitest'
import { vi } from 'vitest'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { RunEventLedgerDescriptorCache } from './RunEventLedgerDescriptorCache'
import { MainDurabilityDirectoryLeases } from './MainDurabilityDirectoryLeases'

it.each([false, true])(
  'closes failed data registration and preserves strict create debt (shared=%s)',
  (shared) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cache-admission-'))
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (_fd, done) => ({ joinSync: () => done() }),
      fsyncSync: (fd) => fs.fsyncSync(fd),
      close: (fd) => fs.closeSync(fd)
    })
    const cache = new RunEventLedgerDescriptorCache(
      flusher,
      128,
      shared ? new MainDurabilityDirectoryLeases(flusher) : undefined
    )
    const realOpen = flusher.open.bind(flusher)
    let failedFd: number | undefined
    const registration = vi.spyOn(flusher, 'open').mockImplementation((dev, ino, fd, offset) => {
      if (failedFd === undefined && fs.fstatSync(fd).isFile()) {
        failedFd = fd
        throw new Error('data registration failed')
      }
      return realOpen(dev, ino, fd, offset)
    })
    try {
      const ledger = path.join(root, 'ledger')
      expect(() => cache.append('run', ledger, '{}\n', 'sync')).toThrow('data registration failed')
      expect(() => fs.fstatSync(failedFd!)).toThrow()
      cache.append('run', ledger, '{}\n', 'sync')
      expect(flusher.counters.dependencySyncFsyncs).toBe(process.platform === 'win32' ? 0 : 1)
      expect(fs.readFileSync(ledger, 'utf8')).toBe('{}\n')
      cache.retireSync()
    } finally {
      registration.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)

it('shares a cold parent with another consumer without duplicate directory registration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-shared-parent-'))
  const flusher = new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (_fd, done) => ({ joinSync: () => done() }),
    fsyncSync: (fd) => fs.fsyncSync(fd),
    close: (fd) => fs.closeSync(fd)
  })
  const registry = new MainDurabilityDirectoryLeases(flusher)
  const journal = registry.acquire(root)
  const cache = new RunEventLedgerDescriptorCache(flusher, 128, registry)
  try {
    journal.noteMutation()
    cache.append('a', path.join(root, 'events', 'a'), '{}\n', 'sync')
    cache.retireSync()
    expect(() => journal.noteMutation()).not.toThrow()
    journal.releaseSync()
    await registry.retire()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('sync retirement propagates close failure and cold mkdir fsyncs its parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cache-parent-'))
  const parentSyncs: string[] = []
  const real = fs.fsyncSync.bind(fs)
  const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    parentSyncs.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file')
    real(fd)
  })
  const flusher = new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (_fd, done) => ({ joinSync: () => done() }),
    fsyncSync: (fd) => fs.fsyncSync(fd),
    close: () => {
      throw new Error('close failed')
    }
  })
  const cache = new RunEventLedgerDescriptorCache(flusher)
  try {
    cache.append('a', path.join(root, 'events', 'a'), '{}\n', 'sync')
    if (process.platform !== 'win32')
      expect(parentSyncs.slice(0, 2)).toEqual(['directory', 'directory'])
    expect(() => cache.retireSync(['a'])).toThrow('close failed')
  } finally {
    spy.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('tracks partial-write extent and covers overlapping scoped/global retirements', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cache-failure-'))
  const callbacks: (() => void)[] = []
  const closed: number[] = []
  const flusher = new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (_fd, done) => {
      const callback = () => done()
      callbacks.push(callback)
      return { joinSync: callback }
    },
    fsyncSync: (fd) => fs.fsyncSync(fd),
    close: (fd) => {
      closed.push(fd)
      fs.closeSync(fd)
    }
  })
  const cache = new RunEventLedgerDescriptorCache(flusher)
  const note = vi.spyOn(flusher, 'noteWrite')
  try {
    fs.writeFileSync(path.join(root, 'a'), '')
    fs.writeFileSync(path.join(root, 'b'), '')
    const write = fs.writeFileSync.bind(fs)
    const stub = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd, data) => {
      write(fd, String(data).slice(0, 2))
      throw new Error('partial')
    })
    expect(() => cache.append('a', path.join(root, 'a'), 'abcdef', 'soft')).toThrow('partial')
    stub.mockRestore()
    expect(note.mock.calls.at(-1)?.[1]).toBe(2)
    cache.append('a', path.join(root, 'a'), '{}\n', 'prompt')
    const a = cache.retire(['a'])
    cache.append('b', path.join(root, 'b'), '{}\n', 'soft')
    const b = cache.retire(['b'])
    expect(closed).toHaveLength(1)
    await b
    expect(() => cache.append('a', path.join(root, 'a'), '{}\n', 'soft')).toThrow('retirement')
    const all = cache.retire()
    cache.retireSync()
    await Promise.all([a, b, all])
    expect(closed).toHaveLength(2)
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('keeps synchronous page-cache visibility and retires after inflight completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ledger-cache-'))
  const callbacks: (() => void)[] = []
  const closed: number[] = []
  const flusher = new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (_fd, done) => {
      const complete = () => done()
      callbacks.push(complete)
      return { joinSync: complete }
    },
    fsyncSync: (fd) => fs.fsyncSync(fd),
    close: (fd) => {
      closed.push(fd)
      fs.closeSync(fd)
    }
  })
  const cache = new RunEventLedgerDescriptorCache(flusher, 2)
  try {
    const ledger = path.join(root, 'run.jsonl')
    cache.append('run', ledger, '{"first":true}\n', 'soft')
    expect(fs.readFileSync(ledger, 'utf8')).toContain('first')
    cache.append('run', ledger, '{"second":true}\n', 'prompt')
    if (process.platform !== 'win32') callbacks[0]()
    const retiring = cache.retire(['run'])
    expect(closed).toHaveLength(0)
    callbacks[process.platform === 'win32' ? 0 : 1]()
    await retiring
    expect(closed.length).toBeGreaterThan(0)
    await cache.retire()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('evicts LRU after joining and flushing, repairs EOF, and admits the next synchronous append', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ledger-lru-'))
  const flusher = new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (_fd, done) => ({ joinSync: () => done() }),
    fsyncSync: (fd) => fs.fsyncSync(fd),
    close: (fd) => fs.closeSync(fd)
  })
  const cache = new RunEventLedgerDescriptorCache(flusher, 2)
  try {
    for (const id of ['a', 'b', 'c']) cache.append(id, path.join(root, id), '{}\n', 'soft')
    fs.appendFileSync(path.join(root, 'b'), 'torn')
    cache.append('b', path.join(root, 'b'), '{}\n', 'sync')
    expect(fs.readFileSync(path.join(root, 'b'), 'utf8')).toContain('torn\n{}\n')
    await cache.retire()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

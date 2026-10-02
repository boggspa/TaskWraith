import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MainDurabilityFsyncAdapter } from './MainDurabilityFsyncAdapter'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'

describe('portable durability worker adapter', () => {
  let root: string
  let entryPath: string
  const adapters: MainDurabilityFsyncAdapter[] = []
  const descriptors: number[] = []

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-fsync-adapter-'))
    entryPath = path.join(root, 'durability-worker.cjs')
    await build({
      entryPoints: ['src/main/store/MainDurabilityFsyncWorker.ts'],
      outfile: entryPath,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      bundle: true
    })
  })

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) await adapter.dispose()
    for (const fd of descriptors.splice(0)) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed by tested owner */
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  function adapter(timeout = 5000): MainDurabilityFsyncAdapter {
    const result = new MainDurabilityFsyncAdapter({ entryPath, joinTimeoutMs: timeout })
    adapters.push(result)
    return result
  }

  function file(name: string): number {
    const fd = fs.openSync(path.join(root, name), 'a+')
    descriptors.push(fd)
    fs.writeSync(fd, 'page-cache bytes\n')
    return fd
  }

  it('joins actual fsync without delivering any main callback and consumes completion once', () => {
    const ports = adapter()
    const fd = file('ledger')
    let calls = 0
    const ticket = ports.fsync(fd, (error) => {
      expect(error).toBeUndefined()
      calls++
    })
    expect(calls).toBe(0)
    ticket.joinSync()
    expect(calls).toBe(1)
    ticket.joinSync()
    expect(calls).toBe(1)
    ports.fsyncSync(fd)
    expect(fs.fstatSync(fd).isFile()).toBe(true)
  })

  it('pins descriptors and refuses a second syscall until the outstanding one joins', () => {
    const ports = adapter()
    const fd = file('ledger')
    const other = file('other')
    const ticket = ports.fsync(fd, () => {})
    expect(() => ports.close(fd)).toThrow('pinned')
    expect(() => ports.fsync(other, () => {})).toThrow('outstanding')
    expect(() => ports.fsyncSync(other)).toThrow('Join')
    ticket.joinSync()
    ports.close(fd)
    expect(() => fs.fstatSync(fd)).toThrow()
  })

  it('settles normal asynchronous completion and keeps fd ownership after worker disposal', async () => {
    const ports = adapter()
    const fd = file('ledger')
    await new Promise<void>((resolve, reject) => {
      ports.fsync(fd, (error) => (error ? reject(error) : resolve()))
    })
    await ports.dispose()
    expect(fs.fstatSync(fd).isFile()).toBe(true)
  })

  it('joins a prompt operation before the flusher performs a strict boundary', () => {
    const ports = adapter()
    const flusher = new MainDurabilityFlusher(ports)
    const fd = file('first')
    const secondFd = file('second')
    const first = fs.fstatSync(fd)
    const second = fs.fstatSync(secondFd)
    const a = flusher.open(first.dev, first.ino, fd)
    const b = flusher.open(second.dev, second.ino, secondFd)
    flusher.noteWrite(a, 17, 'prompt')
    flusher.noteWrite(b, 17, 'sync', { after: [{ file: a, offset: 17 }] })
    expect(flusher.snapshot().dirtyFiles).toBe(0)
    expect(flusher.counters.asyncFsyncs).toBe(1)
    expect(flusher.counters.strictFsyncs).toBe(1)
  })

  it('times out without waiting for worker exit callbacks, retaining the fd until confirmed exit', async () => {
    fs.writeFileSync(entryPath, 'setInterval(() => {}, 1000)\n')
    const ports = adapter(40)
    const fd = file('ledger')
    let error: Error | undefined
    const ticket = ports.fsync(fd, (failure) => {
      error = failure
    })
    const before = performance.now()
    expect(() => ticket.joinSync()).toThrow('timed out')
    expect(performance.now() - before).toBeLessThan(1000)
    expect(error).toBeUndefined()
    expect(() => ports.close(fd)).toThrow('pinned')
    expect(() => ports.fsyncSync(fd)).toThrow('timed out')
    await ports.dispose()
    expect(error).toBeInstanceOf(Error)
    ports.close(fd)
  })

  it('the actual worker refuses changed inode identities and stale generations', async () => {
    const worker = new Worker(entryPath, { trackUnmanagedFds: false, execArgv: [] })
    try {
      const shared = new SharedArrayBuffer(528)
      const words = new Int32Array(shared, 0, 4)
      Atomics.store(words, 0, 1)
      Atomics.store(words, 1, 7)
      const fd = file('ledger')
      const identity = fs.fstatSync(fd, { bigint: true })
      worker.postMessage({ fd, shared, generation: 6, dev: String(identity.dev), ino: '0' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(Atomics.load(words, 0)).toBe(1)
      worker.postMessage({ fd, shared, generation: 7, dev: String(identity.dev), ino: '0' })
      const deadline = performance.now() + 5000
      while (Atomics.load(words, 0) < 3 && performance.now() < deadline) {
        Atomics.wait(words, 0, Atomics.load(words, 0), 50)
      }
      expect(Atomics.load(words, 0)).toBe(4)
      expect(Buffer.from(shared, 16, Atomics.load(words, 2)).toString('utf8')).toContain(
        'identity changed'
      )
    } finally {
      await worker.terminate()
    }
  })
})

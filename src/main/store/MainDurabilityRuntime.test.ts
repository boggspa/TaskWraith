import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMainDurabilityRuntime } from './MainDurabilityRuntime'
import type { DurabilityFlusherPorts } from './MainDurabilityFlusher'
import type { RunEventInput } from './types'

describe('Main durability runtime', () => {
  it('guards catalogue construction resources and permits retry after refusal', async () => {
    const ports = adapter()
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: entry,
      env: { TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY: '1' },
      createAdapter: () => ports
    })
    expect(() =>
      runtime.attachCatalogue(({ directoryLeases }) => {
        directoryLeases.acquire(options().runEventsDir)
        throw new Error('unreachable allocation')
      })
    ).toThrow('resource-free')
    expect(runtime.snapshot().catalogue.attached).toBe(false)
    expect(
      runtime.attachCatalogue(() => ({
        fence: () => {},
        drainSync: () => {},
        retire: async () => {}
      }))
    ).toBe(true)
    await runtime.shutdown()
    expect(ports.events).toEqual(['dispose'])
  })
  let root: string
  let entry: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-durability-runtime-'))
    entry = path.join(root, 'worker.cjs')
    fs.writeFileSync(entry, '// emitted test worker')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  const input: RunEventInput = {
    runId: 'run-1',
    kind: 'provider_raw',
    phase: 'raw',
    source: 'provider',
    payload: { data: 'output' },
    timestamp: '2026-10-02T00:00:00.000Z'
  }
  function options() {
    fs.mkdirSync(path.join(root, 'events'), { recursive: true })
    return {
      runEventsDir: path.join(root, 'events'),
      runArtifactsDir: path.join(root, 'artifacts')
    }
  }
  function adapter(
    fail = false
  ): DurabilityFlusherPorts & { dispose(): Promise<void>; events: string[]; fds: Set<number> } {
    const events: string[] = []
    const fds = new Set<number>()
    return {
      events,
      fds,
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => {
        fds.add(fd)
        return {
          joinSync: () => {
            events.push('join')
            done()
          }
        }
      },
      fsyncSync: (fd) => {
        fds.add(fd)
        events.push('sync')
        if (fail) throw new Error('disk failure')
        fs.fsyncSync(fd)
      },
      close: (fd) => {
        events.push('close')
        fs.closeSync(fd)
        fds.delete(fd)
      },
      dispose: async () => {
        events.push('dispose')
        expect(fds.size).toBe(0)
      }
    }
  }
  it.each([undefined, '0', 'true', '01'])(
    'defaults to legacy for flag %s without constructing a worker',
    async (flag) => {
      const createAdapter = vi.fn()
      const runtime = createMainDurabilityRuntime({
        ...options(),
        env: { TASKWRAITH_RUN_EVENT_FLUSHER: flag },
        createAdapter
      })
      expect(runtime.writer.append(input).sequence).toBe(1)
      expect(runtime.snapshot()).toMatchObject({ requested: false, mode: 'legacy', flusher: null })
      expect(createAdapter).not.toHaveBeenCalled()
      await runtime.shutdown()
      expect(() => runtime.writer.append(input)).toThrow('shutting down')
    }
  )
  it.each(['relative.cjs', '/missing/durability.cjs'])(
    'warns and reports degraded legacy durability for unavailable entry %s',
    async (workerEntryPath) => {
      const warn = vi.fn()
      const createAdapter = vi.fn()
      const runtime = createMainDurabilityRuntime({
        ...options(),
        workerEntryPath,
        env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1' },
        warn,
        createAdapter
      })
      expect(warn).toHaveBeenCalledOnce()
      expect(createAdapter).not.toHaveBeenCalled()
      expect(runtime.snapshot()).toMatchObject({
        requested: true,
        mode: 'degraded',
        failure: 'worker_initialization_failed'
      })
      expect(runtime.writer.append(input).sequence).toBe(1)
      await runtime.shutdown()
    }
  )
  it('fences immediately, drains final page-cache bytes and closes ledger/directory before worker disposal', async () => {
    const ports = adapter()
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: entry,
      env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1' },
      createAdapter: () => ports
    })
    runtime.writer.append(input)
    runtime.writer.append({ ...input, runId: 'run-2' })
    expect(runtime.snapshot().flusher?.dirtyFiles).toBeGreaterThan(0)
    const first = runtime.shutdown()
    expect(runtime.shutdown()).toBe(first)
    expect(() => runtime.writer.append(input)).toThrow('shutting down')
    await first
    expect(ports.events.filter((event) => event === 'close')).toHaveLength(
      process.platform === 'win32' ? 2 : 3
    )
    expect(ports.events.at(-1)).toBe('dispose')
    expect(runtime.snapshot()).toMatchObject({
      mode: 'worker',
      fenced: true,
      closed: true,
      flusher: { dirtyFiles: 0, inFlight: 0 }
    })
    expect(runtime.snapshot().counters?.syncFsyncs).toBeGreaterThan(0)
  })
  it('does not dispose the worker or claim closure when a synchronous drain fails', async () => {
    const ports = adapter(true)
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: entry,
      env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1' },
      createAdapter: () => ports
    })
    runtime.writer.append(input)
    await expect(runtime.shutdown()).rejects.toThrow('disk failure')
    expect(ports.events).not.toContain('dispose')
    expect(runtime.snapshot()).toMatchObject({
      fenced: true,
      closed: false,
      failure: 'shutdown_failed'
    })
    expect(() => runtime.writer.append(input)).toThrow('shutting down')
    // Test-only cleanup of descriptors whose production owner remains pinned.
    await runtime.writer.retire()
  })
  it.each(['drain', 'retire', 'dispose'] as const)(
    'retries failed %s without reopening admission or disposing pinned descriptors',
    async (stage) => {
      const ports = adapter()
      const runtime = createMainDurabilityRuntime({
        ...options(),
        workerEntryPath: entry,
        env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1' },
        createAdapter: () => ports
      })
      runtime.writer.append(input)
      const fault =
        stage === 'drain'
          ? vi.spyOn(runtime.writer, 'drainDurabilitySync').mockImplementationOnce(() => {
              throw new Error('retry failure')
            })
          : stage === 'retire'
            ? vi.spyOn(runtime.writer, 'retire').mockRejectedValueOnce(new Error('retry failure'))
            : vi.spyOn(ports, 'dispose').mockRejectedValueOnce(new Error('retry failure'))
      const first = runtime.shutdown()
      expect(runtime.shutdown()).toBe(first)
      await expect(first).rejects.toThrow('retry failure')
      expect(runtime.snapshot()).toMatchObject({
        fenced: true,
        closed: false,
        failure: 'shutdown_failed'
      })
      expect(() => runtime.writer.append(input)).toThrow('shutting down')
      expect(ports.events).not.toContain('dispose')
      if (stage !== 'dispose') expect(ports.events).not.toContain('close')
      const retry = runtime.shutdown()
      expect(retry).not.toBe(first)
      await retry
      expect(runtime.snapshot()).toMatchObject({ fenced: true, closed: true, failure: null })
      expect(ports.events.at(-1)).toBe('dispose')
      expect(ports.events.filter((event) => event === 'close')).toHaveLength(
        process.platform === 'win32' ? 1 : 2
      )
      fault.mockRestore()
    }
  )
  it('reports a constructor failure honestly and retains legacy strict writes', async () => {
    const warn = vi.fn()
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: entry,
      env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1' },
      warn,
      createAdapter: () => {
        throw new Error('worker unavailable')
      }
    })
    expect(runtime.writer.append(input, { durability: 'strict' }).sequence).toBe(1)
    expect(runtime.snapshot().mode).toBe('degraded')
    expect(warn).toHaveBeenCalledOnce()
    await runtime.shutdown()
  })
  it.each([
    ['0', '0', 0],
    ['1', '0', 1],
    ['0', '1', 1],
    ['1', '1', 1]
  ])('uses one pool for independent run=%s journal=%s flags', async (run, journalFlag, workers) => {
    const ports = adapter()
    const createAdapter = vi.fn(() => ports)
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: entry,
      env: { TASKWRAITH_RUN_EVENT_FLUSHER: run, TASKWRAITH_JOURNAL_FLUSHER: journalFlag },
      createAdapter
    })
    const create = vi.fn(() => ({
      fence: vi.fn(),
      drainSync: vi.fn(),
      retire: vi.fn(async () => {})
    }))
    expect(runtime.attachJournal(create)).toBe(journalFlag === '1')
    expect(createAdapter).toHaveBeenCalledTimes(Number(workers))
    expect(runtime.snapshot()).toMatchObject({
      runEvents: { requested: run === '1', mode: run === '1' ? 'worker' : 'legacy' },
      journal: {
        requested: journalFlag === '1',
        mode: journalFlag === '1' ? 'worker' : 'legacy',
        attached: journalFlag === '1'
      }
    })
    runtime.writer.append(input)
    if (run === '0') expect(runtime.snapshot().flusher?.dirtyFiles ?? 0).toBe(0)
    await runtime.shutdown()
    expect(() => runtime.attachJournal(create)).toThrow('shutting down')
  })
  it('keeps the shared adapter alive across journal retirement failure and retries fenced', async () => {
    const ports = adapter()
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: entry,
      env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1', TASKWRAITH_JOURNAL_FLUSHER: '1' },
      createAdapter: () => ports
    })
    const events: string[] = []
    const retire = vi
      .fn(async () => {
        events.push('retire')
      })
      .mockRejectedValueOnce(new Error('journal close failed'))
    runtime.attachJournal(() => ({
      fence: () => {
        events.push('fence')
      },
      drainSync: () => {
        events.push('drain')
      },
      retire
    }))
    runtime.writer.append(input)
    await expect(runtime.shutdown()).rejects.toThrow('journal close failed')
    expect(events).toEqual(['fence', 'drain'])
    expect(ports.events).not.toContain('dispose')
    expect(runtime.snapshot()).toMatchObject({ fenced: true, closed: false })
    await runtime.shutdown()
    expect(events).toEqual(['fence', 'drain', 'fence', 'drain', 'retire'])
    expect(ports.events.at(-1)).toBe('dispose')
  })
  it('shares a directory inode across ledger and journal and retires it before disposal', async () => {
    if (process.platform === 'win32') return
    const ports = adapter()
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: entry,
      env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1', TASKWRAITH_JOURNAL_FLUSHER: '1' },
      createAdapter: () => ports
    })
    runtime.writer.append(input)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const events: string[] = []
    let acquire!: () => ReturnType<
      import('./MainDurabilityDirectoryLeases').MainDurabilityDirectoryLeases['acquire']
    >
    let lease!: ReturnType<typeof acquire>
    runtime.attachJournal(({ directoryLeases }) => {
      acquire = () => directoryLeases.acquire(options().runEventsDir)
      return {
        fence: () => {
          events.push('fence')
        },
        drainSync: () => {
          events.push('drain')
        },
        retire: async () => {
          await held
          await lease.release()
          events.push('retired')
        }
      }
    })
    lease = acquire()
    lease.noteMutation()
    const shutdown = runtime.shutdown()
    await Promise.resolve()
    expect(ports.events).not.toContain('dispose')
    expect(events).toEqual(['fence', 'drain'])
    release()
    await shutdown
    expect(events.at(-1)).toBe('retired')
    expect(ports.events.filter((event) => event === 'close')).toHaveLength(2)
    expect(ports.events.at(-1)).toBe('dispose')
  })
  it.each(['acquire', 'open', 'transferDependencies'] as const)(
    'refuses construction-time %s without leaking resources and permits retry',
    async (operation) => {
      const ports = adapter()
      const runtime = createMainDurabilityRuntime({
        ...options(),
        workerEntryPath: entry,
        env: { TASKWRAITH_JOURNAL_FLUSHER: '1' },
        createAdapter: () => ports
      })
      expect(() =>
        runtime.attachJournal(({ flusher, directoryLeases }) => {
          if (operation === 'acquire') directoryLeases.acquire(options().runEventsDir)
          else if (operation === 'open') flusher.open(1, 2, 123)
          else
            flusher.transferDependencies(
              { dev: 1, ino: 2, generation: 1 },
              { dev: 1, ino: 3, generation: 2 },
              0
            )
          throw new Error('constructor failed after allocation')
        })
      ).toThrow('resource-free')
      expect(runtime.snapshot().journal.attached).toBe(false)
      expect(runtime.snapshot().flusher).toMatchObject({ dirtyFiles: 0, inFlight: 0 })
      expect(
        runtime.attachJournal(() => ({
          fence: () => {},
          drainSync: () => {},
          retire: async () => {}
        }))
      ).toBe(true)
      await runtime.shutdown()
      expect(ports.events).toEqual(['dispose'])
      expect(runtime.snapshot().closed).toBe(true)
    }
  )
  it('refuses journal attachment in degraded journal-only mode without claiming run-event enablement', async () => {
    const warn = vi.fn()
    const runtime = createMainDurabilityRuntime({
      ...options(),
      workerEntryPath: '/missing/main-worker.cjs',
      env: { TASKWRAITH_JOURNAL_FLUSHER: '1', TASKWRAITH_RUN_EVENT_FLUSHER: '0' },
      warn
    })
    const create = vi.fn()
    expect(runtime.attachJournal(create)).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({
      mode: 'legacy',
      runEvents: { requested: false, mode: 'legacy' },
      journal: { requested: true, mode: 'degraded', attached: false }
    })
    expect(warn).toHaveBeenCalledOnce()
    await runtime.shutdown()
  })
})

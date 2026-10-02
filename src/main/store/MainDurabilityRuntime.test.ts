import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMainDurabilityRuntime } from './MainDurabilityRuntime'
import type { DurabilityFlusherPorts } from './MainDurabilityFlusher'
import type { RunEventInput } from './types'

describe('Main durability runtime', () => {
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
})

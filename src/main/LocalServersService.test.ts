import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocalServersService } from './LocalServersService'
import type {
  LocalServerDetector,
  LocalServerDetectorContext,
  LocalServerEntry,
  LocalServersSnapshot
} from './localServers/types'

function entry(pid: number, ports: number[]): LocalServerEntry {
  return {
    id: String(pid),
    pid,
    name: 'next dev',
    command: 'node next dev',
    ports,
    primaryPort: ports[0],
    origin: 'detected'
  }
}

class FakeDetector implements LocalServerDetector {
  readonly platform: NodeJS.Platform = 'darwin'
  servers: LocalServerEntry[] = []
  shouldThrow = false
  calls = 0
  lastContext: LocalServerDetectorContext | null = null
  async detect(ctx: LocalServerDetectorContext): Promise<LocalServersSnapshot> {
    this.calls += 1
    this.lastContext = ctx
    if (this.shouldThrow) throw new Error('boom')
    return {
      sampledAt: '2026-06-09T00:00:00.000Z',
      servers: this.servers,
      platform: 'darwin',
      detectionAvailable: true
    }
  }
}

describe('LocalServersService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('samples immediately on start and publishes the first snapshot', async () => {
    const detector = new FakeDetector()
    detector.servers = [entry(100, [3000])]
    const service = new LocalServersService({
      getWorkspaces: () => [{ id: 'w', path: '/ws' }],
      detector,
      pollIntervalMs: 1000
    })
    const seen: LocalServersSnapshot[] = []
    service.subscribe((s) => seen.push(s))
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(detector.calls).toBe(1)
    expect(seen).toHaveLength(1)
    expect(service.snapshot().servers.map((s) => s.pid)).toEqual([100])
    service.stop()
  })

  it('only publishes again when the server set changes', async () => {
    const detector = new FakeDetector()
    detector.servers = [entry(100, [3000])]
    const service = new LocalServersService({
      getWorkspaces: () => [],
      detector,
      pollIntervalMs: 1000
    })
    const seen: LocalServersSnapshot[] = []
    service.subscribe((s) => seen.push(s))
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    // identical sample → no new publish
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toHaveLength(1)
    // a new port → publish
    detector.servers = [entry(100, [3000, 3001])]
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toHaveLength(2)
    service.stop()
  })

  it('keeps the prior snapshot when detection throws', async () => {
    const detector = new FakeDetector()
    detector.servers = [entry(100, [3000])]
    const service = new LocalServersService({
      getWorkspaces: () => [],
      detector,
      pollIntervalMs: 1000
    })
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    detector.shouldThrow = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(service.snapshot().servers.map((s) => s.pid)).toEqual([100])
    service.stop()
  })

  it('stop() halts further sampling', async () => {
    const detector = new FakeDetector()
    const service = new LocalServersService({
      getWorkspaces: () => [],
      detector,
      pollIntervalMs: 1000
    })
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterStart = detector.calls
    service.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(detector.calls).toBe(callsAfterStart)
  })

  it('passes workspaces and tracked spawns to the detector', async () => {
    const detector = new FakeDetector()
    const service = new LocalServersService({
      getWorkspaces: () => [{ id: 'w', path: '/ws' }],
      getTracked: () => [{ pid: 9, startedAt: '2026-06-09T00:00:00.000Z', workspacePath: '/ws' }],
      detector,
      pollIntervalMs: 1000
    })
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(detector.lastContext?.workspaces).toEqual([{ id: 'w', path: '/ws' }])
    expect(detector.lastContext?.tracked?.[0]?.pid).toBe(9)
    service.stop()
  })

  it('surfaces plugin-declared local services and marks matching ports as running', async () => {
    const detector = new FakeDetector()
    detector.servers = [entry(100, [4173])]
    const service = new LocalServersService({
      getWorkspaces: () => [],
      getDeclaredServices: () => [
        {
          id: 'plugin:web-qa:service:browser',
          label: 'Browser QA service',
          ports: [4173],
          healthCheck: { url: 'http://localhost:4173' },
          managedByTaskWraith: true,
          status: 'unknown'
        }
      ],
      detector,
      pollIntervalMs: 1000
    })
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(service.snapshot().declaredServices).toEqual([
      {
        id: 'plugin:web-qa:service:browser',
        label: 'Browser QA service',
        ports: [4173],
        healthCheck: { url: 'http://localhost:4173' },
        managedByTaskWraith: true,
        status: 'running'
      }
    ])
    service.stop()
  })

  it('stopServer refuses a pid not in the snapshot and never builds a controller', async () => {
    const detector = new FakeDetector()
    detector.servers = [entry(100, [3000])]
    let controllersBuilt = 0
    const service = new LocalServersService({
      getWorkspaces: () => [],
      detector,
      pollIntervalMs: 1000,
      createController: () => {
        controllersBuilt += 1
        return { signal: () => undefined, isAlive: () => false }
      }
    })
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    const result = await service.stopServer(999)
    expect(result.ok).toBe(false)
    expect(controllersBuilt).toBe(0)
    service.stop()
  })

  it('stopServer signals a pid that is in the snapshot', async () => {
    const detector = new FakeDetector()
    detector.servers = [entry(100, [3000])]
    const signals: string[] = []
    const service = new LocalServersService({
      getWorkspaces: () => [],
      detector,
      pollIntervalMs: 1000,
      createController: () => ({ signal: (s) => signals.push(s), isAlive: () => false })
    })
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    const pending = service.stopServer(100)
    await vi.advanceTimersByTimeAsync(3000) // flush the SIGTERM grace wait
    const result = await pending
    expect(result.ok).toBe(true)
    expect(signals).toContain('SIGTERM')
    service.stop()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createHostLoadSampler, HOST_CONTENDED_LOAD_PER_CPU } from './HostLoadSample'

describe('createHostLoadSampler', () => {
  it('normalises the load average by usable cores', () => {
    const sampler = createHostLoadSampler({
      platform: 'darwin',
      loadAverage: () => [12, 8, 4],
      cpuCount: () => 8,
      cpuUsage: () => ({ user: 0, system: 0 }),
      now: () => 0
    })

    const snapshot = sampler.sample()

    expect(snapshot.cpuCount).toBe(8)
    expect(snapshot.loadAverage1m).toBe(12)
    expect(snapshot.loadPerCpu1m).toBe(1.5)
    expect(snapshot.loadAverageReported).toBe(true)
    expect(snapshot.hostContended).toBe(true)
  })

  it('reads an idle host as uncontended', () => {
    const sampler = createHostLoadSampler({
      platform: 'darwin',
      loadAverage: () => [1.6, 1.2, 1],
      cpuCount: () => 8,
      cpuUsage: () => ({ user: 0, system: 0 }),
      now: () => 0
    })

    const snapshot = sampler.sample()

    expect(snapshot.loadPerCpu1m).toBe(0.2)
    expect(snapshot.loadPerCpu1m! < HOST_CONTENDED_LOAD_PER_CPU).toBe(true)
    expect(snapshot.hostContended).toBe(false)
  })

  it('reports no CPU rate on the first sample and the interval rate after', () => {
    let cpu = { user: 0, system: 0 }
    let clock = 1_000
    const sampler = createHostLoadSampler({
      platform: 'darwin',
      loadAverage: () => [0, 0, 0],
      cpuCount: () => 4,
      cpuUsage: () => cpu,
      now: () => clock
    })

    const first = sampler.sample()
    expect(first.processCpuPercent).toBeNull()
    expect(first.processCpuWindowMs).toBeNull()

    // 500 ms of CPU across a 1000 ms window = half of one core.
    cpu = { user: 400_000, system: 100_000 }
    clock = 2_000
    const second = sampler.sample()

    expect(second.processCpuWindowMs).toBe(1_000)
    expect(second.processCpuPercent).toBe(50)
    expect(second.processCpuUserMs).toBe(400)
    expect(second.processCpuSystemMs).toBe(100)
  })

  it('lets the CPU rate exceed one core, because background threads count', () => {
    let cpu = { user: 0, system: 0 }
    let clock = 0
    const sampler = createHostLoadSampler({
      platform: 'darwin',
      loadAverage: () => [0, 0, 0],
      cpuCount: () => 8,
      cpuUsage: () => cpu,
      now: () => clock
    })

    sampler.sample()
    cpu = { user: 3_000_000, system: 0 }
    clock = 1_000
    // Clamping this to 100 would erase exactly the signal worth having: V8's
    // background compiler and the libuv pool burning cores beside main.
    expect(sampler.sample().processCpuPercent).toBe(300)
  })

  it('reports no rate when the window is non-positive', () => {
    let cpu = { user: 0, system: 0 }
    const sampler = createHostLoadSampler({
      platform: 'darwin',
      loadAverage: () => [0, 0, 0],
      cpuCount: () => 4,
      cpuUsage: () => cpu,
      now: () => 5_000
    })

    sampler.sample()
    cpu = { user: 900_000, system: 0 }
    const second = sampler.sample()

    expect(second.processCpuPercent).toBeNull()
    expect(second.processCpuWindowMs).toBeNull()
  })

  it('marks load as unreported on win32 instead of reporting a stubbed zero', () => {
    const loadAverage = vi.fn(() => [0, 0, 0])
    const sampler = createHostLoadSampler({
      platform: 'win32',
      loadAverage,
      cpuCount: () => 16,
      cpuUsage: () => ({ user: 0, system: 0 }),
      now: () => 0
    })

    const snapshot = sampler.sample()

    // Zeros here would read as a perfectly idle host and misdirect the next
    // investigation, which is the failure this module exists to prevent.
    expect(snapshot.loadAverageReported).toBe(false)
    expect(snapshot.loadAverage1m).toBeNull()
    expect(snapshot.loadPerCpu1m).toBeNull()
    expect(snapshot.hostContended).toBeNull()
    expect(loadAverage).not.toHaveBeenCalled()
  })

  it('honours the totality contract when every reading throws', () => {
    const sampler = createHostLoadSampler({
      platform: 'darwin',
      loadAverage: () => {
        throw new Error('loadavg unavailable')
      },
      cpuCount: () => {
        throw new Error('availableParallelism unavailable')
      },
      cpuUsage: () => {
        throw new Error('cpuUsage unavailable')
      },
      now: () => {
        throw new Error('clock unavailable')
      }
    })

    // MainPerfSnapshot calls sample() without a guard on the strength of this.
    const snapshot = sampler.sample()

    expect(snapshot.cpuCount).toBe(1)
    expect(snapshot.loadAverage1m).toBeNull()
    expect(snapshot.loadPerCpu1m).toBeNull()
    expect(snapshot.processCpuUserMs).toBe(0)
    expect(snapshot.processCpuPercent).toBeNull()
  })

  it('never divides by zero when the host reports no usable cores', () => {
    const sampler = createHostLoadSampler({
      platform: 'darwin',
      loadAverage: () => [4, 4, 4],
      cpuCount: () => 0,
      cpuUsage: () => ({ user: 0, system: 0 }),
      now: () => 0
    })

    const snapshot = sampler.sample()

    expect(snapshot.cpuCount).toBe(1)
    expect(snapshot.loadPerCpu1m).toBe(4)
  })
})

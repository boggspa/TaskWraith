import { describe, expect, it, vi } from 'vitest'
import type { HostLifecycleActionResult, HostLifecycleSnapshot } from '../shared/hostLifecycle'
import type { HostSnapshot } from '../shared/hostProtocol'
import type { HostProjectionSnapshotResult } from './host/HostProjectionBroker'
import { createUpdateRestartHostBarrier } from './UpdateRestartHostBarrier'

type Kind = 'existing' | 'launched'

function projection(runs: Array<{ providerOutcome: string }>): HostProjectionSnapshotResult {
  return { ok: true, snapshot: { runs } as unknown as HostSnapshot }
}

function lifecycleResult(ok: boolean, error = 'stop failed'): HostLifecycleActionResult {
  const snapshot = { phase: ok ? 'stopped' : 'running' } as unknown as HostLifecycleSnapshot
  return ok ? { ok: true, snapshot } : ({ ok: false, error, snapshot } as HostLifecycleActionResult)
}

function createDeps(options: {
  kind?: Kind
  phase?: HostLifecycleSnapshot['phase']
  projected?: HostProjectionSnapshotResult
  stop?: HostLifecycleActionResult
}) {
  const stop = vi.fn(async () => options.stop ?? lifecycleResult(true))
  const snapshot = vi.fn(async () => options.projected ?? projection([]))
  const log = vi.fn()
  const barrier = createUpdateRestartHostBarrier({
    preparedExternalHost: { result: { kind: options.kind ?? 'launched' } },
    hostLifecycle: {
      getSnapshot: () => ({ phase: options.phase ?? 'running' }),
      stop
    },
    desktopHostBroker: { snapshot },
    log
  })
  return { barrier, stop, snapshot, log }
}

describe('createUpdateRestartHostBarrier', () => {
  it('is ready at once when the launched Host is already stopped', async () => {
    const { barrier, stop, snapshot } = createDeps({ phase: 'stopped' })
    await expect(barrier({ force: false })).resolves.toEqual({ ready: true })
    expect(snapshot).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('waits for running Host runs and names them', async () => {
    const { barrier, stop } = createDeps({
      projected: projection([{ providerOutcome: 'running' }, { providerOutcome: 'completed' }])
    })
    await expect(barrier({ force: false })).resolves.toEqual({
      ready: false,
      reason: '1 TaskWraith Host run still running'
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops a launched Host once its runs are settled', async () => {
    const { barrier, stop } = createDeps({
      projected: projection([{ providerOutcome: 'completed' }, { providerOutcome: 'failed' }])
    })
    await expect(barrier({ force: false })).resolves.toEqual({ ready: true })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reports a failed Host stop instead of waiting silently', async () => {
    const { barrier } = createDeps({ stop: lifecycleResult(false, 'supervisor busy') })
    await expect(barrier({ force: false })).resolves.toEqual({
      ready: false,
      reason: 'TaskWraith Host could not be stopped: supervisor busy'
    })
  })

  it('reports an unreachable projection for a launched Host', async () => {
    const { barrier, stop } = createDeps({ projected: { ok: false, error: 'socket closed' } })
    await expect(barrier({ force: false })).resolves.toEqual({
      ready: false,
      reason: 'TaskWraith Host status is unavailable (socket closed)'
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it('force skips the running-run wait and still stops the launched Host', async () => {
    const { barrier, stop } = createDeps({
      projected: projection([{ providerOutcome: 'running' }, { providerOutcome: 'running' }])
    })
    await expect(barrier({ force: true })).resolves.toEqual({ ready: true })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('force stops the launched Host even when its projection is unavailable', async () => {
    const { barrier, stop } = createDeps({ projected: { ok: false, error: 'socket closed' } })
    await expect(barrier({ force: true })).resolves.toEqual({ ready: true })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('never stops an adopted Host and proceeds once its runs settle', async () => {
    const { barrier, stop, log } = createDeps({ kind: 'existing', projected: projection([]) })
    await expect(barrier({ force: false })).resolves.toEqual({ ready: true })
    expect(stop).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('owned by another process'))
  })

  it('waits for an adopted Host run but never stops the Host, even when forced', async () => {
    const waiting = createDeps({
      kind: 'existing',
      projected: projection([{ providerOutcome: 'running' }])
    })
    await expect(waiting.barrier({ force: false })).resolves.toEqual({
      ready: false,
      reason: '1 TaskWraith Host run still running'
    })
    const forced = createDeps({
      kind: 'existing',
      projected: projection([{ providerOutcome: 'running' }])
    })
    await expect(forced.barrier({ force: true })).resolves.toEqual({ ready: true })
    expect(forced.stop).not.toHaveBeenCalled()
  })

  it('proceeds for an adopted Host whose projection is unavailable', async () => {
    const { barrier, stop } = createDeps({
      kind: 'existing',
      projected: { ok: false, error: 'socket closed' }
    })
    await expect(barrier({ force: false })).resolves.toEqual({ ready: true })
    expect(stop).not.toHaveBeenCalled()
  })

  it('bounds long error detail in the reported reason', async () => {
    const { barrier } = createDeps({ projected: { ok: false, error: 'x'.repeat(1_000) } })
    const result = await barrier({ force: false })
    expect(result.ready).toBe(false)
    if (!result.ready) expect(result.reason.length).toBeLessThan(260)
  })
})

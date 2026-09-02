import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isDesktopExternalHostEnabled } from './DesktopExternalHostPolicy'

const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const updateRestartBarrier = readFileSync(
  join(process.cwd(), 'src/main/UpdateRestartHostBarrier.ts'),
  'utf8'
)
const bootstrap = readFileSync(join(process.cwd(), 'src/main/bootstrap.ts'), 'utf8')
const inProcessWriter = readFileSync(
  join(process.cwd(), 'src/main/host/LegacyInProcessHostWriter.ts'),
  'utf8'
)
const inProcessAuthorityState = readFileSync(
  join(process.cwd(), 'src/main/host/HostInProcessProfileAuthorityState.ts'),
  'utf8'
)

describe('Desktop external Host cutover', () => {
  it('defaults Desktop onto the external Host with an explicit 0 opt-out', () => {
    expect(isDesktopExternalHostEnabled({})).toBe(true)
    expect(isDesktopExternalHostEnabled({ TASKWRAITH_DESKTOP_EXTERNAL_HOST: '0' })).toBe(false)
    expect(bootstrap).toContain('if (!isDesktopExternalHostEnabled())')
  })

  it('consumes bootstrap preparation before constructing the Desktop broker', () => {
    const consume = source.indexOf('consumePreparedExternalHost(externalHostProfilePath)')
    const broker = source.indexOf('const desktopHostBroker = createHostProjectionBroker({')
    expect(consume).toBeGreaterThanOrEqual(0)
    expect(consume).toBeLessThan(broker)
    expect(bootstrap).toContain('isDesktopExternalHostEnabled')
    expect(bootstrap).toContain('drainLegacyStoreForInProcessHost')
    expect(bootstrap).not.toContain("TASKWRAITH_DESKTOP_EXTERNAL_HOST !== '1'")
    expect(bootstrap).toContain('using in-process Host')
    expect(bootstrap).toContain('ProfileWriterLivePeerError')
    expect(bootstrap.indexOf('prepareMainProcess:')).toBeLessThan(
      bootstrap.indexOf("loadMainProcess: () => import('./index')")
    )
  })

  it('never falls back after ownership and preserves a fresh external restart factory', () => {
    const start = source.indexOf('let initialPreparedExternalHost =')
    const end = source.indexOf('const hostLifecycle = new HostLifecycleController({', start)
    const wiring = source.slice(start, end + 500)
    expect(wiring).toContain('createHostExternalLifecycleAdapter({')
    expect(wiring).toContain('preparedResult: initial.result')
    expect(wiring).toContain('preparedExternalHost.createSupervisor()')
    expect(wiring).toContain('if (!preparedExternalHost) return createProductionHost()')
    expect(wiring).toContain('createSupervisor: createSelectedHost')
    expect(wiring).not.toContain('createSupervisor: createProductionHost')
  })

  it('keeps legacy compatibility selectable only before any ownership transfer', () => {
    expect(source).toContain('void createProductionHost')
    expect(source).toContain('It is never selected after')
    expect(source).toContain('hostLifecycle.stopSync()')
  })

  it('waits for running Host work, never stops a TUI-owned Host, and stops only a Desktop launch', () => {
    expect(source).toContain(
      "import { createUpdateRestartHostBarrier } from './UpdateRestartHostBarrier'"
    )
    expect(source).toContain('beforeRestart: createUpdateRestartHostBarrier({')
    const wiring = source.slice(source.indexOf('beforeRestart: createUpdateRestartHostBarrier({'))
    for (const dep of ['preparedExternalHost,', 'hostLifecycle,', 'desktopHostBroker,']) {
      expect(wiring.slice(0, 400)).toContain(dep)
    }
    expect(updateRestartBarrier).toContain(
      "const owned = deps.preparedExternalHost.result.kind === 'launched'"
    )
    expect(updateRestartBarrier).toContain("run.providerOutcome === 'running'")
    // A Host this app only adopted is never stopped on its behalf: the owned
    // check returns before the only stop call.
    const adoptedExit = updateRestartBarrier.indexOf('if (!owned) {\n      log(')
    const stopCall = updateRestartBarrier.indexOf('const stopped = await deps.hostLifecycle.stop()')
    expect(adoptedExit).toBeGreaterThan(0)
    expect(stopCall).toBeGreaterThan(adoptedExit)
    expect(updateRestartBarrier.split('hostLifecycle.stop()').length).toBe(2)
  })

  it('acquires the shared authority lease for in-process Desktop and releases it on shutdown', () => {
    expect(inProcessWriter).toContain('HostProfileAuthorityLease.acquire')
    expect(inProcessWriter).toContain('lease.assertHeld()')
    expect(inProcessWriter).toContain('lease.release()')
    expect(bootstrap).toContain('const lease = await drainLegacyStoreForInProcessHost')
    expect(bootstrap).toContain('inProcessHostLease = lease')
    expect(bootstrap).toContain('publishInProcessProfileAuthority({ profilePath, lease })')
    expect(bootstrap).toContain('clearInProcessProfileAuthority(lease)')
    expect(source).toContain('getInProcessProfileAuthority(externalHostProfilePath)')
    expect(source).toContain('profileAuthority: inProcessProfileAuthority')
    expect(inProcessAuthorityState).toContain(
      'assertProfileAuthority: () => input.lease.assertHeld()'
    )
    expect(bootstrap).toContain("app.on('quit'")
    expect(bootstrap).toContain('Release only after that gate has completed')
    expect(bootstrap).toContain('releaseInProcessHostLease')
    expect(bootstrap).toContain('cleanupPreparedMainProcess: async () => {')
    const cleanup = bootstrap.slice(bootstrap.indexOf('cleanupPreparedMainProcess:'))
    expect(cleanup).toContain('releaseInProcessHostLease()')
    expect(cleanup.indexOf('externalHostPreparation?.cleanup()')).toBeLessThan(
      cleanup.indexOf('releaseInProcessHostLease()')
    )
  })
})

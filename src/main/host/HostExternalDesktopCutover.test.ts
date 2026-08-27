import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isDesktopExternalHostEnabled } from './DesktopExternalHostPolicy'

const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const bootstrap = readFileSync(join(process.cwd(), 'src/main/bootstrap.ts'), 'utf8')

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

  it('defers update shutdown for active or TUI-owned Hosts and stops only a Desktop launch', () => {
    expect(source).toContain('beforeRestart: async (): Promise<boolean> => {')
    expect(source).toContain("preparedExternalHost.result.kind !== 'launched'")
    expect(source).toContain("run.providerOutcome === 'running'")
    expect(source).toContain('return (await hostLifecycle.stop()).ok')
  })
})

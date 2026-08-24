import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const bootstrap = readFileSync(join(process.cwd(), 'src/main/bootstrap.ts'), 'utf8')

describe('Desktop external Host cutover', () => {
  it('consumes bootstrap preparation before constructing the Desktop broker', () => {
    const consume = source.indexOf('consumePreparedExternalHost(externalHostProfilePath)')
    const broker = source.indexOf('const desktopHostBroker = createHostProjectionBroker({')
    expect(consume).toBeGreaterThanOrEqual(0)
    expect(consume).toBeLessThan(broker)
    expect(source).toContain('requires a bootstrap-prepared external Host')
    expect(bootstrap.indexOf('prepareMainProcess:')).toBeLessThan(
      bootstrap.indexOf("loadMainProcess: () => import('./index')")
    )
  })

  it('selects only the external lifecycle adapter and preserves a fresh restart factory', () => {
    const start = source.indexOf('let initialPreparedExternalHost:')
    const end = source.indexOf('const hostLifecycle = new HostLifecycleController({', start)
    const wiring = source.slice(start, end + 500)
    expect(wiring).toContain('createHostExternalLifecycleAdapter({')
    expect(wiring).toContain('preparedResult: initial.result')
    expect(wiring).toContain('preparedExternalHost.createSupervisor()')
    expect(wiring).toContain('createSupervisor: createExternalHost')
    expect(wiring).not.toContain('createSupervisor: createProductionHost')
    expect(wiring).not.toContain('return createProductionHost')
  })

  it('keeps the legacy in-process factory inert rather than a fallback', () => {
    expect(source).toContain('void createProductionHost')
    expect(source).toContain('It is never selected after')
    expect(source).toContain('hostLifecycle.stopSync()')
  })
})

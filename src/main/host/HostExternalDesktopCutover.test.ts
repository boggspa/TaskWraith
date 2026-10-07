import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../mainSourceProbe.testutil'
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

/** Host-lifetime S2: main's lease, its quit order, and what feeds the restart paths. */
describe('Desktop Host lease wiring', () => {
  const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))
  const calleeOf = (call: ts.CallExpression): string => probe.text(call.expression)

  it("writes main's lease release before the lifecycle detaches at quit", () => {
    const teardowns = probe
      .callsTo(probe.source, 'on')
      .filter((call) => call.arguments.length === 2 && probe.argText(call, 0) === "'will-quit'")
      .map((call) => call.arguments[1])
      .filter((handler) => probe.callsTo(handler, 'stopSync').length > 0)
    expect(teardowns).toHaveLength(1)
    const [teardown] = teardowns
    const releases = probe.callsTo(teardown, 'releaseSync')
    const stops = probe.callsTo(teardown, 'stopSync')
    expect(releases.map(calleeOf)).toEqual(['desktopHostLease?.releaseSync'])
    expect(stops.map(calleeOf)).toEqual(['hostLifecycle.stopSync'])
    expect(releases[0].getStart(probe.source)).toBeLessThan(stops[0].getStart(probe.source))
  })

  it('holds the lease for the app from app start, on an external Host only', () => {
    const lease = probe.binding('desktopHostLease')
    if (!ts.isConditionalExpression(lease)) throw new Error('desktopHostLease is not conditional')
    expect(probe.text(lease.condition)).toBe('preparedExternalHost')
    expect(probe.text(lease.whenFalse)).toBe('null')
    const [start] = probe.callsTo(lease.whenTrue, 'startDesktopHostLease')
    expect(probe.propText(start, 0, 'profilePath')).toBe('externalHostProfilePath')
    expect(probe.propText(start, 0, 'lifecycle')).toBe('hostLifecycle')
    expect(probe.propText(start, 0, 'releaseBootHold')).toBe(
      '(profilePath) => releaseExternalHostBootHold(profilePath)'
    )

    const holds = probe
      .callsTo(probe.source, 'hold')
      .filter((call) => calleeOf(call) === 'desktopHostLease?.reasons.hold')
    expect(holds.map((call) => probe.argText(call, 0))).toEqual(["'app'"])
    const appStart = probe
      .callsTo(probe.source, 'start')
      .filter(
        (call) =>
          calleeOf(call) === 'hostLifecycle.start' && probe.argText(call, 0) === "'app-start'"
      )
    expect(appStart).toHaveLength(1)
    expect(appStart[0].getStart(probe.source)).toBeLessThan(holds[0].getStart(probe.source))
  })

  it("renews main's lease first on resume", () => {
    const [resume] = probe.callsTo(probe.source, 'createResumeHostHealthCheck')
    expect(probe.propText(resume, 0, 'renewLease')).toBe(
      'async () => desktopHostLeaseRef?.lease.renewNow()'
    )
    expect(probe.assignmentsTo(probe.source, 'desktopHostLeaseRef')).toEqual(['desktopHostLease'])
  })

  it("feeds the broker's typed Host errors to the poison guard, which restarts through the lifecycle", () => {
    const broker = probe.binding('desktopHostBroker')
    if (!ts.isCallExpression(broker)) throw new Error('desktopHostBroker is not a call')
    expect(calleeOf(broker)).toBe('createHostProjectionBroker')
    // The transport log observes the same reports; the poison guard still gets every one.
    const onTransportError = probe.propText(broker, 0, 'onTransportError')
    expect(onTransportError).toContain('hostPoisonDetectorRef?.report(report)')
    expect(onTransportError).toContain('hostTransportLog.transportError(report)')
    const [assigned] = probe.assignmentsTo(probe.source, 'hostPoisonDetectorRef')
    expect(assigned.startsWith('desktopHostLease ? createHostPoisonDetector({')).toBe(true)
    const [detector] = probe.callsTo(probe.source, 'createHostPoisonDetector')
    expect(probe.propText(detector, 0, 'lifecycle')).toBe('hostLifecycle')
    expect(probe.propText(detector, 0, 'readHostStatus')).toBe(
      '() => desktopHostLease.readHostStatus()'
    )
    expect(probe.propText(detector, 0, 'isUpdateRestartPending')).toBe(
      '() => updateService.snapshot().restartPending === true'
    )
  })

  it('keeps a rolling Host transport log fed by the broker and the lifecycle', () => {
    const log = probe.binding('hostTransportLog')
    if (!ts.isCallExpression(log)) throw new Error('hostTransportLog is not a call')
    expect(calleeOf(log)).toBe('installHostTransportEventLog')
    const broker = probe.binding('desktopHostBroker')
    if (!ts.isCallExpression(broker)) throw new Error('desktopHostBroker is not a call')
    expect(probe.propText(broker, 0, 'onClientEvent')).toBe(
      '(event) => hostTransportLog.clientEvent(event)'
    )
    const [lifecycle] = probe.construction('HostLifecycleController')
    expect(probe.propText(lifecycle, 0, 'onFailure')).toBe(
      '(failure) => hostTransportLog.lifecycleFailure(failure)'
    )
    const [observe] = probe.callsTo(probe.source, 'observeLifecycle')
    expect(probe.argText(observe, 0)).toBe('hostLifecycle')
  })

  it("answers the inspect channel from main's lease, and routes the menu's Restart Host to a confirmed restart", () => {
    const [register] = probe.callsTo(probe.source, 'registerHostLifecycleHandlers')
    const inspect = probe
      .objectLiterals(register)
      .filter((literal) => probe.propOf(literal, 'inspect') === 'desktopHostLease')
    expect(inspect).toHaveLength(1)

    const action = probe.binding('restartHostFromMenu')
    if (!ts.isCallExpression(action)) throw new Error('restartHostFromMenu is not a call')
    expect(calleeOf(action)).toBe('createHostRestartAction')
    expect(probe.propText(action, 0, 'controller')).toBe('hostLifecycle')
    const [menu] = probe.callsTo(probe.source, 'installApplicationMenu')
    expect(probe.propText(menu, 0, 'restartHost')).toBe('() => void restartHostFromMenu()')
  })
})

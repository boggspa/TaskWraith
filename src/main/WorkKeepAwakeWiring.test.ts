import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from './mainSourceProbe.testutil'

/**
 * Wiring contract for the keep-awake assertion.
 *
 * The behaviour lives in `WorkKeepAwakeAssertion.ts` and is tested there
 * against a real fake `powerSaveBlocker`. This file asserts only the half that
 * module cannot: that `index.ts` actually reaches it, with the right inputs.
 * A perfectly correct assertion nobody constructs keeps a Mac awake for
 * exactly nobody, and every other signal in the app would look healthy.
 */
describe('keep-awake wiring in index.ts', () => {
  const probe = new MainSourceProbe('index.ts', new URL('./index.ts', import.meta.url))

  it('drives the assertion from the same three signals headless continuity uses', () => {
    const body = probe.text(probe.fn('hasActiveLocalAgentWork'))
    expect(body).toContain('getActiveTaskWraithThreadCount() > 0')
    expect(body).toContain('hasActiveStreamingTaskWraithRun()')
    expect(body).toContain('hasEnsembleHostAdmissionWork()')
  })

  it('starts the monitor with that predicate and a per-tick settings read', () => {
    const calls = probe.callsTo(probe.source, 'startWorkKeepAwakeMonitor')
    expect(calls).toHaveLength(1)
    expect(probe.argText(calls[0], 0)).toBe('workKeepAwakeAssertion')
    expect(probe.propText(calls[0], 1, 'hasActiveWork')).toBe('hasActiveLocalAgentWork')

    const isEnabled = probe.propText(calls[0], 1, 'isEnabled')
    expect(isEnabled).not.toBeNull()
    expect(isEnabled).toContain('keepAwakeWhileWorking')
    // Absent must mean ON, matching `defaultSettings`. A `=== true` here would
    // silently opt out every settings file written before this shipped.
    expect(isEnabled).toContain('!== false')
  })

  it('repairs its own assertion on lock and resume, as the remote one does', () => {
    const renewals = probe
      .callsTo(probe.source, 'renew')
      .map((call) => probe.text(call).replace(/\s+/g, ' '))
      .filter((text) => text.startsWith('workKeepAwakeAssertion.renew'))
    expect(renewals).toHaveLength(2)
    expect(renewals.join('\n')).toContain('screen locked')
    expect(renewals.join('\n')).toContain('system resumed')
  })

  it('releases its own assertion and stops its timer on quit', () => {
    const releases = probe
      .callsTo(probe.source, 'release')
      .map((call) => probe.text(call).replace(/\s+/g, ' '))
      .filter((text) => text.startsWith('workKeepAwakeAssertion.release'))
    expect(releases).toHaveLength(1)
    expect(probe.callsTo(probe.source, 'stopWorkKeepAwakeMonitor').length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the two power assertions independent in both directions', () => {
    // The whole point of a second blocker id is that either reason alone keeps
    // the Mac awake. If the remote helpers ever learn about this one, unpairing
    // a phone would drop a running round's protection — the exact regression
    // this pins, and one no unit test of either module could see.
    const releaseRemote = probe.text(probe.fn('releaseRemotePowerAssertion'))
    const renewRemote = probe.text(probe.fn('renewRemotePowerAssertion'))
    const updateRemote = probe.text(probe.fn('updateRemotePowerAssertion'))
    // Non-vacuous: each body is real code, asserted present before being
    // asserted clean.
    expect(releaseRemote).toContain('remotePowerBlockerId')
    expect(renewRemote).toContain('remotePowerBlockerId')
    expect(updateRemote).toContain('remotePowerBlockerId')
    for (const body of [releaseRemote, renewRemote, updateRemote]) {
      expect(body).not.toContain('workKeepAwake')
    }
  })
})

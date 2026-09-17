import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from './mainSourceProbe.testutil'

/**
 * Wiring contract for the resume-time Host re-check.
 *
 * The behaviour lives in `ResumeHostHealthCheck.ts` and is tested there against
 * injected ports. This file asserts the half that module cannot see: that
 * `index.ts` reaches it on the right events, with the right ports — and, just
 * as importantly, that the repair stays inside the two contracts it could
 * quietly violate from here.
 */

describe('resume Host health check wiring in index.ts', () => {
  const probe = new MainSourceProbe('index.ts', new URL('./index.ts', import.meta.url))

  it('probes through the broker and drops only the connection on failure', () => {
    const calls = probe.callsTo(probe.source, 'createResumeHostHealthCheck')
    expect(calls).toHaveLength(1)

    const probeHost = probe.propText(calls[0], 0, 'probeHost')
    expect(probeHost).toContain('desktopHostBroker.snapshot()')

    const drop = probe.propText(calls[0], 0, 'dropHostConnection')
    expect(drop).toContain('desktopHostBroker.close()')

    const nudge = probe.propText(calls[0], 0, 'nudgeCatalogueRecovery')
    expect(nudge).toContain('enqueueAll()')
  })

  it('runs on both resume and unlock', () => {
    const wake = probe
      .callsTo(probe.source, 'resumeHostHealthCheck')
      .map((call) => probe.text(call).replace(/\s+/g, ' '))
    expect(wake).toHaveLength(2)
    expect(wake.join('\n')).toContain('system resumed')
    expect(wake.join('\n')).toContain('screen unlocked')
  })

  it('never restarts the Host from a wake event', () => {
    // HostLifecycleController's contract: "It never retries in the background:
    // only app startup or an explicit user action can call start()." A system
    // event is not a user action, and respawning a Host from one is the
    // undeclared background service that contract forbids. Reaching for
    // ensureAvailable() here would be the same violation one layer down.
    const calls = probe.callsTo(probe.source, 'createResumeHostHealthCheck')
    const config = probe.argText(calls[0], 0)
    expect(config).toContain('desktopHostBroker')
    expect(config).not.toContain('ensureAvailable')
    expect(config).not.toContain('hostLifecycle')
    // And the repair must not reach into the write gate: its release closure is
    // identity-fenced so a stale releaser cannot free a NEWER hold.
    expect(config).not.toContain('threadCatalogueWriteGate')
    expect(config).not.toContain('releaseRecoveryHold')
  })
})

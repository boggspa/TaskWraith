import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveBackgroundDispatchPosture } from './EnsembleBackgroundDispatch'

/*
 * User-directed background lanes honor the seat's own posture
 * (the background-seat posture design). The pure resolver carries the
 * decision + status wording; the source invariants pin the orchestrator
 * wiring — exactly one user-origin call site sets honorSeatPosture, and the
 * peer paths keep the silent read-only clamp.
 */
describe('resolveBackgroundDispatchPosture', () => {
  it('preserves user-directed seat permissions while disclosing derived writer intent', () => {
    const posture = resolveBackgroundDispatchPosture({
      honorSeatPosture: true,
      writeLanesEnabled: true,
      laneCount: 2
    })
    expect(posture.mode).toBe('own_permissions')
    expect(posture.statusLine).toContain('launching 2 lane(s) under their own permission posture')
    expect(posture.statusLine).toContain('Write-capable seats receive writer intent')
    expect(posture.statusLine).toContain('no permission tier is inferred or widened')
  })

  it('clamps user-directed lanes read-only, loudly, when the write-lane kill-switch is off', () => {
    const posture = resolveBackgroundDispatchPosture({
      honorSeatPosture: true,
      writeLanesEnabled: false,
      laneCount: 1
    })
    expect(posture.mode).toBe('read_only_clamp')
    expect(posture.statusLine).toBe(
      'Background lane(s) clamped to read-only: TASKWRAITH_CONCURRENT_WRITE_LANES=0.'
    )
  })

  it('keeps peer-delegated dispatch silently read-only regardless of the gate', () => {
    for (const writeLanesEnabled of [true, false]) {
      const posture = resolveBackgroundDispatchPosture({
        honorSeatPosture: false,
        writeLanesEnabled,
        laneCount: 3
      })
      expect(posture.mode).toBe('read_only_clamp')
      expect(posture.statusLine).toBeNull()
    }
  })
})

describe('honorSeatPosture orchestrator wiring', () => {
  const source = readFileSync(new URL('./EnsembleOrchestrator.ts', import.meta.url), 'utf8')

  it('has exactly one honorSeatPosture: true call site - the user-origin round path', () => {
    const matches = source.match(/honorSeatPosture: true/g) || []
    expect(matches).toHaveLength(1)
    const index = source.indexOf('honorSeatPosture: true')
    const context = source.slice(Math.max(0, index - 700), index)
    // The one call site sits in runRound's background block, which is fed
    // exclusively by beginRound (user-authored prompts by construction).
    expect(context).toContain('options.backgroundParticipants')
  })

  it('background dispatch resolves posture through the shared resolver with both branches intact', () => {
    const start = source.indexOf('private async dispatchBackgroundParticipants(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 8000)
    expect(body).toContain('resolveBackgroundDispatchPosture')
    expect(body).toContain("posture.mode === 'own_permissions'")
    expect(body).toContain('deriveLaneIntentFromPermissions: true')
    expect(body).toContain('forceReadOnlyDispatch: true')
  })
})

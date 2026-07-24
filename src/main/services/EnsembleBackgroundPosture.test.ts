import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveBackgroundDispatchPosture } from './EnsembleBackgroundDispatch'

/*
 * User-directed background lanes honor the seat's own posture
 * (docs/bg-user-mention-posture-design.md). The pure resolver carries the
 * decision + status wording; the source invariants pin the orchestrator
 * wiring — exactly one user-origin call site sets honorSeatPosture, and the
 * peer paths keep the silent read-only clamp.
 */
describe('resolveBackgroundDispatchPosture', () => {
  it('runs user-directed lanes under the seats own permissions when write lanes are on', () => {
    const posture = resolveBackgroundDispatchPosture({
      honorSeatPosture: true,
      writeLanesEnabled: true,
      laneCount: 2
    })
    expect(posture.mode).toBe('own_permissions')
    expect(posture.statusLine).toBe(
      'Background: launching 2 lane(s) under their own permissions (user-directed).'
    )
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
    expect(body).toContain('dispatchOwnPermissions: true')
    expect(body).toContain('forceReadOnlyDispatch: true')
  })
})

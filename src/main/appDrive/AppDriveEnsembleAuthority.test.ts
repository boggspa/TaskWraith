import { describe, expect, it } from 'vitest'

import { resolveAppDriveEnsembleAuthority } from './AppDriveEnsembleAuthority'

const BOSS = 'participant-boss'
const CAPTAIN = 'participant-captain'
const WORKER = 'participant-worker'

function ensemble(overrides: Record<string, unknown> = {}) {
  return {
    bossmanParticipantId: BOSS,
    captainParticipantIds: [CAPTAIN],
    ...overrides
  }
}

describe('resolveAppDriveEnsembleAuthority', () => {
  it('allows a solo thread, which has no participants to rank', () => {
    expect(resolveAppDriveEnsembleAuthority({ ensemble: null })).toMatchObject({ ok: true })
    expect(resolveAppDriveEnsembleAuthority({})).toMatchObject({ ok: true })
  })

  it('allows the Boss and a Captain', () => {
    expect(
      resolveAppDriveEnsembleAuthority({ ensemble: ensemble(), callerParticipantId: BOSS })
    ).toEqual({ ok: true, authorityRole: 'boss' })
    expect(
      resolveAppDriveEnsembleAuthority({ ensemble: ensemble(), callerParticipantId: CAPTAIN })
    ).toEqual({ ok: true, authorityRole: 'captain' })
  })

  it('accepts the legacy single second-in-command field', () => {
    expect(
      resolveAppDriveEnsembleAuthority({
        ensemble: {
          bossmanParticipantId: BOSS,
          secondInCommandParticipantId: CAPTAIN
        },
        callerParticipantId: CAPTAIN
      })
    ).toEqual({ ok: true, authorityRole: 'captain' })
  })

  it('refuses an ordinary participant, and says who may', () => {
    const result = resolveAppDriveEnsembleAuthority({
      ensemble: ensemble(),
      callerParticipantId: WORKER
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Boss or a Captain/i)
  })

  it('refuses a caller with no participant identity inside an Ensemble', () => {
    for (const callerParticipantId of [undefined, null, '', '   ']) {
      expect(
        resolveAppDriveEnsembleAuthority({ ensemble: ensemble(), callerParticipantId })
      ).toMatchObject({ ok: false })
    }
  })

  it('refuses when the Ensemble names no Boss at all', () => {
    // Nobody can be proved to hold authority, so nobody gets it.
    expect(
      resolveAppDriveEnsembleAuthority({
        ensemble: { captainParticipantIds: [CAPTAIN] },
        callerParticipantId: CAPTAIN
      })
    ).toMatchObject({ ok: false })
  })

  it('never consults a role or stage role, which participants can patch', () => {
    const result = resolveAppDriveEnsembleAuthority({
      ensemble: ensemble(),
      callerParticipantId: WORKER,
      // Deliberately shaped like the agent-patchable fields; they must not help.
      ...({ role: 'boss', stageRole: 'boss' } as Record<string, unknown>)
    })
    expect(result.ok).toBe(false)
  })

  it('ignores malformed rosters rather than throwing', () => {
    for (const bad of [{ captainParticipantIds: 'nope' }, { bossmanParticipantId: 42 }]) {
      const result = resolveAppDriveEnsembleAuthority({
        ensemble: bad as never,
        callerParticipantId: BOSS
      })
      expect(typeof result.ok).toBe('boolean')
    }
  })
})

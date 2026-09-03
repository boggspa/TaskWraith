import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import { isBossmanStatusTargetSettled } from './EnsembleStatusRequestSettlement'

function seat(patch: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'codex',
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    instructions: 'Work.',
    order: 1,
    ...patch
  } as EnsembleParticipant
}

describe('isBossmanStatusTargetSettled', () => {
  it.each(['answered', 'yielded', 'skipped', 'failed', 'cancelled', 'unreachable'] as const)(
    'settles a target whose round status is %s',
    (status) => {
      expect(isBossmanStatusTargetSettled(status, seat())).toBe(true)
    }
  )

  it.each(['idle', 'running', 'sleeping'] as const)(
    'keeps waiting on an enabled target that is %s',
    (status) => {
      expect(isBossmanStatusTargetSettled(status, seat())).toBe(false)
    }
  )

  it('keeps waiting on an enabled target with no round entry yet', () => {
    expect(isBossmanStatusTargetSettled(undefined, seat())).toBe(false)
  })

  it('settles a target the user switched off, which can never run', () => {
    expect(isBossmanStatusTargetSettled(undefined, seat({ enabled: false }))).toBe(true)
    expect(isBossmanStatusTargetSettled('idle', seat({ enabled: false }))).toBe(true)
  })

  it('settles a target that has left the roster entirely', () => {
    expect(isBossmanStatusTargetSettled(undefined, undefined)).toBe(true)
    expect(isBossmanStatusTargetSettled('idle', undefined)).toBe(true)
  })

  it('does not settle a background seat merely for being off the round', () => {
    expect(isBossmanStatusTargetSettled(undefined, seat({ stageRole: 'background' }))).toBe(false)
  })
})

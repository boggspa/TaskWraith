import { describe, expect, it } from 'vitest'
import { mapPreserveIdentity, patchIdentityList } from './EnsembleStreamChatApply'

describe('EnsembleStreamChatApply', () => {
  it('reuses the original array when every mapped item keeps its reference', () => {
    const runs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const next = mapPreserveIdentity(runs, (run) => run)
    expect(next).toBe(runs)
  })

  it('allocates only when a mapped item actually changes', () => {
    const runs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const replacement = { id: 'b', status: 'running' }
    const next = mapPreserveIdentity(runs, (run) => (run.id === 'b' ? replacement : run))
    expect(next).not.toBe(runs)
    expect(next[0]).toBe(runs[0])
    expect(next[1]).toBe(replacement)
    expect(next[2]).toBe(runs[2])
  })

  it('patches one seat without rewriting the others', () => {
    const seats = [
      { id: 'seat-1', tokens: 1 },
      { id: 'seat-2', tokens: 2 }
    ]
    const next = patchIdentityList(seats, 'seat-2', (seat) => ({ ...seat, tokens: 3 }))
    expect(next).not.toBe(seats)
    expect(next[0]).toBe(seats[0])
    expect(next[1]).toEqual({ id: 'seat-2', tokens: 3 })
  })
})

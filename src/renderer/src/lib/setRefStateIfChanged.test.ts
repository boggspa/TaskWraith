import { describe, expect, it } from 'vitest'
import { setRefStateIfChanged } from './setRefStateIfChanged'

describe('setRefStateIfChanged', () => {
  it('updates the ref before dispatch and skips repeated values', () => {
    const first = ['one']
    const stateRef: { current: string[] | null } = { current: null }
    const commits: Array<string[] | null> = []

    expect(setRefStateIfChanged(stateRef, null, (next) => commits.push(next))).toBe(false)
    expect(setRefStateIfChanged(stateRef, first, (next) => commits.push(next))).toBe(true)
    expect(stateRef.current).toBe(first)
    expect(setRefStateIfChanged(stateRef, first, (next) => commits.push(next))).toBe(false)
    expect(setRefStateIfChanged(stateRef, null, (next) => commits.push(next))).toBe(true)
    expect(setRefStateIfChanged(stateRef, null, (next) => commits.push(next))).toBe(false)

    expect(commits).toEqual([first, null])
  })
})

import { describe, expect, it } from 'vitest'
import { findChatRunIndex } from './findChatRunIndex'

describe('findChatRunIndex', () => {
  const runs = [{ runId: 'run-a' }, { runId: 'run-b' }, { runId: 'run-c' }]

  it('returns the exact run even when a newer run is present', () => {
    expect(findChatRunIndex(runs, 'run-b')).toBe(1)
  })

  it('does not fall back to the last run for a missing or empty id', () => {
    expect(findChatRunIndex(runs, 'missing')).toBe(-1)
    expect(findChatRunIndex(runs, '')).toBe(-1)
    expect(findChatRunIndex(undefined, 'run-a')).toBe(-1)
  })
})

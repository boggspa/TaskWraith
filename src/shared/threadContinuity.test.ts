import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../main/store/types'
import { readSeatCheckpoint, updateSeatCheckpoint } from './threadContinuity'

const chat = {
  appChatId: 'chat',
  messages: [{ id: 'message', content: 'preserve this constraint', role: 'user' }],
  runs: []
} as unknown as ChatRecord
const input = {
  seatId: '__solo__',
  text: 'Next: inspect replay ordering.',
  expectedRevision: 0,
  references: [{ messageId: 'message' }],
  author: { provider: 'codex' as const, runId: 'run' },
  now: '2026-09-05T12:00:00Z'
}

describe('private seat checkpoints', () => {
  it('stores only the latest revision and rejects a stale writer', () => {
    const saved = { ...chat, continuityCheckpoints: updateSeatCheckpoint(chat, input) }
    expect(readSeatCheckpoint(saved)).toMatchObject({ revision: 1, text: input.text })
    expect(() => updateSeatCheckpoint(saved, input)).toThrow(/changed/)
    const next = updateSeatCheckpoint(saved, {
      ...input,
      expectedRevision: 1,
      text: 'Now test the fix.'
    })
    expect(next?.__solo__.revision).toBe(2)
  })
  it('does not inherit another task’s copied checkpoint', () => {
    const saved = { ...chat, continuityCheckpoints: updateSeatCheckpoint(chat, input) }
    expect(readSeatCheckpoint({ ...saved, appChatId: 'fork' })).toBeNull()
  })
  it('rejects unknown seats, foreign references and unbounded text', () => {
    expect(() => updateSeatCheckpoint(chat, { ...input, seatId: 'foreign' })).toThrow(/participant/)
    expect(() =>
      updateSeatCheckpoint(chat, { ...input, references: [{ messageId: 'foreign' }] })
    ).toThrow(/this task/)
    expect(() => updateSeatCheckpoint(chat, { ...input, text: 'x'.repeat(1601) })).toThrow(
      /characters/
    )
  })
  it('clears the checkpoint without creating permanent project memory', () => {
    const saved = { ...chat, continuityCheckpoints: updateSeatCheckpoint(chat, input) }
    expect(
      updateSeatCheckpoint(saved, { ...input, expectedRevision: 1, text: null })
    ).toBeUndefined()
  })
})

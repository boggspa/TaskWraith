import { describe, it, expect } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { participantsChipEqual, identityContextEqual } from './MarkdownMessage'

/*
 * These guard the MarkdownMessage memo + Provider-cache gates that decide when
 * the @-mention / participant chips may skip re-rendering. The contract is the
 * inverse of the messagesRenderEqual one: a false NEGATIVE only costs a
 * redundant render, but a false POSITIVE shows a STALE chip (wrong role name /
 * provider tint) that never self-corrects (settled rows don't remount). So the
 * predicate must catch every change a chip renders from while ignoring the
 * per-broadcast churn (token tallies / status) that doesn't.
 */

describe('participantsChipEqual', () => {
  it('is true for the same render-affecting slice across distinct objects', () => {
    const a = [{ id: 'p1', role: 'Worker', provider: 'codex' }]
    const b = [{ id: 'p1', role: 'Worker', provider: 'codex' }]
    expect(participantsChipEqual(a, b)).toBe(true)
  })

  it('IGNORES per-broadcast churn (token tallies / status) on the same id/role/provider', () => {
    // The real EnsembleParticipant carries `tokenTotals`/status that change
    // every broadcast; the chip never reads them, so equality must hold.
    const a = [{ id: 'p1', role: 'Worker', provider: 'codex', tokenTotals: { input: 1 }, status: 'idle' }]
    const b = [{ id: 'p1', role: 'Worker', provider: 'codex', tokenTotals: { input: 9999 }, status: 'running' }]
    expect(participantsChipEqual(a, b)).toBe(true)
  })

  it('is false when a role changes (chip name + title would change)', () => {
    const a = [{ id: 'p1', role: 'Worker', provider: 'codex' }]
    const b = [{ id: 'p1', role: 'Reviewer', provider: 'codex' }]
    expect(participantsChipEqual(a, b)).toBe(false)
  })

  it('is false when a provider changes (chip tint would change)', () => {
    const a = [{ id: 'p1', role: 'Worker', provider: 'codex' }]
    const b = [{ id: 'p1', role: 'Worker', provider: 'claude' }]
    expect(participantsChipEqual(a, b)).toBe(false)
  })

  it('is false when a participant id changes (resolution target moves)', () => {
    const a = [{ id: 'p1', role: 'Worker', provider: 'codex' }]
    const b = [{ id: 'p2', role: 'Worker', provider: 'codex' }]
    expect(participantsChipEqual(a, b)).toBe(false)
  })

  it('is false on add/remove (length change) and on reorder', () => {
    const one = [{ id: 'p1', role: 'Worker', provider: 'codex' }]
    const two = [
      { id: 'p1', role: 'Worker', provider: 'codex' },
      { id: 'p2', role: 'Reviewer', provider: 'claude' }
    ]
    expect(participantsChipEqual(one, two)).toBe(false)
    const reordered = [two[1], two[0]]
    expect(participantsChipEqual(two, reordered)).toBe(false)
  })

  it('handles undefined / empty rosters', () => {
    expect(participantsChipEqual(undefined, undefined)).toBe(true)
    expect(participantsChipEqual([], [])).toBe(true)
    expect(participantsChipEqual(undefined, [{ id: 'p1', role: 'r', provider: 'codex' }])).toBe(false)
  })
})

describe('identityContextEqual', () => {
  function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
    return {
      appChatId: 'chat-1',
      providerMetadata: { agentIdentities: { 'a-1': { name: 'Ada', color: '#fff' } } },
      ensemble: { participants: [{ id: 'p1', role: 'Worker', provider: 'codex' }] },
      ...overrides
    } as unknown as ChatRecord
  }

  it('is true when scope, identities, and participant chip-slice are unchanged', () => {
    expect(identityContextEqual(chat(), chat())).toBe(true)
  })

  it('is false when the chat scope (appChatId) changes', () => {
    expect(identityContextEqual(chat(), chat({ appChatId: 'chat-2' }))).toBe(false)
  })

  it('is false when an agent identity changes', () => {
    expect(
      identityContextEqual(
        chat(),
        chat({ providerMetadata: { agentIdentities: { 'a-1': { name: 'Babbage', color: '#fff' } } } } as Partial<ChatRecord>)
      )
    ).toBe(false)
  })

  it('is false when a participant role changes mid-stream (the stale-chip regression)', () => {
    expect(
      identityContextEqual(
        chat(),
        chat({ ensemble: { participants: [{ id: 'p1', role: 'Reviewer', provider: 'codex' }] } } as Partial<ChatRecord>)
      )
    ).toBe(false)
  })
})

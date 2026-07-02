import { describe, it, expect } from 'vitest'
import { resolveAssistantDeltaMerge } from './assistantDeltaMerge'

describe('resolveAssistantDeltaMerge', () => {
  describe('genuine increments (codex / gemini / kimi / grok / normal Claude deltas)', () => {
    it('appends the first chunk onto an empty bubble', () => {
      expect(resolveAssistantDeltaMerge('', 'Hello')).toEqual({ action: 'append' })
    })

    it('appends a true delta that is the new suffix', () => {
      // current = "Hello", next delta = " world" — not a superset, not a
      // prefix → append.
      expect(resolveAssistantDeltaMerge('Hello', ' world')).toEqual({ action: 'append' })
    })

    it('appends a new Codex item (genuinely different text)', () => {
      // Body already streamed; a new agentMessage item ("summary") arrives.
      expect(resolveAssistantDeltaMerge('the body text', 'a separate summary')).toEqual({
        action: 'append'
      })
    })

    it('treats an empty incoming as a no-op append', () => {
      expect(resolveAssistantDeltaMerge('Hello', '')).toEqual({ action: 'append' })
    })
  })

  describe('Cursor cumulative full-text frames (untagged)', () => {
    it('replaces when a growing snapshot supersets what we show', () => {
      // Frame 1 rendered "Hello"; frame 2 restates "Hello world".
      expect(resolveAssistantDeltaMerge('Hello', 'Hello world')).toEqual({
        action: 'replace',
        content: 'Hello world'
      })
    })

    it('replaces (no-op) on an identical restate', () => {
      // Final frame repeats the same full text — replace yields the same
      // content, so the bubble is unchanged and NOT doubled.
      expect(resolveAssistantDeltaMerge('Hello world', 'Hello world')).toEqual({
        action: 'replace',
        content: 'Hello world'
      })
    })

    it('skips a stale shorter snapshot arriving out of order', () => {
      expect(resolveAssistantDeltaMerge('Hello world', 'Hello')).toEqual({ action: 'skip' })
    })
  })

  describe('Claude divergent cumulative envelope (tagged by main)', () => {
    it('replaces with the authoritative full text when cumulative is set', () => {
      // Streamed deltas diverged ("Hello  world" vs envelope "Hello world").
      // startsWith would MISS, but the explicit tag forces a replace.
      expect(
        resolveAssistantDeltaMerge('Hello  world', 'Hello world', { cumulative: true })
      ).toEqual({ action: 'replace', content: 'Hello world' })
    })

    it('does not wipe the bubble when cumulative is tagged but incoming is empty', () => {
      expect(resolveAssistantDeltaMerge('Hello world', '', { cumulative: true })).toEqual({
        action: 'append'
      })
    })
  })

  describe('the duplication this prevents', () => {
    it('a full re-send equal to the bubble does NOT become append (which would double it)', () => {
      const current = 'The quick brown fox.'
      const result = resolveAssistantDeltaMerge(current, current)
      expect(result.action).not.toBe('append')
      // replace with the same string → bubble stays single, not doubled.
      expect(result).toEqual({ action: 'replace', content: current })
    })

    it('a cumulative superset re-send replaces instead of concatenating', () => {
      const current = 'Para one.'
      const incoming = 'Para one.\n\nPara two.'
      expect(resolveAssistantDeltaMerge(current, incoming)).toEqual({
        action: 'replace',
        content: incoming
      })
    })
  })

  describe('trusted-incremental lane (run-item sidecar deltas)', () => {
    // The compat mapper tags every restatement, so an untagged sidecar delta
    // is a verbatim increment by contract — shape detection must not swallow
    // a legitimate repeat that happens to byte-match the bubble.
    it('appends a repeat that exactly equals the bubble', () => {
      expect(resolveAssistantDeltaMerge('test ', 'test ', { trustedIncremental: true })).toEqual({
        action: 'append'
      })
    })

    it('appends an increment that happens to superset the bubble', () => {
      expect(resolveAssistantDeltaMerge('no ', 'no no ', { trustedIncremental: true })).toEqual({
        action: 'append'
      })
    })

    it('appends an increment that happens to prefix the bubble', () => {
      expect(resolveAssistantDeltaMerge('la la la', 'la ', { trustedIncremental: true })).toEqual({
        action: 'append'
      })
    })

    it('still replaces on an explicit cumulative tag (tag wins over the lane hint)', () => {
      expect(
        resolveAssistantDeltaMerge('Hello', 'Hello world', {
          cumulative: true,
          trustedIncremental: true
        })
      ).toEqual({ action: 'replace', content: 'Hello world' })
    })

    it('keeps the empty-incoming no-op', () => {
      expect(resolveAssistantDeltaMerge('text', '', { trustedIncremental: true })).toEqual({
        action: 'append'
      })
    })
  })
})

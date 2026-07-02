import { describe, expect, it } from 'vitest'
import { foldBridgeRunText, isTaggedCumulativeRestatement } from './BridgeTextFold'

describe('foldBridgeRunText', () => {
  it('appends the first chunk onto empty assembled text', () => {
    expect(foldBridgeRunText('', 'Hello')).toEqual({ kind: 'append' })
  })

  it('appends a genuine increment (the new suffix, not the full prose)', () => {
    // Codex/Gemini/Kimi true deltas.
    expect(foldBridgeRunText('Hello', ' world')).toEqual({ kind: 'append' })
  })

  it('keeps only the tail of an untagged cumulative snapshot (Cursor)', () => {
    // Pre-tool "Reading." already assembled; Cursor re-states the whole turn.
    expect(foldBridgeRunText('Reading.', 'Reading.\n\nEditing.')).toEqual({
      kind: 'tail',
      tail: '\n\nEditing.'
    })
  })

  it('skips a cumulative snapshot that only re-covers the assembled text', () => {
    expect(foldBridgeRunText('Reading.', 'Reading.')).toEqual({ kind: 'skip' })
  })

  it('skips a stale shorter snapshot we have already surpassed', () => {
    expect(foldBridgeRunText('Reading. Editing.', 'Reading.')).toEqual({ kind: 'skip' })
  })

  it('treats divergent prose (not a clean superset) as a genuine increment', () => {
    // A new segment that does not extend the assembled text → append.
    expect(foldBridgeRunText('Reading.', 'Different start')).toEqual({ kind: 'append' })
  })

  it('no-ops empty incoming via append (caller drops it)', () => {
    expect(foldBridgeRunText('Reading.', '')).toEqual({ kind: 'append' })
  })
})

describe('isTaggedCumulativeRestatement', () => {
  it('matches each tag main uses to mark a restatement', () => {
    // Claude divergent envelope.
    expect(isTaggedCumulativeRestatement({ cumulative: true })).toBe(true)
    // Cursor snapshot frames (index.ts applyCursorRunEvent).
    expect(isTaggedCumulativeRestatement({ runItemCumulative: true })).toBe(true)
    // Forward-compat parity with RunItemEventCompat's mapping.
    expect(isTaggedCumulativeRestatement({ snapshot: true })).toBe(true)
  })

  it('treats an untagged compat payload as a verbatim increment', () => {
    expect(isTaggedCumulativeRestatement({})).toBe(false)
    // Only literal true counts — truthy strings/1 are not the wire contract.
    expect(isTaggedCumulativeRestatement({ cumulative: 1, runItemCumulative: 'true' })).toBe(false)
  })
})

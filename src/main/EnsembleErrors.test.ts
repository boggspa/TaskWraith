import { describe, expect, it } from 'vitest'
import {
  ParticipantUnreachableError,
  classifyDispatchError,
  formatAllUnreachableNote,
  formatDispatchFailureNote,
  formatYieldTargetUnreachableNote,
  participantNoteLabel
} from './EnsembleErrors'
import type { EnsembleParticipant } from './store/types'

function participant(
  overrides: Partial<EnsembleParticipant> & Pick<EnsembleParticipant, 'id' | 'provider'>
): EnsembleParticipant {
  return {
    enabled: true,
    role: '',
    instructions: '',
    order: 0,
    permissionPresetId: 'default',
    ...overrides
  } as EnsembleParticipant
}

describe('classifyDispatchError', () => {
  it('returns unknown for null / undefined input', () => {
    expect(classifyDispatchError(null)).toEqual({ kind: 'unknown', message: '' })
    expect(classifyDispatchError(undefined)).toEqual({ kind: 'unknown', message: '' })
  })

  it('classifies a ParticipantUnreachableError via instanceof check', () => {
    // Highest-precedence path — adapter sites that already know the
    // failure is socket-level wrap their error in this typed class
    // and the classifier reads `underlyingCode` directly instead of
    // sniffing `.code` / message substrings.
    const err = new ParticipantUnreachableError('ensemble-gemini', 'gemini', 'ECONNREFUSED')
    expect(classifyDispatchError(err)).toEqual({
      kind: 'unreachable',
      underlyingCode: 'ECONNREFUSED'
    })
  })

  it('classifies ECONNREFUSED via the Node ErrnoException `.code` field', () => {
    const err = new Error('connect ECONNREFUSED /tmp/taskwraith-gemini-mcp.sock') as Error & {
      code?: string
    }
    err.code = 'ECONNREFUSED'
    expect(classifyDispatchError(err)).toEqual({
      kind: 'unreachable',
      underlyingCode: 'ECONNREFUSED'
    })
  })

  it('classifies ENOENT (missing socket file) as unreachable', () => {
    const err = new Error('socket not found') as Error & { code?: string }
    err.code = 'ENOENT'
    expect(classifyDispatchError(err)).toEqual({
      kind: 'unreachable',
      underlyingCode: 'ENOENT'
    })
  })

  it('classifies ETIMEDOUT, EPIPE, ECONNRESET as unreachable', () => {
    for (const code of ['ETIMEDOUT', 'EPIPE', 'ECONNRESET'] as const) {
      const err = new Error(`socket failure: ${code}`) as Error & { code?: string }
      err.code = code
      expect(classifyDispatchError(err)).toEqual({ kind: 'unreachable', underlyingCode: code })
    }
  })

  it('falls back to message-substring match when `.code` is lost', () => {
    // Wrapped errors that re-throw via `new Error(orig.message)` lose
    // the `.code` field. We salvage the classification from the
    // canonical caps-form code substring in the message.
    const wrapped = new Error('Failed to dispatch: connect ECONNREFUSED on /tmp/x.sock')
    expect(classifyDispatchError(wrapped)).toEqual({
      kind: 'unreachable',
      underlyingCode: 'ECONNREFUSED'
    })
  })

  it('also reads `.code` from plain objects (some adapter wrappers)', () => {
    const adapterError = { code: 'EHOSTUNREACH', message: 'host down' }
    expect(classifyDispatchError(adapterError)).toEqual({
      kind: 'unreachable',
      underlyingCode: 'EHOSTUNREACH'
    })
  })

  it('treats non-socket Error.message as preflight failure', () => {
    const err = new Error('Codex runtime profile not configured')
    expect(classifyDispatchError(err)).toEqual({
      kind: 'preflight',
      message: 'Codex runtime profile not configured'
    })
  })

  it('classifies stale external path grant authority errors separately', () => {
    const err = new Error(
      'External path grant does not match this chat, workspace, provider, or run.'
    )
    expect(classifyDispatchError(err)).toEqual({
      kind: 'external_path_grant',
      message: 'External path grant does not match this chat, workspace, provider, or run.'
    })
  })

  it('classifies plain string inputs as preflight when non-empty', () => {
    expect(classifyDispatchError('Permission preset rejected the run')).toEqual({
      kind: 'preflight',
      message: 'Permission preset rejected the run'
    })
  })

  it('returns unknown for empty / unrecognised values', () => {
    expect(classifyDispatchError('')).toEqual({ kind: 'unknown', message: '' })
    expect(classifyDispatchError(42)).toEqual({ kind: 'unknown', message: '' })
    expect(classifyDispatchError({})).toEqual({ kind: 'unknown', message: '' })
  })
})

describe('formatDispatchFailureNote', () => {
  const codexWorker = participant({
    id: 'codex-worker',
    provider: 'codex',
    role: 'Worker'
  })

  it('formats unreachable failures with provider/role + posix code', () => {
    const note = formatDispatchFailureNote(codexWorker, {
      kind: 'unreachable',
      underlyingCode: 'ECONNREFUSED'
    })
    expect(note).toContain('Codex / Worker')
    expect(note).toContain('unreachable')
    expect(note).toContain('ECONNREFUSED')
    expect(note).toContain('Skipping for this round')
    expect(note).toContain('re-launch the provider CLI')
    // 1.0.4-AR6 — every health-category note now carries the
    // `[participant-health]` tag prefix so the renderer can group
    // them. The warning glyph follows the tag.
    expect(note.startsWith('[participant-health] ⚠')).toBe(true)
  })

  it('formats preflight failures with the error message inline', () => {
    const note = formatDispatchFailureNote(codexWorker, {
      kind: 'preflight',
      message: 'Codex CLI binary missing'
    })
    expect(note).toContain('Codex / Worker')
    expect(note).toContain('dispatch failed')
    expect(note).toContain('Codex CLI binary missing')
    expect(note).toContain('Skipping for this round')
  })

  it('formats external-path-grant failures without skipping seats', () => {
    const note = formatDispatchFailureNote(codexWorker, {
      kind: 'external_path_grant',
      message: 'External path grant does not match this chat, workspace, provider, or run.'
    })
    expect(note).toContain('needs workspace access')
    expect(note).toContain('grant prompt')
    expect(note).not.toContain('Skipping for this round')
  })

  it('trims trailing punctuation from preflight messages so the sentence reads cleanly', () => {
    const note = formatDispatchFailureNote(codexWorker, {
      kind: 'preflight',
      message: 'Codex CLI binary missing.'
    })
    // Result should be `... binary missing. Skipping for this round.`
    // not `... binary missing.. Skipping for this round.`
    expect(note).not.toContain('missing..')
    expect(note).toContain('binary missing. Skipping')
  })

  it('formats unknown failures generically', () => {
    const note = formatDispatchFailureNote(codexWorker, {
      kind: 'unknown',
      message: ''
    })
    expect(note).toContain('Codex / Worker')
    expect(note).toContain('dispatch failed')
    expect(note).toContain('Skipping for this round')
  })

  it('falls back to bare provider name when participant has no role', () => {
    const noRole = participant({ id: 'codex', provider: 'codex' })
    const note = formatDispatchFailureNote(noRole, {
      kind: 'unreachable',
      underlyingCode: 'ECONNREFUSED'
    })
    expect(note).toContain('Codex unreachable')
    expect(note).not.toContain('Codex / ')
  })
})

describe('participantNoteLabel', () => {
  it('joins capitalised provider + role with a slash', () => {
    const p = participant({ id: 'g', provider: 'gemini', role: 'Researcher' })
    expect(participantNoteLabel(p)).toBe('Gemini / Researcher')
  })

  it('returns just the provider when role is empty / whitespace', () => {
    expect(participantNoteLabel(participant({ id: 'g', provider: 'gemini' }))).toBe('Gemini')
    expect(participantNoteLabel(participant({ id: 'g', provider: 'gemini', role: '   ' }))).toBe(
      'Gemini'
    )
  })
})

describe('formatYieldTargetUnreachableNote', () => {
  const gemini = participant({ id: 'gemini', provider: 'gemini', role: 'Researcher' })
  const codex = participant({ id: 'codex', provider: 'codex', role: 'Worker' })

  it('names the dead target, the posix code, and the next-in-rotation', () => {
    const note = formatYieldTargetUnreachableNote(gemini, 'ECONNREFUSED', codex)
    // 1.0.4-AR6 — every health-category note now carries the
    // `[participant-health]` tag prefix so the renderer can group
    // them. The warning glyph follows the tag.
    expect(note.startsWith('[participant-health] ⚠')).toBe(true)
    expect(note).toContain('Yield target Gemini / Researcher')
    expect(note).toContain('ECONNREFUSED')
    expect(note).toContain('Routing to next participant in rotation')
    expect(note).toContain('Codex / Worker')
  })

  it('falls back to "returning to user" when there is no next participant', () => {
    const note = formatYieldTargetUnreachableNote(gemini, 'ETIMEDOUT', null)
    expect(note).toContain('Yield target Gemini / Researcher')
    expect(note).toContain('ETIMEDOUT')
    expect(note).toContain('No further participants')
    expect(note).toContain('returning to user')
    expect(note).not.toContain('Routing to next participant')
  })
})

describe('formatAllUnreachableNote', () => {
  it('emits the chip-strip recovery hint with the warning glyph', () => {
    const note = formatAllUnreachableNote()
    // 1.0.4-AR6 — every health-category note now carries the
    // `[participant-health]` tag prefix so the renderer can group
    // them. The warning glyph follows the tag.
    expect(note.startsWith('[participant-health] ⚠')).toBe(true)
    expect(note).toContain('No reachable participants left')
    expect(note).toContain('Returning to user')
    expect(note).toContain('chip strip')
  })
})

describe('ParticipantUnreachableError', () => {
  it('stores the typed fields and produces a default message', () => {
    const err = new ParticipantUnreachableError('ensemble-gemini', 'gemini', 'ECONNREFUSED')
    expect(err.name).toBe('ParticipantUnreachableError')
    expect(err.participantId).toBe('ensemble-gemini')
    expect(err.providerId).toBe('gemini')
    expect(err.underlyingCode).toBe('ECONNREFUSED')
    expect(err.message).toContain('ensemble-gemini')
    expect(err.message).toContain('gemini')
    expect(err.message).toContain('ECONNREFUSED')
  })

  it('accepts an explicit message override', () => {
    const err = new ParticipantUnreachableError(
      'ensemble-gemini',
      'gemini',
      'ECONNREFUSED',
      'MCP socket /tmp/taskwraith-gemini.sock is down'
    )
    expect(err.message).toBe('MCP socket /tmp/taskwraith-gemini.sock is down')
  })
})

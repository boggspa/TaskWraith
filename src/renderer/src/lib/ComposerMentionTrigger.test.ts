import { describe, expect, it } from 'vitest'
import {
  extractFirstEnsembleDmTarget,
  formatComposerPathMention,
  parseComposerMentionTrigger
} from './ComposerMentionTrigger'

describe('parseComposerMentionTrigger', () => {
  it('matches plain agent-style mention queries with kind=mention', () => {
    expect(parseComposerMentionTrigger('Ask @builder', 12)).toEqual({
      anchorIndex: 4,
      triggerLength: 1,
      kind: 'mention',
      query: 'builder'
    })
  })

  it('matches the new file-mention trigger via -@', () => {
    expect(parseComposerMentionTrigger('Open -@src/renderer/App.tsx')).toEqual({
      anchorIndex: 5,
      triggerLength: 2,
      kind: 'file-mention',
      query: 'src/renderer/App.tsx'
    })
  })

  it('matches -@ at start of line (no leading whitespace)', () => {
    expect(parseComposerMentionTrigger('-@README.md')).toEqual({
      anchorIndex: 0,
      triggerLength: 2,
      kind: 'file-mention',
      query: 'README.md'
    })
  })

  it('still allows path characters after @ for plain mention queries', () => {
    expect(parseComposerMentionTrigger('Open @builder/sub')).toEqual({
      anchorIndex: 5,
      triggerLength: 1,
      kind: 'mention',
      query: 'builder/sub'
    })
  })

  it('requires a token boundary before @ so emails do not trigger', () => {
    expect(parseComposerMentionTrigger('mail me@example.com')).toBeNull()
  })

  it('does not fire plain @ inside a -@ token', () => {
    // The `@` in `-@foo` is preceded by `-`, not whitespace — neither
    // regex should match unless we explicitly handle the file form.
    const result = parseComposerMentionTrigger('text -@foo')
    expect(result?.kind).toBe('file-mention')
    expect(result?.query).toBe('foo')
  })

  it('rejects --@ ambiguous double-dash prefix (does not match either form)', () => {
    expect(parseComposerMentionTrigger('hmm --@foo')).toBeNull()
  })

  it('returns null once the caret has moved past the mention token', () => {
    expect(parseComposerMentionTrigger('Open @src/App.tsx now')).toBeNull()
  })
})

describe('formatComposerPathMention', () => {
  it('keeps simple paths readable and quotes paths with whitespace', () => {
    expect(formatComposerPathMention('src/App.tsx')).toBe('src/App.tsx ')
    expect(formatComposerPathMention('/tmp/My File.txt')).toBe('"/tmp/My File.txt" ')
  })
})

describe('extractFirstEnsembleDmTarget', () => {
  it('extracts the participant id from an ensemble-dm:// markdown link', () => {
    expect(
      extractFirstEnsembleDmTarget(
        'Hey [@Worker](ensemble-dm://ensemble-codex-1) can you look at this?'
      )
    ).toBe('ensemble-codex-1')
  })

  it('returns null when no mention is present', () => {
    expect(extractFirstEnsembleDmTarget('Just a plain message.')).toBeNull()
  })

  it('does not collapse multiple explicit participants into a single DM target', () => {
    expect(
      extractFirstEnsembleDmTarget('[@A](ensemble-dm://id-a) and [@B](ensemble-dm://id-b)')
    ).toBeNull()
  })

  it('ignores other markdown link schemes (e.g. agent://)', () => {
    expect(extractFirstEnsembleDmTarget('[@Helper](agent://thread-xyz) help')).toBeNull()
  })

  it('resolves plain @Role against participants by role (case-insensitive)', () => {
    const participants = [
      { id: 'ensemble-codex', role: 'Worker', provider: 'codex' },
      { id: 'ensemble-gemini', role: 'Researcher', provider: 'gemini' }
    ]
    expect(extractFirstEnsembleDmTarget('@Researcher take a look', participants)).toBe(
      'ensemble-gemini'
    )
    // Case-insensitive role match.
    expect(extractFirstEnsembleDmTarget('please @worker do this', participants)).toBe(
      'ensemble-codex'
    )
  })

  it('falls back to provider name when role does not match', () => {
    const participants = [
      { id: 'ensemble-codex', role: 'Worker', provider: 'codex' },
      { id: 'ensemble-gemini', role: 'Researcher', provider: 'gemini' }
    ]
    expect(extractFirstEnsembleDmTarget('hey @gemini check this', participants)).toBe(
      'ensemble-gemini'
    )
  })

  it('does not collapse multiple plain participant mentions into a single DM target', () => {
    const participants = [
      { id: 'ensemble-cursor', role: 'Cursor', provider: 'cursor' },
      { id: 'ensemble-local', role: 'Local', provider: 'ollama', model: 'gpt-oss' }
    ]
    expect(extractFirstEnsembleDmTarget('@Cursor @Local what do you think?', participants)).toBeNull()
  })

  it('skips @-mentions that match no participant', () => {
    const participants = [{ id: 'ensemble-codex', role: 'Worker', provider: 'codex' }]
    expect(extractFirstEnsembleDmTarget('hello @ghost', participants)).toBeNull()
  })

  it('does not pick up @ inside email-like tokens', () => {
    const participants = [{ id: 'ensemble-gemini', role: 'Researcher', provider: 'gemini' }]
    // `@example.com` is preceded by `e` (not a boundary), so the
    // tokeniser regex won't match — same defence as the transcript
    // tokeniser.
    expect(extractFirstEnsembleDmTarget('contact me@example.com first', participants)).toBeNull()
  })

  it('prefers the markdown link over plain @Role when both are present', () => {
    const participants = [{ id: 'ensemble-codex', role: 'Worker', provider: 'codex' }]
    // Markdown link wins because it unambiguously carries the id.
    expect(
      extractFirstEnsembleDmTarget(
        '@worker reminder: [@Override](ensemble-dm://forced-id)',
        participants
      )
    ).toBe('forced-id')
  })
})

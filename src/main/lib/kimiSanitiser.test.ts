import { describe, expect, it } from 'vitest'
import {
  KIMI_DEFAULT_TRIGGER_KEYWORDS,
  classifyAndRedactForKimi,
  formatCompatibilitySanitiserDiagnostic,
  formatKimiRetryDiagnostic,
  formatKimiRetryFailureDiagnostic,
  formatKimiSanitiserDiagnostic,
  isKimiContentFilterRejection,
  parseCustomKeywords,
  resolvePiCompatibilityFilterRecipient,
  sanitiseForCompatibility,
  sanitiseForKimi
} from './kimiSanitiser'

describe('kimiSanitiser', () => {
  it('returns text unchanged when no triggers match', () => {
    const input =
      'The weather today is lovely. The crops are healthy and the village square is busy.'
    const result = sanitiseForKimi(input)
    expect(result.text).toBe(input)
    expect(result.redacted).toBe(false)
    expect(result.matches).toEqual([])
  })

  it('redacts a sentence containing a default trigger keyword', () => {
    const input =
      'Codex summarised global supply chains. The 1989 Tiananmen anniversary was mentioned in passing. Discussion continued on shipping.'
    const result = sanitiseForKimi(input)
    expect(result.redacted).toBe(true)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].trigger).toBe('Tiananmen')
    expect(result.text).toContain('Codex summarised global supply chains.')
    expect(result.text).toContain(
      '[sentence redacted: TaskWraith Kimi compatibility filter detected content Moonshot rejects]'
    )
    expect(result.text).toContain('Discussion continued on shipping.')
  })

  it('redacts multiple matching sentences in a longer text', () => {
    const input =
      'Hong Kong protest history was covered. The US-China relations summary followed. The market closed up 2%.'
    const result = sanitiseForKimi(input)
    expect(result.redacted).toBe(true)
    expect(result.matches.map((m) => m.trigger)).toEqual([
      'Hong Kong protest',
      'US-China relations'
    ])
    expect(result.text).toContain('The market closed up 2%.')
  })

  it('matches case-insensitively', () => {
    const input = 'TIANANMEN was mentioned. Other content follows.'
    const result = sanitiseForKimi(input)
    expect(result.redacted).toBe(true)
    expect(result.matches[0].trigger).toBe('Tiananmen')
  })

  it('honours user-supplied custom keywords on top of defaults', () => {
    const input =
      'A discussion of the South China Sea dispute appeared in the briefing. Other markets were calm.'
    const baseline = sanitiseForKimi(input)
    expect(baseline.redacted).toBe(false)
    const withCustom = sanitiseForKimi(input, {
      customKeywords: ['South China Sea']
    })
    expect(withCustom.redacted).toBe(true)
    expect(withCustom.matches[0].trigger).toBe('South China Sea')
  })

  it('limits Pi compatibility filtering to DeepSeek and Z.ai upstreams', () => {
    expect(resolvePiCompatibilityFilterRecipient('deepseek')).toBe('DeepSeek')
    expect(resolvePiCompatibilityFilterRecipient('zai')).toBe('Z.ai')
    expect(resolvePiCompatibilityFilterRecipient('mistral')).toBeNull()
    expect(resolvePiCompatibilityFilterRecipient('cerebras')).toBeNull()
  })

  it('uses an accurate recipient placeholder and diagnostic for Pi upstreams', () => {
    const result = sanitiseForCompatibility('Tiananmen was mentioned. Other work continues.', {
      recipient: 'DeepSeek'
    })

    expect(result.text).toContain(
      '[sentence redacted: TaskWraith DeepSeek compatibility filter detected content DeepSeek may reject]'
    )
    const diagnostic = formatCompatibilitySanitiserDiagnostic('DeepSeek', result)
    expect(diagnostic).toContain('DeepSeek compatibility filter redacted 1 sentence')
    expect(diagnostic).toContain("from DeepSeek's view")
    expect(diagnostic).not.toContain('Moonshot')
  })

  it('trims and ignores blank custom keyword lines', () => {
    const result = sanitiseForKimi('Something benign here.', {
      customKeywords: ['', '   ', 'real-trigger', '']
    })
    expect(result.text).toBe('Something benign here.')
    expect(result.redacted).toBe(false)
  })

  it('parses the raw custom-keywords textarea into a usable array', () => {
    const raw = `# A comment line that should be ignored\nSouth China Sea\n\n  Spratly Islands  \n# another comment\nNine Dash Line`
    expect(parseCustomKeywords(raw)).toEqual([
      'South China Sea',
      'Spratly Islands',
      'Nine Dash Line'
    ])
  })

  it('truncates long sentence excerpts in the matches list', () => {
    const longSentence =
      'A sentence that contains Tiananmen and goes on for quite a while ' +
      'with various filler words to push past the 120 character truncation ' +
      'boundary so we can verify the excerpt elision is applied.'
    const result = sanitiseForKimi(longSentence)
    expect(result.redacted).toBe(true)
    expect(result.matches[0].sentenceExcerpt.length).toBeLessThanOrEqual(120)
    expect(result.matches[0].sentenceExcerpt.endsWith('…')).toBe(true)
  })

  it('produces a human-readable diagnostic when sanitisation fired', () => {
    const result = sanitiseForKimi(
      'A summary mentioning Tibet independence appeared. Things continue.'
    )
    const diagnostic = formatKimiSanitiserDiagnostic(result)
    expect(diagnostic).toContain('redacted 1 sentence')
    expect(diagnostic).toContain('Trigger "Tibet independence"')
    expect(diagnostic).toContain('Codex / Claude / Gemini')
  })

  it('produces an empty diagnostic when nothing was redacted', () => {
    const result = sanitiseForKimi('Benign content only.')
    expect(formatKimiSanitiserDiagnostic(result)).toBe('')
  })

  it('caps the diagnostic at 8 matches with a "and N more" suffix', () => {
    const input = Array(10).fill('A Tiananmen reference happened.').join(' ')
    const result = sanitiseForKimi(input)
    const diagnostic = formatKimiSanitiserDiagnostic(result)
    expect(diagnostic).toContain('…and 2 more')
  })

  it('default keyword list is non-empty and contains expected core triggers', () => {
    expect(KIMI_DEFAULT_TRIGGER_KEYWORDS.length).toBeGreaterThan(0)
    expect(KIMI_DEFAULT_TRIGGER_KEYWORDS).toContain('Tiananmen')
    expect(KIMI_DEFAULT_TRIGGER_KEYWORDS).toContain('Xinjiang')
    expect(KIMI_DEFAULT_TRIGGER_KEYWORDS).toContain('Falun Gong')
  })

  it('detects Moonshot content-filter rejection text', () => {
    expect(
      isKimiContentFilterRejection(
        "Error code: 400 - {'error': {'type': 'content_filter', 'message': 'blocked'}}"
      )
    ).toBe(true)
    expect(isKimiContentFilterRejection('request considered high risk')).toBe(true)
    expect(isKimiContentFilterRejection('plain stderr')).toBe(false)
  })

  it('formats retry diagnostics with the selected sanitisation pass', () => {
    const result = sanitiseForKimi('A Tiananmen mention appeared. Other work continues.')
    const diagnostic = formatKimiRetryDiagnostic('keyword', result)
    expect(diagnostic).toContain('retrying once with keyword compatibility filter')
    expect(diagnostic).toContain('Trigger "Tiananmen"')
  })

  it('formats final failure diagnostics when no retry pass can recover', () => {
    const diagnostic = formatKimiRetryFailureDiagnostic({
      attemptedPasses: ['keyword'],
      reason: 'classifier_unavailable'
    })
    expect(diagnostic).toContain('Retry passes attempted: keyword')
    expect(diagnostic).toContain('classifier pass is disabled or unavailable')
  })

  it('keeps the classifier unavailable when it is disabled', () => {
    const result = classifyAndRedactForKimi('The events of 1989 in Beijing came up.', {
      enabled: false
    })
    expect(result.classifierAvailable).toBe(false)
    expect(result.unavailableReason).toBe('disabled')
    expect(result.redacted).toBe(false)
  })

  it('redacts classifier-flagged sentences when the classifier is enabled', () => {
    const result = classifyAndRedactForKimi(
      'A routine build note appeared. The events of 1989 in Beijing came up obliquely.'
    )
    expect(result.redacted).toBe(false)

    const enabled = classifyAndRedactForKimi(
      'A routine build note appeared. The events of 1989 in Beijing came up obliquely.',
      { enabled: true }
    )
    expect(enabled.classifierAvailable).toBe(true)
    expect(enabled.redacted).toBe(true)
    expect(enabled.matches[0].trigger).toBe('1989 Beijing events')
    expect(enabled.text).toContain('A routine build note appeared.')
    expect(enabled.text).toContain('TaskWraith Kimi classifier flagged content')
  })

  it('supports deterministic mocked classifiers', () => {
    const result = classifyAndRedactForKimi('First sentence. Second sentence.', {
      enabled: true,
      classifier: ({ sentences }) => ({
        available: true,
        source: 'mock',
        matches: [{ sentenceIndex: sentences.length - 1, trigger: 'mock-trigger' }]
      })
    })
    expect(result.source).toBe('mock')
    expect(result.matches).toEqual([
      {
        trigger: 'mock-trigger',
        sentenceExcerpt: 'Second sentence.'
      }
    ])
    expect(result.text).toBe(
      'First sentence. [sentence redacted: TaskWraith Kimi classifier flagged content Moonshot may reject]'
    )
  })

  it('surfaces classifier-unavailable state without modifying text', () => {
    const result = classifyAndRedactForKimi('First sentence.', {
      enabled: true,
      classifier: () => ({
        available: false,
        unavailableReason: 'unavailable',
        source: 'mock-unavailable'
      })
    })
    expect(result.text).toBe('First sentence.')
    expect(result.redacted).toBe(false)
    expect(result.classifierAvailable).toBe(false)
    expect(result.unavailableReason).toBe('unavailable')
    expect(result.source).toBe('mock-unavailable')
  })

  it('1.0.5-EW26b: catches diplomatic-summit / arms-package phrasings', () => {
    // Regression for the gap the maintainer spotted in a real transcript:
    // Codex/Politician posted "Trump's Beijing summit... Taiwan
    // arms package after summit aimed at steadying us-china ties"
    // which contained NO words matching the pre-EW26b default
    // list (no "Tiananmen", no "Taiwan independence", no
    // "US-China relations"/"tensions") but would absolutely
    // trigger Moonshot's filter. EW26b adds the summit/arms/ties
    // headline-shape phrasings to the curated baseline.
    const input =
      "Trump's Beijing summit ended with both sides claiming stabilization. " +
      'Trump weighs Taiwan arms package. ' +
      'A focus on steadying us-china ties followed.'
    const result = sanitiseForKimi(input)
    expect(result.redacted).toBe(true)
    // Three trigger matches in three sentences — every sentence
    // contains at least one of the new triggers.
    expect(result.matches).toHaveLength(3)
    const triggers = result.matches.map((m) => m.trigger)
    expect(triggers).toContain('Beijing summit')
    // "Taiwan arms package" and "Taiwan arms" both match; the
    // resolver picks the first one in the list — order in
    // `KIMI_DEFAULT_TRIGGER_KEYWORDS` puts "Taiwan arms" before
    // "Taiwan arms package" so that's what fires first.
    expect(triggers).toContain('Taiwan arms')
    expect(triggers).toContain('US-China ties')
  })
})

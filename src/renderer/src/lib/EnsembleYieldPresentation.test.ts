import { describe, expect, it } from 'vitest'
import { formatEnsembleYieldContentForDisplay } from './EnsembleYieldPresentation'

describe('formatEnsembleYieldContentForDisplay', () => {
  it('chunks long plain-prose handoffs at yield, length, and section boundaries', () => {
    const raw = [
      'Orchestrator yielded.',
      'WRITE UP P6 SO THE RESIDUALS CANNOT BE BURIED — the user asked for this explicitly.',
      'Docs only.',
      "P5's goal is complete and stays complete; this creates no new active goal and reopens nothing.",
      'P6-01 REAL-PROFILE CRASH RECOVERY: prove durable-boundary recovery end to end through a genuinely migrated profile, with a real crash during an active write path and multiple relaunches.',
      'Acceptance: state convergence after relaunch, no queue loss, delivery still exactly-once.',
      'P6-02 INTERRUPTED-START MATRIX: cover the startup-gate permutations that can diverge across relaunch paths and keep assertions strict.',
      'NON-NEGOTIABLE FRAMING: the Keep decision is product state, not implementation debt.'
    ].join(' ')

    const display = formatEnsembleYieldContentForDisplay(raw)
    const paragraphs = display.split('\n\n')

    expect(paragraphs[0]).toBe('Orchestrator yielded.')
    expect(paragraphs.some((paragraph) => paragraph.startsWith('P6-01 '))).toBe(true)
    expect(paragraphs.some((paragraph) => paragraph.startsWith('P6-02 '))).toBe(true)
    expect(paragraphs.some((paragraph) => paragraph.startsWith('NON-NEGOTIABLE FRAMING:'))).toBe(
      true
    )
    expect(paragraphs.length).toBeGreaterThanOrEqual(5)
    expect(display.replace(/\s+/g, ' ').trim()).toBe(raw.replace(/\s+/g, ' ').trim())
  })

  it('keeps short handoffs unchanged', () => {
    const raw = 'Reviewer yielded. Please take the next pass.'
    expect(formatEnsembleYieldContentForDisplay(raw)).toBe(raw)
  })

  it('keeps authored paragraphs, lists, and Markdown unchanged', () => {
    const structured = [
      'Reviewer yielded.',
      '',
      'Please continue with:',
      '',
      '- the migration',
      '- the regression test',
      '',
      '`DoNotSplit.this Example` must remain inline.',
      'x'.repeat(500)
    ].join('\n')

    expect(formatEnsembleYieldContentForDisplay(structured)).toBe(structured)
  })

  it('does not invent breaks when long prose has no safe sentence boundary', () => {
    const raw = `Orchestrator yielded: ${'word '.repeat(120).trim()}`
    expect(formatEnsembleYieldContentForDisplay(raw)).toBe(raw)
  })
})

import { describe, expect, it } from 'vitest'
import { applyMistralPromptPreamble } from './MistralCliArgs'
import {
  MISTRAL_OPENING_STEER,
  MISTRAL_PROGRESS_STEER,
  withMistralProgressSteer
} from './MistralLongTurnProgress'

describe('Vibe progress guidance', () => {
  it.each([true, false])('reaches the working prompt with writeCapable=%s', (writeCapable) => {
    const request = 'Inspect pricing.py, fix the total, and verify the result.'
    const prompt = withMistralProgressSteer(applyMistralPromptPreamble(request, writeCapable))
    expect(prompt).toContain(MISTRAL_PROGRESS_STEER)
    expect(prompt.endsWith(request)).toBe(true)
    expect(prompt).toContain('issue the first tool call in the same response')
    expect(prompt).toContain('Respect user denials and explicit no-tools instructions')
  })

  it('does not request a second introduction after the private opening is shown', () => {
    const prompt = withMistralProgressSteer('Fix the file.', 'I will inspect the file.')
    expect(prompt).toContain('Begin the actual work now')
    expect(prompt).toContain(MISTRAL_PROGRESS_STEER)
    expect(prompt).not.toContain(MISTRAL_OPENING_STEER)
    expect(prompt.endsWith('Fix the file.')).toBe(true)
  })

  it('does not duplicate guidance or rewrite native slash commands', () => {
    const once = withMistralProgressSteer('Read the file.')
    expect(withMistralProgressSteer(once)).toBe(once)
    expect(withMistralProgressSteer('  /compact')).toBe('  /compact')
  })
})

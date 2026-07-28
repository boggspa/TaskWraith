import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensembleRoundStatusClass } from './ensembleRoundStatusClass'

const transcriptCss = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/02-transcript-messages-fx.css'),
  'utf8'
).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('ensembleRoundStatusClass', () => {
  it('identifies ensemble round-status / handback lines', () => {
    expect(
      ensembleRoundStatusClass({ role: 'system', metadata: { kind: 'ensembleRoundStatus' } })
    ).toBe(' system-round-status')
  })

  it('leaves other system messages and non-system roles unaccented', () => {
    expect(
      ensembleRoundStatusClass({ role: 'system', metadata: { kind: 'ensembleParticipantStatus' } })
    ).toBe('')
    expect(
      ensembleRoundStatusClass({ role: 'assistant', metadata: { kind: 'ensembleRoundStatus' } })
    ).toBe('')
    expect(ensembleRoundStatusClass({ role: 'system', metadata: {} })).toBe('')
    expect(ensembleRoundStatusClass({ role: 'user', metadata: {} })).toBe('')
  })

  it('keeps ensemble round-status lines satellite instead of carded', () => {
    const block = cssBlockStartingAt(transcriptCss, '.message-bubble.system.system-round-status {')

    expect(block).toContain('background: transparent')
    expect(block).toContain('border: 0')
    expect(block).toContain('border-radius: 0')
    expect(block).toContain('box-shadow: none')
    expect(block).not.toContain('color-mix')
  })
})

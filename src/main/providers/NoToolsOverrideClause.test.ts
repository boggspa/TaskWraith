import { describe, expect, it } from 'vitest'
import { AMBIGUOUS_NO_TOOLS_OVERRIDE_PHRASE, noToolsOverrideClause } from './NoToolsOverrideClause'

describe('noToolsOverrideClause', () => {
  it('reads as a condition on an instruction the model must be able to quote', () => {
    const clause = noToolsOverrideClause('shell, file, or any other tool')
    expect(clause).toContain('only by an explicit no-tools instruction')
    expect(clause).toContain('If you cannot quote such an instruction, no override is in effect')
    expect(clause).toContain('use the listed tools')
    expect(clause).toContain('do not call shell, file, or any other tool.')
    expect(clause).toMatch(/use the listed tools\.$/)
    expect(clause).not.toContain(AMBIGUOUS_NO_TOOLS_OVERRIDE_PHRASE)
  })

  it.each([
    'read, shell, file, or any other tool',
    'shell, file, or any other tool',
    'read, shell, file, goal, or any other tool',
    'shell, file, goal, or any other tool',
    'file, goal, or any other tool'
  ])('names exactly the forbidden set it is given: %s', (forbidden) => {
    const clause = noToolsOverrideClause(forbidden)
    expect(clause).toContain(`do not call ${forbidden}.`)
    expect(clause.indexOf('do not call')).toBe(clause.lastIndexOf('do not call'))
    // The affirmative closes the paragraph; a trailing prohibition is the defect.
    expect(clause.endsWith('use the listed tools.')).toBe(true)
  })
})

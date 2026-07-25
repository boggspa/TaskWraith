import { describe, expect, it } from 'vitest'
import { agenticServicesDenyWrites } from './AgenticServiceWriteClamp'

describe('agenticServicesDenyWrites', () => {
  it('denies when either write-bearing service is denied', () => {
    expect(agenticServicesDenyWrites({ shellCommands: 'deny', fileChanges: 'allow' })).toBe(true)
    expect(agenticServicesDenyWrites({ shellCommands: 'allow', fileChanges: 'deny' })).toBe(true)
    expect(agenticServicesDenyWrites({ shellCommands: 'deny', fileChanges: 'deny' })).toBe(true)
  })

  it('permits writes for ask and allow', () => {
    expect(agenticServicesDenyWrites({ shellCommands: 'ask', fileChanges: 'ask' })).toBe(false)
    expect(agenticServicesDenyWrites({ shellCommands: 'allow', fileChanges: 'allow' })).toBe(false)
    expect(agenticServicesDenyWrites({ shellCommands: 'ask', fileChanges: 'allow' })).toBe(false)
  })

  // Absent settings must not fabricate a denial: callers with no settings
  // context keep their previous behaviour rather than silently losing writes.
  it('does not deny when settings are missing', () => {
    expect(agenticServicesDenyWrites(null)).toBe(false)
    expect(agenticServicesDenyWrites(undefined)).toBe(false)
  })
})

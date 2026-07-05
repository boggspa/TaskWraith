import { describe, expect, it } from 'vitest'
import { claudeSdkThinkingConfigForEffort } from './ClaudeThinkingConfig'

describe('claudeSdkThinkingConfigForEffort', () => {
  it('requests summarized adaptive thinking when Claude reasoning effort is enabled', () => {
    expect(claudeSdkThinkingConfigForEffort('high')).toEqual({
      type: 'adaptive',
      display: 'summarized'
    })
  })

  it('does not pass a thinking display config when Claude reasoning is disabled', () => {
    expect(claudeSdkThinkingConfigForEffort(null)).toBeNull()
    expect(claudeSdkThinkingConfigForEffort(undefined)).toBeNull()
  })
})

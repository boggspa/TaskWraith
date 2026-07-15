import { describe, it, expect } from 'vitest'
import {
  classifyKimiSessionGeneration,
  wireResumeSessionId
} from './KimiSessionGeneration'

describe('classifyKimiSessionGeneration', () => {
  it('classifies an ACP session_ id as acp', () => {
    expect(classifyKimiSessionGeneration('session_75a9d4c6-bd56-4bb6-a100-92028d8b5989')).toBe('acp')
  })

  it('classifies a bare uuid as wire', () => {
    expect(classifyKimiSessionGeneration('676cd41c-19b6-403e-ac14-96623345ae03')).toBe('wire')
  })

  it('classifies empty/nullish as unknown', () => {
    expect(classifyKimiSessionGeneration('')).toBe('unknown')
    expect(classifyKimiSessionGeneration(null)).toBe('unknown')
    expect(classifyKimiSessionGeneration(undefined)).toBe('unknown')
    expect(classifyKimiSessionGeneration('   ')).toBe('unknown')
  })
})

describe('wireResumeSessionId', () => {
  it('resumes a wire-generation id', () => {
    expect(wireResumeSessionId('676cd41c-19b6-403e-ac14-96623345ae03')).toBe(
      '676cd41c-19b6-403e-ac14-96623345ae03'
    )
  })

  it('refuses an ACP-generation id (cross-generation resume → fresh)', () => {
    expect(wireResumeSessionId('session_75a9d4c6-bd56-4bb6-a100-92028d8b5989')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(wireResumeSessionId('')).toBeNull()
    expect(wireResumeSessionId(undefined)).toBeNull()
  })
})

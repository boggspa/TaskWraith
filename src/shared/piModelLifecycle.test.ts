import { describe, expect, it } from 'vitest'
import {
  activePiModelRows,
  hasReachedPiModelRetirementDate,
  isPiModelRetired,
  piModelRetiresAt
} from './piModelLifecycle'

describe('Pi model lifecycle', () => {
  it('records only the verified Cerebras GLM-4.7 sunset', () => {
    expect(piModelRetiresAt('cerebras/zai-glm-4.7')).toBe('2026-08-17')
    expect(piModelRetiresAt('zai/glm-4.7')).toBeUndefined()
    expect(piModelRetiresAt('cerebras/gpt-oss-120b')).toBeUndefined()
  })

  it('takes the date-only sunset at the start of the local calendar day', () => {
    expect(isPiModelRetired('cerebras/zai-glm-4.7', new Date(2026, 7, 16, 23, 59))).toBe(false)
    expect(isPiModelRetired('cerebras/zai-glm-4.7', new Date(2026, 7, 17, 0, 0))).toBe(true)
    expect(isPiModelRetired('cerebras/zai-glm-4.7', new Date(2026, 7, 18, 0, 0))).toBe(true)
  })

  it('fails open for malformed lifecycle dates', () => {
    const now = new Date(2026, 7, 17, 12)
    expect(hasReachedPiModelRetirementDate('2026-02-30', now)).toBe(false)
    expect(hasReachedPiModelRetirementDate('17-08-2026', now)).toBe(false)
    expect(hasReachedPiModelRetirementDate('', now)).toBe(false)
    expect(hasReachedPiModelRetirementDate(undefined, now)).toBe(false)
  })

  it('warns before the sunset and removes only the Cerebras row on the date', () => {
    const rows = [
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      { id: 'cerebras/zai-glm-4.7', label: 'GLM-4.7 (Cerebras)' },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' }
    ]

    expect(activePiModelRows(rows, new Date(2026, 7, 16))).toEqual([
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      {
        id: 'cerebras/zai-glm-4.7',
        label: 'GLM-4.7 (Cerebras)',
        retiresAt: '2026-08-17'
      },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' }
    ])
    expect(activePiModelRows(rows, new Date(2026, 7, 17))).toEqual([
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' }
    ])
  })
})

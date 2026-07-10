import { describe, expect, it } from 'vitest'
import { buildParticipantTokenChipTooltipLine } from './participantTokenChip'
import type { EnsembleParticipant } from '../../../main/store/types'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'p',
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    instructions: '',
    order: 1,
    permissionPresetId: 'workspace_write',
    ...overrides
  } as EnsembleParticipant
}

function line(tokenTotals?: EnsembleParticipant['tokenTotals']): string {
  return buildParticipantTokenChipTooltipLine(participant({ tokenTotals }))
}

describe('buildParticipantTokenChipTooltipLine', () => {
  it('reports no usage when participant has no tokenTotals', () => {
    expect(line()).toBe('No token usage yet')
  })

  it('reports no usage at zero total tokens', () => {
    expect(line({ total_tokens: 0 })).toBe('No token usage yet')
  })

  it('shows the exact count under 1k (no display floor, unlike the retired badge)', () => {
    expect(line({ total_tokens: 950 })).toContain('≈ 950 tokens')
  })

  it('formats k for thousands (rounded)', () => {
    expect(line({ total_tokens: 1000 })).toContain('≈ 1k tokens')
    expect(line({ total_tokens: 12_344 })).toContain('≈ 12k tokens')
    expect(line({ total_tokens: 847_500 })).toContain('≈ 848k tokens')
  })

  it('formats m for millions (one decimal under 10, integer at and above)', () => {
    expect(line({ total_tokens: 1_234_567 })).toContain('≈ 1.2m tokens')
    expect(line({ total_tokens: 9_999_999 })).toContain('≈ 10.0m tokens')
    expect(line({ total_tokens: 14_500_000 })).toContain('≈ 15m tokens')
  })

  it('appends the multi-segment breakdown from input/output/total/duration', () => {
    const result = line({
      input_tokens: 8500,
      output_tokens: 4200,
      total_tokens: 12_700,
      duration_ms: 4500
    })
    expect(result).toContain('8,500 in')
    expect(result).toContain('4,200 out')
    expect(result).toContain('12,700 total')
    expect(result).toContain('4.5s')
  })

  it('formats duration over a minute as minutes', () => {
    expect(line({ total_tokens: 5000, duration_ms: 90_000 })).toContain('1.5m')
  })

  it('omits zero-valued breakdown segments cleanly', () => {
    const result = line({ input_tokens: 0, output_tokens: 5000, total_tokens: 5000 })
    expect(result).not.toContain('0 in')
    expect(result).toContain('5,000 out')
    expect(result).toContain('5,000 total')
  })
})

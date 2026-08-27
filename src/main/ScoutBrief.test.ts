import { describe, expect, it, vi } from 'vitest'
import {
  formatScoutBriefsForPrompt,
  handleScoutBrief,
  type ScoutBriefDeps,
  type ScoutBriefRecord
} from './ScoutBrief'

/*
 * 1.0.4-AK6 regression coverage for the `scout_brief` MCP tool.
 *
 * Pins every validation gate (no active fan-out pass, unknown
 * participant, missing/invalid args) + the happy path that
 * records a structured brief. Also covers the prompt-formatting
 * helper used by the writer's system prompt.
 */
function makeDeps(over: Partial<ScoutBriefDeps> = {}): ScoutBriefDeps {
  return {
    getParticipantIdForRun: () => 'claude-1',
    getParticipantMeta: () => ({ role: 'Reviewer', provider: 'claude' }),
    isParticipantInScoutPass: () => true,
    recordScoutBrief: vi.fn(),
    ...over
  }
}

describe('handleScoutBrief', () => {
  describe('happy paths', () => {
    it('records a brief with findings + confidence + optional fields', () => {
      const recordScoutBrief = vi.fn()
      const deps = makeDeps({ recordScoutBrief })
      const result = handleScoutBrief(
        'run-1',
        {
          findings: 'Module X has 3 invariants worth preserving.',
          confidence: 'high',
          blockers: ['shared lock'],
          recommendations: ['lift to Z'],
          tags: ['concurrency']
        },
        deps
      )
      expect(result.ok).toBe(true)
      expect(recordScoutBrief).toHaveBeenCalledOnce()
      const brief = recordScoutBrief.mock.calls[0][1] as ScoutBriefRecord
      expect(brief.findings).toContain('3 invariants')
      expect(brief.confidence).toBe('high')
      expect(brief.blockers).toEqual(['shared lock'])
      expect(brief.recommendations).toEqual(['lift to Z'])
      expect(brief.tags).toEqual(['concurrency'])
      expect(brief.participantId).toBe('claude-1')
      expect(brief.participantRole).toBe('Reviewer')
      expect(brief.provider).toBe('claude')
      expect(result.message).toBe(
        'Scout brief shared · Reviewer (claude) · Blackboard + next writer.'
      )
      expect(result.message).not.toContain('confidence high')
    })

    it('accepts a brief with only required fields (no blockers/recs/tags)', () => {
      const recordScoutBrief = vi.fn()
      const result = handleScoutBrief(
        'run-1',
        { findings: 'All clear.', confidence: 'medium' },
        makeDeps({ recordScoutBrief })
      )
      expect(result.ok).toBe(true)
      const brief = recordScoutBrief.mock.calls[0][1] as ScoutBriefRecord
      expect(brief.blockers).toBeUndefined()
      expect(brief.recommendations).toBeUndefined()
      expect(brief.tags).toBeUndefined()
      expect(result.message).toContain('tentative')
    })

    it('truncates findings to MAX_FINDINGS_LENGTH', () => {
      const recordScoutBrief = vi.fn()
      const big = 'x'.repeat(5000)
      handleScoutBrief(
        'run-1',
        { findings: big, confidence: 'low' },
        makeDeps({ recordScoutBrief })
      )
      const brief = recordScoutBrief.mock.calls[0][1] as ScoutBriefRecord
      expect(brief.findings.length).toBeLessThanOrEqual(4000)
    })

    it('caps list-shaped fields at MAX_LIST_ITEMS', () => {
      const recordScoutBrief = vi.fn()
      const longList = Array.from({ length: 30 }).map((_, i) => `item-${i}`)
      handleScoutBrief(
        'run-1',
        {
          findings: 'lots',
          confidence: 'low',
          blockers: longList,
          recommendations: longList,
          tags: longList
        },
        makeDeps({ recordScoutBrief })
      )
      const brief = recordScoutBrief.mock.calls[0][1] as ScoutBriefRecord
      expect(brief.blockers?.length).toBe(8)
      expect(brief.recommendations?.length).toBe(8)
      expect(brief.tags?.length).toBe(8)
    })
  })

  describe('error gates', () => {
    it('rejects when run is not in an active fan-out pass', () => {
      const result = handleScoutBrief(
        'run-1',
        { findings: 'x', confidence: 'high' },
        makeDeps({ isParticipantInScoutPass: () => false })
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('no_active_scout_pass')
    })

    it('rejects when participantId cannot be resolved', () => {
      const result = handleScoutBrief(
        'run-1',
        { findings: 'x', confidence: 'high' },
        makeDeps({ getParticipantIdForRun: () => null })
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('unknown_participant')
    })

    it('rejects when participant meta is missing', () => {
      const result = handleScoutBrief(
        'run-1',
        { findings: 'x', confidence: 'high' },
        makeDeps({ getParticipantMeta: () => null })
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('unknown_participant')
    })

    it('rejects when findings is empty', () => {
      const result = handleScoutBrief('run-1', { findings: '   ', confidence: 'high' }, makeDeps())
      expect(result.ok).toBe(false)
      expect(result.error).toBe('missing_findings')
    })

    it('rejects when confidence is missing or invalid', () => {
      const result = handleScoutBrief(
        'run-1',
        { findings: 'x', confidence: 'medium-rare' as never },
        makeDeps()
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('invalid_confidence')
    })

    it('rejects when runId is empty', () => {
      const result = handleScoutBrief('', { findings: 'x', confidence: 'high' }, makeDeps())
      expect(result.ok).toBe(false)
      expect(result.error).toBe('no_active_scout_pass')
    })
  })
})

describe('formatScoutBriefsForPrompt', () => {
  it('returns empty string for empty input', () => {
    expect(formatScoutBriefsForPrompt([])).toBe('')
  })

  it('formats a single brief with all optional fields', () => {
    const result = formatScoutBriefsForPrompt([
      {
        participantId: 'c-1',
        participantRole: 'Reviewer',
        provider: 'claude',
        findings: 'Module X has 3 invariants.',
        confidence: 'high',
        blockers: ['shared lock'],
        recommendations: ['lift to Z'],
        tags: ['concurrency'],
        emittedAt: '2026-05-26T00:00:00.000Z'
      }
    ])
    expect(result).toContain('Fan-out briefs from the parallel pass:')
    expect(result).toContain('[Reviewer (claude)] (high) — Module X has 3 invariants.')
    expect(result).toContain('Blockers:')
    expect(result).toContain('- shared lock')
    expect(result).toContain('Recommendations:')
    expect(result).toContain('- lift to Z')
    expect(result).toContain('Tags: concurrency')
  })

  it('formats multiple briefs in order', () => {
    const result = formatScoutBriefsForPrompt([
      {
        participantId: 'c-1',
        participantRole: 'Reviewer',
        provider: 'claude',
        findings: 'First scout result.',
        confidence: 'high',
        emittedAt: '2026-05-26T00:00:00.000Z'
      },
      {
        participantId: 'g-1',
        participantRole: 'Researcher',
        provider: 'gemini',
        findings: 'Second scout result.',
        confidence: 'medium',
        emittedAt: '2026-05-26T00:00:01.000Z'
      }
    ])
    const firstIdx = result.indexOf('First scout')
    const secondIdx = result.indexOf('Second scout')
    expect(firstIdx).toBeGreaterThan(-1)
    expect(secondIdx).toBeGreaterThan(firstIdx)
  })

  it('omits optional sections when arrays are empty/missing', () => {
    const result = formatScoutBriefsForPrompt([
      {
        participantId: 'c-1',
        participantRole: 'Reviewer',
        provider: 'claude',
        findings: 'Minimal brief.',
        confidence: 'low',
        emittedAt: '2026-05-26T00:00:00.000Z'
      }
    ])
    expect(result).not.toContain('Blockers:')
    expect(result).not.toContain('Recommendations:')
    expect(result).not.toContain('Tags:')
  })
})

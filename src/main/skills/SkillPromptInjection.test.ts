import { describe, expect, it } from 'vitest'
import { MAX_SKILL_DISCOVERY_LIST, buildSkillDiscoveryBlock } from './SkillPromptInjection'

describe('buildSkillDiscoveryBlock', () => {
  it('returns null for an empty skill list', () => {
    expect(buildSkillDiscoveryBlock([])).toBeNull()
  })

  it('returns null when every entry lacks an id', () => {
    expect(buildSkillDiscoveryBlock([{ id: '  ', name: 'X', description: 'y' }])).toBeNull()
  })

  it('lists enabled skill names and one-line descriptions', () => {
    const block = buildSkillDiscoveryBlock([
      {
        id: 'review-diff',
        name: 'Review Diff',
        description: 'Review the current workspace diff carefully.'
      },
      {
        id: 'commit-style',
        name: 'Commit Style',
        description: 'Match the repo commit message style.'
      }
    ])

    expect(block).toContain('## Available skills')
    expect(block).toContain('skill_list')
    expect(block).toContain('skill_read')
    expect(block).toContain(
      'Review Diff (`review-diff`): Review the current workspace diff carefully.'
    )
    expect(block).toContain('Commit Style (`commit-style`): Match the repo commit message style.')
    expect(block).not.toContain('full body dumped')
  })

  it('collapses multi-line descriptions to one line', () => {
    const block = buildSkillDiscoveryBlock([
      {
        id: 'multi',
        name: 'Multi',
        description: 'Line one.\nLine two.\n\nLine three.'
      }
    ])
    expect(block).toContain('Multi (`multi`): Line one. Line two. Line three.')
    expect(block?.split('\n').some((line) => line.includes('Line one. Line two.'))).toBe(true)
  })

  it('caps the listed skill count and mentions the remainder', () => {
    const skills = Array.from({ length: MAX_SKILL_DISCOVERY_LIST + 3 }, (_, i) => ({
      id: `skill-${i}`,
      name: `Skill ${i}`,
      description: `Description ${i}`
    }))
    const block = buildSkillDiscoveryBlock(skills)
    expect(block).toBeTruthy()
    const listed = (block ?? '').split('\n').filter((line) => /^-\s+.+\(`skill-\d+`\)/.test(line))
    expect(listed).toHaveLength(MAX_SKILL_DISCOVERY_LIST)
    expect(block).toContain('…and 3 more')
    expect(block).toContain('skill_list')
  })

  it('falls back to id when name is blank', () => {
    const block = buildSkillDiscoveryBlock([
      { id: 'only-id', name: '  ', description: 'Has body elsewhere.' }
    ])
    expect(block).toContain('- only-id (`only-id`): Has body elsewhere.')
  })
})

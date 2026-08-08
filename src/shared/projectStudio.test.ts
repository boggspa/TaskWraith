import { describe, expect, it } from 'vitest'

import {
  MAX_PROJECT_STUDIO_TITLE_LENGTH,
  buildProjectStudioRelativePath,
  parseProjectStudioCompanionMeta,
  parseProjectStudioKind,
  parseProjectStudioStatus,
  renderProjectStudioMarkdown,
  slugifyProjectStudioTitle
} from './projectStudio'

const draftMeta = {
  schemaVersion: 1 as const,
  id: 'draft-a',
  projectId: 'project-a',
  kind: 'briefing' as const,
  status: 'draft' as const,
  title: 'Q3 Research Briefing',
  slug: 'q3-research-briefing',
  relativePath:
    '.taskwraith/project-library/project-a/studio/briefing/q3-research-briefing-2026-08-08.md',
  sourceReferenceIds: ['ref-a', 'ref-b'],
  chatId: 'chat-a',
  createdAt: 100,
  updatedAt: 110
}

describe('projectStudio codecs', () => {
  it('parses studio kinds and companion statuses', () => {
    expect(parseProjectStudioKind('briefing')).toBe('briefing')
    expect(parseProjectStudioKind('faq')).toBe('faq')
    expect(parseProjectStudioKind('decision-log')).toBe('decision-log')
    expect(parseProjectStudioKind('memo')).toBeNull()

    expect(parseProjectStudioStatus('draft')).toBe('draft')
    expect(parseProjectStudioStatus('saved')).toBe('saved')
    expect(parseProjectStudioStatus('discarded')).toBe('discarded')
    expect(parseProjectStudioStatus('published')).toBeNull()
  })

  it('builds project-library studio paths with slug and date', () => {
    expect(
      buildProjectStudioRelativePath({
        projectId: 'project-a',
        kind: 'faq',
        slug: 'onboarding-faq',
        date: '2026-08-08'
      })
    ).toBe('.taskwraith/project-library/project-a/studio/faq/onboarding-faq-2026-08-08.md')
  })

  it('slugifies titles for keepable filenames', () => {
    expect(slugifyProjectStudioTitle('Q3 Research Briefing!')).toBe('q3-research-briefing')
    expect(slugifyProjectStudioTitle('  ---  ')).toBe('studio-artifact')
  })

  it('round-trips companion meta and rejects unknown keys', () => {
    expect(parseProjectStudioCompanionMeta(draftMeta)).toEqual(draftMeta)
    expect(parseProjectStudioCompanionMeta({ ...draftMeta, hidden: true })).toBeNull()
  })

  it('requires referenceId when saved and discardedAt when discarded', () => {
    expect(
      parseProjectStudioCompanionMeta({
        ...draftMeta,
        status: 'saved',
        referenceId: 'ref-studio-1',
        updatedAt: 120
      })
    ).toEqual({
      ...draftMeta,
      status: 'saved',
      referenceId: 'ref-studio-1',
      updatedAt: 120
    })
    expect(
      parseProjectStudioCompanionMeta({
        ...draftMeta,
        status: 'saved',
        updatedAt: 120
      })
    ).toBeNull()

    expect(
      parseProjectStudioCompanionMeta({
        ...draftMeta,
        status: 'discarded',
        discardedAt: 130,
        updatedAt: 130
      })
    ).toEqual({
      ...draftMeta,
      status: 'discarded',
      discardedAt: 130,
      updatedAt: 130
    })
    expect(
      parseProjectStudioCompanionMeta({
        ...draftMeta,
        status: 'discarded',
        updatedAt: 130
      })
    ).toBeNull()
  })

  it('rejects control/bidi characters and overlong titles', () => {
    expect(
      parseProjectStudioCompanionMeta({
        ...draftMeta,
        title: 'Brief\nTitle'
      })
    ).toBeNull()
    expect(
      parseProjectStudioCompanionMeta({
        ...draftMeta,
        title: 'x'.repeat(MAX_PROJECT_STUDIO_TITLE_LENGTH + 1)
      })
    ).toBeNull()
    expect(
      parseProjectStudioCompanionMeta({
        ...draftMeta,
        id: 'draft\u202Ea'
      })
    ).toBeNull()
  })

  it('renders office-research templates with a Sources section of titles', () => {
    const sources = [
      { title: 'Market Brief', excerpt: 'Demand rose in Q2.' },
      { title: 'Competitor Notes', excerpt: 'Rival launched early.' }
    ]

    const briefing = renderProjectStudioMarkdown({
      kind: 'briefing',
      title: 'Q3 Research Briefing',
      sources
    })
    expect(briefing).toContain('# Q3 Research Briefing')
    expect(briefing).toContain('## Sources')
    expect(briefing).toContain('- Market Brief')
    expect(briefing).toContain('- Competitor Notes')
    expect(briefing).toContain('Demand rose in Q2.')

    const faq = renderProjectStudioMarkdown({
      kind: 'faq',
      title: 'Research FAQ',
      sources
    })
    expect(faq).toContain('# Research FAQ')
    expect(faq).toContain('## Sources')
    expect(faq).toContain('### From Market Brief')

    const decisions = renderProjectStudioMarkdown({
      kind: 'decision-log',
      title: 'Decision Log',
      sources
    })
    expect(decisions).toContain('# Decision Log')
    expect(decisions).toContain('## Sources')
    expect(decisions).toContain('## Candidate decisions')
  })
})

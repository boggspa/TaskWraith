import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillRecord } from '../../../shared/skills/SkillTypes'
import { SkillsSettingsPanel } from './SkillsSettingsPanel'

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: 'demo-skill',
    name: 'Demo skill',
    description: 'A sample skill',
    body: 'Do the thing.',
    enabled: true,
    scope: 'user',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides
  }
}

describe('SkillsSettingsPanel', () => {
  it('lists user and workspace skills with enable/delete controls', () => {
    const html = renderToStaticMarkup(
      <SkillsSettingsPanel
        skills={[
          makeSkill(),
          makeSkill({
            id: 'ws-skill',
            name: 'Workspace skill',
            scope: 'workspace',
            enabled: false
          })
        ]}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        onRevealRoot={vi.fn()}
        workspaceLabel="AGBench"
      />
    )

    expect(html).toContain('Skills')
    expect(html).toContain('Demo skill')
    expect(html).toContain('Workspace skill')
    expect(html).toContain('User skills')
    expect(html).toContain('Workspace skills')
    expect(html).toContain('Create skill')
    expect(html).toContain('Reveal user root')
    expect(html).toContain('aria-label="Enable skill Demo skill"')
    expect(html).toContain('Delete')
  })

  it('shows empty states when no skills are present', () => {
    const html = renderToStaticMarkup(
      <SkillsSettingsPanel
        skills={[]}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        onRevealRoot={vi.fn()}
      />
    )
    expect(html).toContain('No user skills yet.')
    expect(html).toContain('No workspace selected.')
  })
})

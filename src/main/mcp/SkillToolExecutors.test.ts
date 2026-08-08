import { describe, expect, it, vi } from 'vitest'
import type { EffectiveSkill } from '../../shared/skills/SkillTypes'
import {
  SKILL_MCP_TOOL_NAMES,
  createSkillToolExecutors,
  executeSkillTool,
  isSkillMcpToolName,
  registerSkillToolExecutors
} from './SkillToolExecutors'

function skill(over: Partial<EffectiveSkill> & Pick<EffectiveSkill, 'id'>): EffectiveSkill {
  return {
    id: over.id,
    name: over.name ?? over.id,
    description: over.description ?? '',
    body: over.body ?? '',
    scope: over.scope ?? 'user',
    source: over.source ?? 'user',
    updatedAt: over.updatedAt ?? '2026-08-08T00:00:00.000Z',
    ...(over.workspaceId ? { workspaceId: over.workspaceId } : {}),
    ...(over.relativePath ? { relativePath: over.relativePath } : {})
  }
}

describe('isSkillMcpToolName', () => {
  it('matches only the skill tool family', () => {
    for (const name of SKILL_MCP_TOOL_NAMES) {
      expect(isSkillMcpToolName(name)).toBe(true)
    }
    expect(isSkillMcpToolName('skill_write')).toBe(false)
    expect(isSkillMcpToolName('tw_introspection_list')).toBe(false)
  })
})

describe('createSkillToolExecutors', () => {
  it('returns an executor map keyed by SKILL_MCP_TOOL_NAMES', () => {
    const map = createSkillToolExecutors({
      skillsStore: { resolveEffectiveSkills: () => [] }
    })
    expect(Object.keys(map).sort()).toEqual([...SKILL_MCP_TOOL_NAMES].sort())
    expect(registerSkillToolExecutors).toBe(createSkillToolExecutors)
  })

  it('skill_list returns effective skills without bodies', async () => {
    const resolveEffectiveSkills = vi.fn(() => [
      skill({
        id: 'review-diff',
        name: 'Review Diff',
        description: 'Review carefully.',
        body: 'FULL BODY SHOULD NOT APPEAR',
        source: 'workspace',
        scope: 'workspace'
      })
    ])
    const map = createSkillToolExecutors({ skillsStore: { resolveEffectiveSkills } })
    const result = await map.skill_list({}, { workspacePath: '/ws', workspaceId: 'ws-1' })
    const parsed = JSON.parse(result.text)

    expect(result.isError).toBeFalsy()
    expect(resolveEffectiveSkills).toHaveBeenCalledWith('/ws', 'ws-1')
    expect(parsed.ok).toBe(true)
    expect(parsed.count).toBe(1)
    expect(parsed.skills[0]).toMatchObject({
      id: 'review-diff',
      name: 'Review Diff',
      description: 'Review carefully.',
      source: 'workspace'
    })
    expect(parsed.skills[0].body).toBeUndefined()
    expect(parsed.note).toContain('skill_read')
  })

  it('skill_read returns the full body for an enabled skill id', async () => {
    const resolveEffectiveSkills = vi.fn(() => [
      skill({
        id: 'commit-style',
        name: 'Commit Style',
        description: 'Match commits.',
        body: 'Use conventional commits.\nKeep subject under 72 chars.'
      })
    ])
    const map = createSkillToolExecutors({ skillsStore: { resolveEffectiveSkills } })
    const result = await map.skill_read({ id: 'commit-style' }, { workspacePath: '/ws' })
    const parsed = JSON.parse(result.text)

    expect(result.isError).toBeFalsy()
    expect(parsed.ok).toBe(true)
    expect(parsed.skill).toMatchObject({
      id: 'commit-style',
      name: 'Commit Style',
      body: 'Use conventional commits.\nKeep subject under 72 chars.'
    })
  })

  it('skill_read errors when id is missing or not enabled', async () => {
    const map = createSkillToolExecutors({
      skillsStore: {
        resolveEffectiveSkills: () => [skill({ id: 'present', body: 'x' })]
      }
    })

    const missingId = await map.skill_read({}, { workspacePath: '/ws' })
    expect(missingId.isError).toBe(true)
    expect(JSON.parse(missingId.text).error).toMatch(/requires a skill `id`/)

    const unknown = await map.skill_read({ id: 'absent' }, { workspacePath: '/ws' })
    expect(unknown.isError).toBe(true)
    expect(JSON.parse(unknown.text).error).toMatch(/not found or not enabled/)
  })

  it('refuses skill tools without a workspace path', async () => {
    const resolveEffectiveSkills = vi.fn(() => [])
    const map = createSkillToolExecutors({ skillsStore: { resolveEffectiveSkills } })

    const list = await map.skill_list({}, {})
    expect(list.isError).toBe(true)
    expect(resolveEffectiveSkills).not.toHaveBeenCalled()

    const read = await map.skill_read({ id: 'x' }, { workspacePath: '  ' })
    expect(read.isError).toBe(true)
  })

  it('executeSkillTool dispatches through the map and rejects unknown names', async () => {
    const map = createSkillToolExecutors({
      skillsStore: {
        resolveEffectiveSkills: () => [skill({ id: 'a', body: 'body-a' })]
      }
    })
    const ok = await executeSkillTool(map, 'skill_read', { id: 'a' }, { workspacePath: '/ws' })
    expect(JSON.parse(ok.text).skill.body).toBe('body-a')

    const bad = await executeSkillTool(map, 'skill_delete', {}, { workspacePath: '/ws' })
    expect(bad.isError).toBe(true)
  })
})

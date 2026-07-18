import { describe, expect, it, vi } from 'vitest'
import type { ProjectReference } from '../../../shared/projects'
import {
  applyProjectReferenceActionResult,
  referencesForActiveProject,
  type ProjectReferencesDockState
} from '../lib/projectReferencesDockState'

const references: [ProjectReference, ProjectReference] = [
  {
    id: 'ref-a',
    projectId: 'project-a',
    kind: 'file' as const,
    locator: '/tmp/alpha.docx',
    title: 'Alpha brief',
    provenance: { addedBy: 'user' as const, addedAt: 1 },
    contextPolicy: 'available' as const,
    updatedAt: 1
  },
  {
    id: 'ref-b',
    projectId: 'project-b',
    kind: 'file' as const,
    locator: '/tmp/beta.xlsx',
    title: 'Beta model',
    provenance: { addedBy: 'user' as const, addedAt: 1 },
    contextPolicy: 'available' as const,
    updatedAt: 1
  }
]

describe('ProjectReferencesDockPanel project switching', () => {
  it('never renders Project A locators under Project B', () => {
    const state: ProjectReferencesDockState = {
      projectId: 'project-a',
      references: [references[0]]
    }
    const loadReferences = vi.fn((projectId: string) =>
      references.filter((reference) => reference.projectId === projectId)
    )

    const visible = referencesForActiveProject(state, 'project-b', loadReferences)

    expect(visible).toEqual([references[1]])
    expect(visible.map((reference) => reference.locator)).not.toContain('/tmp/alpha.docx')
    expect(loadReferences).toHaveBeenCalledWith('project-b')
  })

  it('ignores a deferred Project A action after switching to Project B', () => {
    const state: ProjectReferencesDockState = {
      projectId: 'project-b',
      references: [references[1]]
    }
    const loadReferences = vi.fn(() => [references[0]])

    const next = applyProjectReferenceActionResult({
      state,
      activeProjectId: 'project-b',
      actionProjectId: 'project-a',
      loadReferences
    })

    expect(next).toBe(state)
    expect(next.references).toEqual([references[1]])
    expect(loadReferences).not.toHaveBeenCalled()
  })
})

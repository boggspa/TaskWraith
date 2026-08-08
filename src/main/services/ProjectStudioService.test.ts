import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectReferenceExtract } from '../../shared/projectReferenceExtract'
import type { ProjectReference, ProjectReferenceOp } from '../../shared/projects'
import { parseProjectStudioCompanionMeta } from '../../shared/projectStudio'
import { PROJECT_STUDIO_DIR_NAME, ProjectStudioService } from './ProjectStudioService'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tw-studio-svc-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

function readyExtract(
  overrides: Partial<ProjectReferenceExtract> &
    Pick<ProjectReferenceExtract, 'id' | 'referenceId'> = {
    id: 'extract-a',
    referenceId: 'ref-a'
  }
): ProjectReferenceExtract {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    kind: 'plain-text',
    status: 'ready',
    consent: { at: 1, actor: 'user', scope: 'this-reference' },
    source: { locator: '/workspace/notes.txt' },
    text: {
      charCount: 20,
      truncated: false,
      artifactSha256: 'a'.repeat(64)
    },
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

function fixture(options?: {
  extracts?: Map<string, ProjectReferenceExtract>
  texts?: Map<string, string>
  applyReferenceOp?: (op: ProjectReferenceOp) => { references: ProjectReference[] }
}) {
  const root = makeRoot()
  const userDataPath = path.join(root, 'userData')
  const workspacePath = path.join(root, 'workspace')
  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
  fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 })

  const extracts =
    options?.extracts ?? new Map<string, ProjectReferenceExtract>([['ref-a', readyExtract()]])
  const texts =
    options?.texts ??
    new Map<string, string>([['extract-a', 'Demand rose in Q2 across enterprise accounts.']])

  const applyReferenceOp =
    options?.applyReferenceOp ??
    vi.fn((op: ProjectReferenceOp) => {
      if (op.kind !== 'add-reference') throw new Error('unexpected op')
      const reference: ProjectReference = {
        id: op.id,
        projectId: op.projectId,
        kind: op.referenceKind,
        locator: op.locator,
        title: op.title ?? 'Studio artifact',
        provenance: { addedBy: 'user', addedAt: op.now },
        contextPolicy: 'available',
        updatedAt: op.now
      }
      return { references: [reference] }
    })

  const service = new ProjectStudioService({
    userDataPath,
    getActiveExtract: (projectId, referenceId) => {
      const extract = extracts.get(referenceId) ?? null
      if (!extract || extract.projectId !== projectId) return null
      if (extract.status === 'revoked' || extract.status === 'stale') return null
      return extract
    },
    readExtractText: (extractId) => texts.get(extractId) ?? null,
    applyReferenceOp,
    now: () => Date.UTC(2026, 7, 8, 12, 0, 0),
    randomId: () => 'draft-fixed-1'
  })

  return { service, userDataPath, workspacePath, applyReferenceOp, extracts, texts }
}

describe('ProjectStudioService', () => {
  it('fails closed when any reference lacks a ready extract', async () => {
    const { service, workspacePath } = fixture({
      extracts: new Map()
    })
    const result = await service.generateDraft({
      projectId: 'project-a',
      kind: 'briefing',
      referenceIds: ['ref-missing'],
      chatId: 'chat-a',
      workspacePath
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('extract_not_ready')
    expect(result.referenceId).toBe('ref-missing')
    expect(fs.existsSync(path.join(workspacePath, '.taskwraith'))).toBe(false)
  })

  it('fails closed when an active extract is not ready', async () => {
    const { service, workspacePath } = fixture({
      extracts: new Map([
        [
          'ref-a',
          readyExtract({
            id: 'extract-a',
            referenceId: 'ref-a',
            status: 'pending',
            text: undefined
          })
        ]
      ])
    })
    const result = await service.generateDraft({
      projectId: 'project-a',
      kind: 'faq',
      referenceIds: ['ref-a'],
      chatId: 'chat-a',
      workspacePath
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('extract_not_ready')
    expect(result.referenceId).toBe('ref-a')
  })

  it('writes a markdown draft and draft companion meta without mutating ProjectRegistry', async () => {
    const { service, workspacePath, userDataPath, applyReferenceOp } = fixture()
    const result = await service.generateDraft({
      projectId: 'project-a',
      kind: 'briefing',
      referenceIds: ['ref-a'],
      title: 'Q3 Research Briefing',
      chatId: 'chat-a',
      workspacePath
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.status).toBe('draft')
    expect(result.artifact.relativePath).toBe(
      '.taskwraith/project-library/project-a/studio/briefing/q3-research-briefing-2026-08-08.md'
    )
    expect(applyReferenceOp).not.toHaveBeenCalled()

    const markdownPath = path.join(workspacePath, result.artifact.relativePath)
    const markdown = fs.readFileSync(markdownPath, 'utf8')
    expect(markdown).toContain('# Q3 Research Briefing')
    expect(markdown).toContain('## Sources')
    expect(markdown).toContain('Demand rose in Q2')

    const metaPath = path.join(
      userDataPath,
      PROJECT_STUDIO_DIR_NAME,
      'project-a',
      `${result.artifact.id}.json`
    )
    const meta = parseProjectStudioCompanionMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')))
    expect(meta?.status).toBe('draft')
    expect(meta?.sourceReferenceIds).toEqual(['ref-a'])

    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(userDataPath, PROJECT_STUDIO_DIR_NAME)).mode & 0o777
      expect(mode).toBe(0o700)
    }
  })

  it('saveToLibrary adds a file reference and marks companion saved', async () => {
    const { service, workspacePath, applyReferenceOp } = fixture()
    const draft = await service.generateDraft({
      projectId: 'project-a',
      kind: 'decision-log',
      referenceIds: ['ref-a'],
      title: 'Decision Log',
      chatId: 'chat-a',
      workspacePath
    })
    expect(draft.ok).toBe(true)
    if (!draft.ok) return

    const saved = await service.saveToLibrary({
      projectId: 'project-a',
      draftId: draft.artifact.id,
      title: 'Decision Log v1'
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.artifact.status).toBe('saved')
    expect(saved.artifact.referenceId).toBe(`ref-studio-${draft.artifact.id}`)
    expect(applyReferenceOp).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyReferenceOp).mock.calls[0]?.[0]).toMatchObject({
      kind: 'add-reference',
      projectId: 'project-a',
      referenceKind: 'file',
      title: 'Decision Log v1',
      locator: draft.artifact.relativePath
    })
  })

  it('discardDraft marks companion discarded and listArtifacts returns non-discarded by default', async () => {
    const { service, workspacePath } = fixture()
    const draft = await service.generateDraft({
      projectId: 'project-a',
      kind: 'faq',
      referenceIds: ['ref-a'],
      title: 'Research FAQ',
      chatId: 'chat-a',
      workspacePath
    })
    expect(draft.ok).toBe(true)
    if (!draft.ok) return

    const listed = await service.listArtifacts({ projectId: 'project-a' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.artifacts).toHaveLength(1)

    const discarded = await service.discardDraft({
      projectId: 'project-a',
      draftId: draft.artifact.id
    })
    expect(discarded.ok).toBe(true)
    if (!discarded.ok) return
    expect(discarded.artifact.status).toBe('discarded')

    const after = await service.listArtifacts({ projectId: 'project-a' })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.artifacts).toHaveLength(0)

    const including = await service.listArtifacts({
      projectId: 'project-a',
      includeDiscarded: true
    })
    expect(including.ok).toBe(true)
    if (!including.ok) return
    expect(including.artifacts).toHaveLength(1)
    expect(including.artifacts[0]?.status).toBe('discarded')
  })
})

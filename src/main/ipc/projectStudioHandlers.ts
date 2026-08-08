import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  parseProjectStudioKind,
  type ProjectStudioCompanionMeta,
  type ProjectStudioKind
} from '../../shared/projectStudio'
import type {
  DiscardProjectStudioDraftInput,
  GenerateProjectStudioDraftInput,
  ListProjectStudioArtifactsInput,
  ProjectStudioListResult,
  ProjectStudioResult,
  SaveProjectStudioDraftInput
} from '../services/ProjectStudioService'

export interface ProjectStudioHandlerDeps {
  assertSenderCanManageProjects: (event: IpcMainInvokeEvent) => void
  generateDraft: (
    input: GenerateProjectStudioDraftInput
  ) => Promise<ProjectStudioResult<ProjectStudioCompanionMeta>>
  saveToLibrary: (
    input: SaveProjectStudioDraftInput
  ) => Promise<ProjectStudioResult<ProjectStudioCompanionMeta>>
  discardDraft: (
    input: DiscardProjectStudioDraftInput
  ) => Promise<ProjectStudioResult<ProjectStudioCompanionMeta>>
  listArtifacts: (input: ListProjectStudioArtifactsInput) => Promise<ProjectStudioListResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}

function parseGenerateRequest(value: unknown): GenerateProjectStudioDraftInput {
  if (!isRecord(value)) throw new Error('Malformed Project Studio generate request.')
  const allowed = new Set(['projectId', 'kind', 'referenceIds', 'title', 'chatId', 'workspacePath'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project Studio generate request.')
  }
  const kind = parseProjectStudioKind(value.kind)
  if (!kind) throw new Error('Studio kind must be briefing, faq, or decision-log.')
  if (!Array.isArray(value.referenceIds) || value.referenceIds.length === 0) {
    throw new Error('referenceIds must be a non-empty array.')
  }
  const referenceIds: string[] = []
  for (const entry of value.referenceIds) {
    referenceIds.push(requireId(entry, 'Reference id'))
  }
  let title: string | undefined
  if ('title' in value) {
    if (typeof value.title !== 'string' || !value.title.trim()) {
      throw new Error('Malformed Studio title.')
    }
    title = value.title.trim()
  }
  return {
    projectId: requireId(value.projectId, 'Project id'),
    kind: kind as ProjectStudioKind,
    referenceIds,
    chatId: requireId(value.chatId, 'Chat id'),
    workspacePath: requireId(value.workspacePath, 'Workspace path'),
    ...(title ? { title } : {})
  }
}

function parseSaveRequest(value: unknown): SaveProjectStudioDraftInput {
  if (!isRecord(value)) throw new Error('Malformed Project Studio save request.')
  const allowed = new Set(['projectId', 'draftId', 'title'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project Studio save request.')
  }
  let title: string | undefined
  if ('title' in value) {
    if (typeof value.title !== 'string' || !value.title.trim()) {
      throw new Error('Malformed Studio title.')
    }
    title = value.title.trim()
  }
  return {
    projectId: requireId(value.projectId, 'Project id'),
    draftId: requireId(value.draftId, 'Draft id'),
    ...(title ? { title } : {})
  }
}

function parseDiscardRequest(value: unknown): DiscardProjectStudioDraftInput {
  if (!isRecord(value)) throw new Error('Malformed Project Studio discard request.')
  const allowed = new Set(['projectId', 'draftId'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project Studio discard request.')
  }
  return {
    projectId: requireId(value.projectId, 'Project id'),
    draftId: requireId(value.draftId, 'Draft id')
  }
}

function parseListRequest(value: unknown): ListProjectStudioArtifactsInput {
  if (!isRecord(value)) throw new Error('Malformed Project Studio list request.')
  const allowed = new Set(['projectId', 'includeDiscarded'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project Studio list request.')
  }
  let includeDiscarded: boolean | undefined
  if ('includeDiscarded' in value) {
    if (typeof value.includeDiscarded !== 'boolean') {
      throw new Error('includeDiscarded must be a boolean.')
    }
    includeDiscarded = value.includeDiscarded
  }
  return {
    projectId: requireId(value.projectId, 'Project id'),
    ...(includeDiscarded !== undefined ? { includeDiscarded } : {})
  }
}

export function registerProjectStudioHandlers(deps: ProjectStudioHandlerDeps): void {
  ipcMain.handle('projects:studio-generate', async (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    return deps.generateDraft(parseGenerateRequest(raw))
  })

  ipcMain.handle('projects:studio-save', async (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    return deps.saveToLibrary(parseSaveRequest(raw))
  })

  ipcMain.handle('projects:studio-discard', async (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    return deps.discardDraft(parseDiscardRequest(raw))
  })

  ipcMain.handle('projects:studio-list', async (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    return deps.listArtifacts(parseListRequest(raw))
  })
}

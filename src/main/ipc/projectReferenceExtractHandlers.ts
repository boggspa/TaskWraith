import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  parseProjectReferenceExtractConsent,
  type ProjectReferenceExtract,
  type ProjectReferenceExtractConsent
} from '../../shared/projectReferenceExtract'
import {
  PROJECT_REFERENCE_EXTRACT_KEEP_CHARS,
  type ProjectReferenceExtractRequestResult,
  type RequestProjectReferenceExtractInput
} from '../services/ProjectReferenceExtractService'

const MAX_READ_CHARS = PROJECT_REFERENCE_EXTRACT_KEEP_CHARS

export interface ProjectReferenceExtractHandlerDeps {
  assertSenderCanManageProjects: (event: IpcMainInvokeEvent) => void
  requestExtract: (
    input: RequestProjectReferenceExtractInput
  ) => Promise<ProjectReferenceExtractRequestResult>
  getActiveExtract: (projectId: string, referenceId: string) => ProjectReferenceExtract | null
  revokeExtract: (extractId: string) => ProjectReferenceExtractRequestResult
  readExtractText: (extractId: string) => string | null
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

function parseExtractRequest(value: unknown): RequestProjectReferenceExtractInput {
  if (!isRecord(value)) throw new Error('Malformed Project reference extract request.')
  const allowed = new Set(['projectId', 'referenceId', 'chatId', 'consent'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project reference extract request.')
  }
  const projectId = requireId(value.projectId, 'Project id')
  const referenceId = requireId(value.referenceId, 'Reference id')
  if (!('consent' in value) || value.consent == null) {
    throw new Error('Explicit extract consent is required.')
  }
  const consent = parseProjectReferenceExtractConsent(value.consent)
  if (!consent) {
    throw new Error('Explicit extract consent is required.')
  }
  let chatId: string | undefined
  if ('chatId' in value) {
    if (typeof value.chatId !== 'string' || !value.chatId.trim()) {
      throw new Error('Malformed chat id.')
    }
    chatId = value.chatId.trim()
  }
  return {
    projectId,
    referenceId,
    consent: consent as ProjectReferenceExtractConsent,
    ...(chatId ? { chatId } : {})
  }
}

function parseProjectReferencePair(value: unknown): { projectId: string; referenceId: string } {
  if (!isRecord(value)) throw new Error('Malformed Project reference extract lookup.')
  const allowed = new Set(['projectId', 'referenceId'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project reference extract lookup.')
  }
  return {
    projectId: requireId(value.projectId, 'Project id'),
    referenceId: requireId(value.referenceId, 'Reference id')
  }
}

function parseExtractId(value: unknown): string {
  if (typeof value === 'string') return requireId(value, 'Extract id')
  if (!isRecord(value)) throw new Error('Malformed extract id.')
  return requireId(value.extractId, 'Extract id')
}

function parseReadRequest(value: unknown): { extractId: string; maxChars: number } {
  if (!isRecord(value)) throw new Error('Malformed Project reference extract text read.')
  const allowed = new Set(['extractId', 'maxChars'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project reference extract text read.')
  }
  const extractId = requireId(value.extractId, 'Extract id')
  let maxChars = MAX_READ_CHARS
  if ('maxChars' in value) {
    if (
      typeof value.maxChars !== 'number' ||
      !Number.isSafeInteger(value.maxChars) ||
      value.maxChars < 1
    ) {
      throw new Error('maxChars must be a positive integer.')
    }
    maxChars = Math.min(value.maxChars, MAX_READ_CHARS)
  }
  return { extractId, maxChars }
}

export function registerProjectReferenceExtractHandlers(
  deps: ProjectReferenceExtractHandlerDeps
): void {
  ipcMain.handle('projects:extract-reference', async (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const input = parseExtractRequest(raw)
    return deps.requestExtract(input)
  })

  ipcMain.handle('projects:get-reference-extract', (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const { projectId, referenceId } = parseProjectReferencePair(raw)
    return deps.getActiveExtract(projectId, referenceId)
  })

  ipcMain.handle('projects:revoke-reference-extract', (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const extractId = parseExtractId(raw)
    return deps.revokeExtract(extractId)
  })

  ipcMain.handle('projects:read-reference-extract-text', (event, raw: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const { extractId, maxChars } = parseReadRequest(raw)
    const text = deps.readExtractText(extractId)
    if (text == null) {
      return { ok: false as const, code: 'not_found', message: 'Extract text is unavailable.' }
    }
    if (text.length <= maxChars) {
      return { ok: true as const, text, truncated: false, charCount: text.length }
    }
    return {
      ok: true as const,
      text: text.slice(0, maxChars),
      truncated: true,
      charCount: text.length
    }
  })
}

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'

import type { ProjectReferenceExtract } from '../../shared/projectReferenceExtract'
import type { ProjectReference, ProjectReferenceOp } from '../../shared/projects'
import {
  buildProjectStudioRelativePath,
  parseProjectStudioCompanionMeta,
  parseProjectStudioKind,
  projectStudioDateStamp,
  renderProjectStudioMarkdown,
  slugifyProjectStudioTitle,
  type ProjectStudioCompanionMeta,
  type ProjectStudioKind
} from '../../shared/projectStudio'
import { isSafeChatId } from '../ChatPath'

/**
 * P2 Studio-lite: template-synthesize keepable office drafts from ready P1
 * extracts. Companion meta lives under userData; markdown under the workspace.
 *
 * Agent-assisted LLM path is a follow-up — MVP is extract-template synthesis.
 */

export const PROJECT_STUDIO_DIR_NAME = 'project-studio'

export type ProjectStudioFailureCode =
  | 'invalid_input'
  | 'extract_not_ready'
  | 'not_found'
  | 'invalid_state'
  | 'persistence_failed'
  | 'workspace_unsafe'

export type ProjectStudioResult<T> =
  | { ok: true; artifact: T }
  | {
      ok: false
      code: ProjectStudioFailureCode
      message: string
      referenceId?: string
    }

export type ProjectStudioListResult =
  | { ok: true; artifacts: ProjectStudioCompanionMeta[] }
  | { ok: false; code: ProjectStudioFailureCode; message: string }

export interface GenerateProjectStudioDraftInput {
  projectId: string
  kind: ProjectStudioKind
  referenceIds: string[]
  title?: string
  chatId: string
  workspacePath: string
}

export interface SaveProjectStudioDraftInput {
  projectId: string
  draftId: string
  title?: string
}

export interface DiscardProjectStudioDraftInput {
  projectId: string
  draftId: string
}

export interface ListProjectStudioArtifactsInput {
  projectId: string
  includeDiscarded?: boolean
}

export interface ProjectStudioServiceDeps {
  userDataPath: string
  getActiveExtract: (projectId: string, referenceId: string) => ProjectReferenceExtract | null
  readExtractText: (extractId: string) => string | null
  applyReferenceOp: (op: ProjectReferenceOp) => { references: readonly ProjectReference[] }
  now?: () => number
  randomId?: () => string
}

function safeFlatId(value: unknown): value is string {
  return (
    isSafeChatId(value) && Buffer.byteLength(value, 'utf8') <= 512 && path.basename(value) === value
  )
}

function sameFileIdentity(left: fsSync.Stats, right: fsSync.Stats): boolean {
  if (left.ino !== right.ino) return false
  return process.platform === 'win32' || left.dev === right.dev
}

function isMainOwned(stat: fsSync.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return (
    (uid === null || stat.uid === uid) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0)
  )
}

function prepareMainOwnedDirectory(directory: string): string | null {
  if (!path.isAbsolute(directory) || directory.includes('\0')) return null
  const requested = path.resolve(directory)
  try {
    fsSync.mkdirSync(requested, { recursive: true, mode: 0o700 })
    const requestedLstat = fsSync.lstatSync(requested)
    if (requestedLstat.isSymbolicLink() || !requestedLstat.isDirectory()) return null

    const canonical = fsSync.realpathSync.native(requested)
    const canonicalLstat = fsSync.lstatSync(canonical)
    const canonicalStat = fsSync.statSync(canonical)
    if (
      canonicalLstat.isSymbolicLink() ||
      !canonicalLstat.isDirectory() ||
      !canonicalStat.isDirectory() ||
      !sameFileIdentity(canonicalLstat, canonicalStat) ||
      !isMainOwned(canonicalStat)
    ) {
      return null
    }
    return canonical
  } catch {
    return null
  }
}

function resolveWorkspaceRoot(workspacePath: string): string | null {
  if (!path.isAbsolute(workspacePath) || workspacePath.includes('\0')) return null
  try {
    const resolved = path.resolve(workspacePath)
    const lstat = fsSync.lstatSync(resolved)
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return null
    return fsSync.realpathSync.native(resolved)
  } catch {
    return null
  }
}

function defaultTitleForKind(kind: ProjectStudioKind): string {
  switch (kind) {
    case 'briefing':
      return 'Research Briefing'
    case 'faq':
      return 'Research FAQ'
    case 'decision-log':
      return 'Decision Log'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function sourceTitle(extract: ProjectReferenceExtract): string {
  const locator = extract.source.locator
  const leaf = path.basename(locator)
  return leaf && leaf !== locator ? leaf : locator
}

export class ProjectStudioService {
  constructor(private readonly deps: ProjectStudioServiceDeps) {}

  private metaRoot(): string | null {
    return prepareMainOwnedDirectory(path.join(this.deps.userDataPath, PROJECT_STUDIO_DIR_NAME))
  }

  private projectMetaDir(projectId: string): string | null {
    const root = this.metaRoot()
    if (!root || !safeFlatId(projectId)) return null
    return prepareMainOwnedDirectory(path.join(root, projectId))
  }

  private metaPath(projectId: string, draftId: string): string | null {
    const dir = this.projectMetaDir(projectId)
    if (!dir || !safeFlatId(draftId)) return null
    return path.join(dir, `${draftId}.json`)
  }

  private async readMeta(
    projectId: string,
    draftId: string
  ): Promise<ProjectStudioCompanionMeta | null> {
    const filePath = this.metaPath(projectId, draftId)
    if (!filePath) return null
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      return parseProjectStudioCompanionMeta(JSON.parse(raw))
    } catch {
      return null
    }
  }

  private async writeMeta(meta: ProjectStudioCompanionMeta): Promise<boolean> {
    const filePath = this.metaPath(meta.projectId, meta.id)
    if (!filePath) return false
    const parsed = parseProjectStudioCompanionMeta(meta)
    if (!parsed) return false
    const dir = path.dirname(filePath)
    const tempPath = path.join(dir, `.${meta.id}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await fs.rename(tempPath, filePath)
      return true
    } catch {
      try {
        await fs.unlink(tempPath)
      } catch {
        // best-effort cleanup
      }
      return false
    }
  }

  private collectReadySources(
    projectId: string,
    referenceIds: readonly string[]
  ):
    | {
        ok: true
        sources: Array<{
          referenceId: string
          title: string
          locator: string
          excerpt: string
        }>
      }
    | { ok: false; code: ProjectStudioFailureCode; message: string; referenceId?: string } {
    if (referenceIds.length === 0) {
      return {
        ok: false,
        code: 'invalid_input',
        message: 'At least one ready Project reference extract is required.'
      }
    }
    const seen = new Set<string>()
    const sources: Array<{
      referenceId: string
      title: string
      locator: string
      excerpt: string
    }> = []
    for (const referenceId of referenceIds) {
      if (!safeFlatId(referenceId)) {
        return {
          ok: false,
          code: 'invalid_input',
          message: 'Reference id is invalid.',
          referenceId: typeof referenceId === 'string' ? referenceId : undefined
        }
      }
      if (seen.has(referenceId)) continue
      seen.add(referenceId)

      const extract = this.deps.getActiveExtract(projectId, referenceId)
      if (!extract || extract.status !== 'ready') {
        return {
          ok: false,
          code: 'extract_not_ready',
          message:
            'Each Studio source must have a ready P1 extract. Missing, pending, failed, or revoked extracts are rejected.',
          referenceId
        }
      }
      const text = this.deps.readExtractText(extract.id)
      if (text == null) {
        return {
          ok: false,
          code: 'extract_not_ready',
          message: 'Ready extract text is unavailable for a Studio source.',
          referenceId
        }
      }
      sources.push({
        referenceId,
        title: sourceTitle(extract),
        locator: extract.source.locator,
        excerpt: text
      })
    }
    return { ok: true, sources }
  }

  async generateDraft(
    input: GenerateProjectStudioDraftInput
  ): Promise<ProjectStudioResult<ProjectStudioCompanionMeta>> {
    if (!safeFlatId(input.projectId) || !safeFlatId(input.chatId)) {
      return { ok: false, code: 'invalid_input', message: 'Project id and chat id are required.' }
    }
    const kind = parseProjectStudioKind(input.kind)
    if (!kind) {
      return { ok: false, code: 'invalid_input', message: 'Unknown Studio artifact kind.' }
    }
    if (!Array.isArray(input.referenceIds)) {
      return { ok: false, code: 'invalid_input', message: 'referenceIds must be an array.' }
    }

    const collected = this.collectReadySources(input.projectId, input.referenceIds)
    if (!collected.ok) {
      return {
        ok: false,
        code: collected.code,
        message: collected.message,
        ...(collected.referenceId ? { referenceId: collected.referenceId } : {})
      }
    }

    const workspaceRoot = resolveWorkspaceRoot(input.workspacePath)
    if (!workspaceRoot) {
      return {
        ok: false,
        code: 'workspace_unsafe',
        message: 'Workspace path is missing or unsafe for Studio drafts.'
      }
    }

    const now = this.deps.now?.() ?? Date.now()
    const title = (input.title?.trim() || defaultTitleForKind(kind)).slice(0, 240)
    const slug = slugifyProjectStudioTitle(title)
    let relativePath: string
    try {
      relativePath = buildProjectStudioRelativePath({
        projectId: input.projectId,
        kind,
        slug,
        date: projectStudioDateStamp(now)
      })
    } catch {
      return { ok: false, code: 'invalid_input', message: 'Could not build Studio artifact path.' }
    }

    const absolutePath = path.resolve(workspaceRoot, relativePath)
    if (absolutePath !== workspaceRoot && !absolutePath.startsWith(workspaceRoot + path.sep)) {
      return {
        ok: false,
        code: 'workspace_unsafe',
        message: 'Studio draft path escaped the workspace.'
      }
    }

    const markdown = renderProjectStudioMarkdown({
      kind,
      title,
      sources: collected.sources.map((source) => ({
        title: source.title,
        locator: source.locator,
        excerpt: source.excerpt
      }))
    })

    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 })
      await fs.writeFile(absolutePath, markdown, { encoding: 'utf8', mode: 0o600 })
    } catch {
      return {
        ok: false,
        code: 'persistence_failed',
        message: 'Failed to write Studio markdown draft under the workspace.'
      }
    }

    const id = this.deps.randomId?.() ?? `studio-${randomUUID()}`
    const artifact: ProjectStudioCompanionMeta = {
      schemaVersion: 1,
      id,
      projectId: input.projectId,
      kind,
      status: 'draft',
      title,
      slug,
      relativePath,
      sourceReferenceIds: collected.sources.map((source) => source.referenceId),
      chatId: input.chatId,
      createdAt: now,
      updatedAt: now
    }

    if (!(await this.writeMeta(artifact))) {
      return {
        ok: false,
        code: 'persistence_failed',
        message: 'Failed to persist Studio companion meta.'
      }
    }

    return { ok: true, artifact }
  }

  async saveToLibrary(
    input: SaveProjectStudioDraftInput
  ): Promise<ProjectStudioResult<ProjectStudioCompanionMeta>> {
    if (!safeFlatId(input.projectId) || !safeFlatId(input.draftId)) {
      return { ok: false, code: 'invalid_input', message: 'Project id and draft id are required.' }
    }
    const current = await this.readMeta(input.projectId, input.draftId)
    if (!current || current.projectId !== input.projectId) {
      return { ok: false, code: 'not_found', message: 'Studio draft was not found.' }
    }
    if (current.status === 'discarded') {
      return {
        ok: false,
        code: 'invalid_state',
        message: 'Discarded Studio drafts cannot be saved.'
      }
    }
    if (current.status === 'saved' && current.referenceId) {
      return { ok: true, artifact: current }
    }

    const now = this.deps.now?.() ?? Date.now()
    const title = input.title?.trim() || current.title
    const referenceId = `ref-studio-${current.id}`
    // Persist the workspace-relative project-library path so catalogue rows stay
    // portable across worktree moves without recording workspacePath in meta.
    const locator = current.relativePath

    try {
      this.deps.applyReferenceOp({
        kind: 'add-reference',
        id: referenceId,
        projectId: input.projectId,
        referenceKind: 'file',
        locator,
        title,
        now
      })
    } catch (error) {
      return {
        ok: false,
        code: 'persistence_failed',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to add Studio artifact to Project references.'
      }
    }

    const saved: ProjectStudioCompanionMeta = {
      schemaVersion: 1,
      id: current.id,
      projectId: current.projectId,
      kind: current.kind,
      status: 'saved',
      title,
      slug: current.slug,
      relativePath: current.relativePath,
      sourceReferenceIds: current.sourceReferenceIds,
      ...(current.chatId ? { chatId: current.chatId } : {}),
      createdAt: current.createdAt,
      updatedAt: now,
      referenceId
    }

    if (!(await this.writeMeta(saved))) {
      return {
        ok: false,
        code: 'persistence_failed',
        message: 'Failed to update Studio companion meta after save.'
      }
    }

    return { ok: true, artifact: saved }
  }

  async discardDraft(
    input: DiscardProjectStudioDraftInput
  ): Promise<ProjectStudioResult<ProjectStudioCompanionMeta>> {
    if (!safeFlatId(input.projectId) || !safeFlatId(input.draftId)) {
      return { ok: false, code: 'invalid_input', message: 'Project id and draft id are required.' }
    }
    const current = await this.readMeta(input.projectId, input.draftId)
    if (!current || current.projectId !== input.projectId) {
      return { ok: false, code: 'not_found', message: 'Studio draft was not found.' }
    }
    if (current.status === 'discarded') {
      return { ok: true, artifact: current }
    }
    if (current.status === 'saved') {
      return {
        ok: false,
        code: 'invalid_state',
        message: 'Saved Studio library artifacts cannot be discarded from this path.'
      }
    }

    const now = this.deps.now?.() ?? Date.now()
    const discarded: ProjectStudioCompanionMeta = {
      schemaVersion: 1,
      id: current.id,
      projectId: current.projectId,
      kind: current.kind,
      status: 'discarded',
      title: current.title,
      slug: current.slug,
      relativePath: current.relativePath,
      sourceReferenceIds: current.sourceReferenceIds,
      ...(current.chatId ? { chatId: current.chatId } : {}),
      createdAt: current.createdAt,
      updatedAt: now,
      discardedAt: now
    }
    if (!(await this.writeMeta(discarded))) {
      return {
        ok: false,
        code: 'persistence_failed',
        message: 'Failed to persist discarded Studio companion meta.'
      }
    }
    return { ok: true, artifact: discarded }
  }

  async listArtifacts(input: ListProjectStudioArtifactsInput): Promise<ProjectStudioListResult> {
    if (!safeFlatId(input.projectId)) {
      return { ok: false, code: 'invalid_input', message: 'Project id is required.' }
    }
    const dir = this.projectMetaDir(input.projectId)
    if (!dir) {
      return { ok: false, code: 'persistence_failed', message: 'Studio meta directory is unsafe.' }
    }
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return { ok: true, artifacts: [] }
      return { ok: false, code: 'persistence_failed', message: 'Failed to list Studio artifacts.' }
    }

    const artifacts: ProjectStudioCompanionMeta[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.startsWith('.')) continue
      const draftId = entry.slice(0, -'.json'.length)
      const meta = await this.readMeta(input.projectId, draftId)
      if (!meta) continue
      if (!input.includeDiscarded && meta.status === 'discarded') continue
      artifacts.push(meta)
    }
    artifacts.sort((left, right) => right.updatedAt - left.updatedAt)
    return { ok: true, artifacts }
  }
}

import { mkdirSync } from 'fs'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SkillsStore } from '../skills/SkillsStore'
import type {
  EffectiveSkill,
  SkillRecord,
  SkillScope,
  UpsertSkillInput
} from '../../shared/skills/SkillTypes'

export interface SkillsHandlerDeps {
  skillsStore: Pick<
    SkillsStore,
    | 'listUserSkills'
    | 'listWorkspaceSkills'
    | 'resolveEffectiveSkills'
    | 'getLibrarySnapshot'
    | 'upsertUserSkill'
    | 'upsertWorkspaceSkill'
    | 'deleteUserSkill'
    | 'deleteWorkspaceSkill'
    | 'setUserSkillEnabled'
    | 'setWorkspaceSkillEnabled'
    | 'userSkillsRoot'
    | 'workspaceSkillsRoot'
  >
  revealPathInFinder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, label: string, max = 240): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  if (trimmed.length > max) throw new Error(`${label} is too long.`)
  return trimmed
}

function optionalString(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Expected a string.')
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error('String is too long.')
  return trimmed
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error('Expected a boolean.')
  return value
}

function parseScope(value: unknown): SkillScope {
  if (value === 'user' || value === 'workspace') return value
  throw new Error('scope must be "user" or "workspace".')
}

function parseWorkspacePath(value: unknown): string {
  return requireNonEmptyString(value, 'workspacePath', 4096)
}

function assertMainRenderer(deps: SkillsHandlerDeps, event: IpcMainInvokeEvent): void {
  if (!deps.isMainRendererSender(event)) {
    throw new Error('Only the main renderer may manage skills.')
  }
}

function authorizeWorkspace(
  deps: SkillsHandlerDeps,
  event: IpcMainInvokeEvent,
  workspacePath: unknown
): string {
  const raw = parseWorkspacePath(workspacePath)
  const registered = deps.requireRegisteredWorkspace(raw)
  deps.assertSenderScope(event, registered)
  return registered
}

function parseUpsertInput(raw: unknown): UpsertSkillInput & {
  scope: SkillScope
  workspacePath?: string
  workspaceId?: string
} {
  if (!isRecord(raw)) throw new Error('Invalid skills upsert payload.')
  const scope = parseScope(raw.scope)
  const name = requireNonEmptyString(raw.name, 'name', 200)
  const description = optionalString(raw.description, 2000) ?? ''
  const body = typeof raw.body === 'string' ? raw.body : (optionalString(raw.body, 500_000) ?? '')
  const id = optionalString(raw.id, 128)
  const enabled = optionalBoolean(raw.enabled)
  const workspacePath =
    scope === 'workspace'
      ? parseWorkspacePath(raw.workspacePath)
      : optionalString(raw.workspacePath, 4096)
  const workspaceId = optionalString(raw.workspaceId, 200)
  if (scope === 'workspace' && !workspacePath) {
    throw new Error('workspacePath is required for workspace skills.')
  }
  return {
    scope,
    ...(id ? { id } : {}),
    name,
    description,
    body,
    ...(enabled === undefined ? {} : { enabled }),
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceId ? { workspaceId } : {})
  }
}

export function registerSkillsHandlers(deps: SkillsHandlerDeps): void {
  ipcMain.handle('skills:list-effective', (event, payload: unknown): EffectiveSkill[] => {
    assertMainRenderer(deps, event)
    if (!isRecord(payload)) throw new Error('Invalid skills:list-effective payload.')
    const workspacePath = authorizeWorkspace(deps, event, payload.workspacePath)
    const workspaceId = optionalString(payload.workspaceId, 200)
    return deps.skillsStore.resolveEffectiveSkills(workspacePath, workspaceId)
  })

  ipcMain.handle('skills:list-user', (event): SkillRecord[] => {
    assertMainRenderer(deps, event)
    return deps.skillsStore.listUserSkills()
  })

  ipcMain.handle('skills:list-workspace', (event, payload: unknown): SkillRecord[] => {
    assertMainRenderer(deps, event)
    if (!isRecord(payload)) throw new Error('Invalid skills:list-workspace payload.')
    const workspacePath = authorizeWorkspace(deps, event, payload.workspacePath)
    const workspaceId = optionalString(payload.workspaceId, 200)
    return deps.skillsStore.listWorkspaceSkills(workspacePath, workspaceId)
  })

  ipcMain.handle('skills:upsert', (event, payload: unknown): SkillRecord => {
    assertMainRenderer(deps, event)
    const input = parseUpsertInput(payload)
    if (input.scope === 'user') {
      return deps.skillsStore.upsertUserSkill(input)
    }
    const workspacePath = authorizeWorkspace(deps, event, input.workspacePath)
    return deps.skillsStore.upsertWorkspaceSkill(workspacePath, input, input.workspaceId)
  })

  ipcMain.handle('skills:delete', (event, payload: unknown): { ok: true; deleted: boolean } => {
    assertMainRenderer(deps, event)
    if (!isRecord(payload)) throw new Error('Invalid skills:delete payload.')
    const scope = parseScope(payload.scope)
    const id = requireNonEmptyString(payload.id, 'id', 128)
    if (scope === 'user') {
      return { ok: true, deleted: deps.skillsStore.deleteUserSkill(id) }
    }
    const workspacePath = authorizeWorkspace(deps, event, payload.workspacePath)
    return {
      ok: true,
      deleted: deps.skillsStore.deleteWorkspaceSkill(workspacePath, id)
    }
  })

  ipcMain.handle('skills:set-enabled', (event, payload: unknown): SkillRecord => {
    assertMainRenderer(deps, event)
    if (!isRecord(payload)) throw new Error('Invalid skills:set-enabled payload.')
    const scope = parseScope(payload.scope)
    const id = requireNonEmptyString(payload.id, 'id', 128)
    const enabled = optionalBoolean(payload.enabled)
    if (enabled === undefined) throw new Error('enabled is required.')
    if (scope === 'user') {
      return deps.skillsStore.setUserSkillEnabled(id, enabled)
    }
    const workspacePath = authorizeWorkspace(deps, event, payload.workspacePath)
    const workspaceId = optionalString(payload.workspaceId, 200)
    return deps.skillsStore.setWorkspaceSkillEnabled(workspacePath, id, enabled, workspaceId)
  })

  ipcMain.handle(
    'skills:reveal-root',
    async (event, payload: unknown): Promise<{ ok: boolean; error?: string; path?: string }> => {
      assertMainRenderer(deps, event)
      if (!isRecord(payload)) throw new Error('Invalid skills:reveal-root payload.')
      const scope = parseScope(payload.scope)
      let root: string
      if (scope === 'user') {
        root = deps.skillsStore.userSkillsRoot()
      } else {
        const workspacePath = authorizeWorkspace(deps, event, payload.workspacePath)
        root = deps.skillsStore.workspaceSkillsRoot(workspacePath)
      }
      try {
        mkdirSync(root, { recursive: true })
      } catch {
        // Reveal still attempts even if mkdir fails.
      }
      const result = await deps.revealPathInFinder(root)
      return { ...result, path: root }
    }
  )
}

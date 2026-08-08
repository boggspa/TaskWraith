/**
 * Thin IPC facade for Skills / Hooks Settings panes.
 *
 * Preload wiring for `skills:*` / `hooks:*` channels may lag the Settings UI.
 * Callers should treat every method as optional and keep local fallback state.
 *
 * TODO(preload): expose these on `window.api` once main handlers are registered
 * in the renderer bridge (see `src/main/ipc/skillsHandlers.ts` /
 * `src/main/ipc/hooksHandlers.ts`).
 */

import type {
  DeleteHookRequest,
  HookCommand,
  HooksConfigSnapshot,
  SetHookEnabledRequest,
  UpsertHookRequest
} from '../../../shared/hooks/HookTypes'
import type { SkillRecord, SkillScope, UpsertSkillInput } from '../../../shared/skills/SkillTypes'
import {
  normalizeProviderHarnessPostureMap,
  type ProviderHarnessPostureMap
} from '../../../shared/providerHarnessPosture'

export interface SkillsIpcApi {
  listUserSkills?: () => Promise<SkillRecord[]>
  listWorkspaceSkills?: (payload: {
    workspacePath: string
    workspaceId?: string
  }) => Promise<SkillRecord[]>
  upsertSkill?: (
    payload: UpsertSkillInput & {
      scope: SkillScope
      workspacePath?: string
      workspaceId?: string
    }
  ) => Promise<SkillRecord>
  deleteSkill?: (payload: {
    scope: SkillScope
    id: string
    workspacePath?: string
  }) => Promise<{ ok: true; deleted: boolean }>
  setSkillEnabled?: (payload: {
    scope: SkillScope
    id: string
    enabled: boolean
    workspacePath?: string
    workspaceId?: string
  }) => Promise<SkillRecord>
  revealSkillsRoot?: (payload: {
    scope: SkillScope
    workspacePath?: string
  }) => Promise<{ ok: boolean; error?: string; path?: string }>
}

export interface HooksIpcApi {
  getUserHooks?: () => Promise<HooksConfigSnapshot>
  getWorkspaceHooks?: (workspacePath: string) => Promise<HooksConfigSnapshot>
  upsertHook?: (request: UpsertHookRequest) => Promise<HooksConfigSnapshot>
  deleteHook?: (request: DeleteHookRequest) => Promise<HooksConfigSnapshot>
  setHookEnabled?: (request: SetHookEnabledRequest) => Promise<HooksConfigSnapshot>
}

export type SkillsHooksSettingsApi = SkillsIpcApi & HooksIpcApi

type ApiRoot = SkillsHooksSettingsApi & Record<string, unknown>

function readApiRoot(): ApiRoot | undefined {
  if (typeof window === 'undefined') return undefined
  // Prefer the standard preload bridge; tolerate a future alias if present.
  const fromApi = (window as { api?: ApiRoot }).api
  if (fromApi) return fromApi
  const fromTaskwraith = (window as { taskwraith?: ApiRoot }).taskwraith
  return fromTaskwraith
}

export function getSkillsHooksSettingsApi(): SkillsHooksSettingsApi | undefined {
  return readApiRoot()
}

export function skillsIpcReady(api: SkillsIpcApi | undefined): boolean {
  return (
    typeof api?.listUserSkills === 'function' &&
    typeof api?.upsertSkill === 'function' &&
    typeof api?.deleteSkill === 'function' &&
    typeof api?.setSkillEnabled === 'function'
  )
}

export function hooksIpcReady(api: HooksIpcApi | undefined): boolean {
  return (
    typeof api?.getUserHooks === 'function' &&
    typeof api?.upsertHook === 'function' &&
    typeof api?.deleteHook === 'function' &&
    typeof api?.setHookEnabled === 'function'
  )
}

export async function loadAllSkills(
  api: SkillsIpcApi | undefined,
  workspacePath?: string | null,
  workspaceId?: string | null
): Promise<SkillRecord[]> {
  if (!api?.listUserSkills) return []
  const user = await api.listUserSkills()
  if (!workspacePath || !api.listWorkspaceSkills) return user
  const workspace = await api.listWorkspaceSkills({
    workspacePath,
    ...(workspaceId ? { workspaceId } : {})
  })
  return [...user, ...workspace]
}

export async function loadAllHooks(
  api: HooksIpcApi | undefined,
  workspacePath?: string | null
): Promise<HookCommand[]> {
  if (!api?.getUserHooks) return []
  const user = await api.getUserHooks()
  const userHooks = user.hooks ?? []
  if (!workspacePath || !api.getWorkspaceHooks) return userHooks
  const workspace = await api.getWorkspaceHooks(workspacePath)
  return [...userHooks, ...(workspace.hooks ?? [])]
}

/** Merge two hook snapshots by id (workspace entries win on collision). */
export function mergeHookLists(user: HookCommand[], workspace: HookCommand[]): HookCommand[] {
  const byId = new Map<string, HookCommand>()
  for (const hook of user) byId.set(hook.id, hook)
  for (const hook of workspace) byId.set(hook.id, hook)
  return [...byId.values()]
}

/** Read Wave C provider harness posture from app settings (best-effort). */
export async function loadProviderHarnessPosture(): Promise<ProviderHarnessPostureMap> {
  if (typeof window === 'undefined' || typeof window.api?.getSettings !== 'function') {
    return {}
  }
  try {
    const settings = await window.api.getSettings()
    return normalizeProviderHarnessPostureMap(settings?.providerHarnessPosture)
  } catch {
    return {}
  }
}

/** Persist Wave C provider harness posture via app settings (best-effort). */
export async function saveProviderHarnessPosture(
  posture: ProviderHarnessPostureMap
): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === 'undefined' || typeof window.api?.updateSettings !== 'function') {
    return { ok: false, error: 'Settings IPC is unavailable.' }
  }
  try {
    await window.api.updateSettings({
      providerHarnessPosture: normalizeProviderHarnessPostureMap(posture)
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

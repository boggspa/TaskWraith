/**
 * Shared skill-discovery + SessionStart context for prompt composition.
 *
 * Solo ComposerService, Ensemble participant projection, bridge compose, and
 * delegated sub-thread compose all resolve through this helper so SessionStart
 * hooks fire once per workspace (cached) and progressive skill discovery stays
 * consistent. Global / missing workspace paths return empty — no injection.
 */
import {
  runSessionStartHooksForWorkspace,
  type HostHookIntegrationDeps
} from '../hooks/hostHookIntegration'
import type { SkillDiscoveryEntry } from '../skills/SkillPromptInjection'
import { getSkillsHooksSubsystem } from './registerSkillsHooksSubsystem'

export interface RunSkillHookContextSkillsStore {
  resolveEffectiveSkills(
    workspacePath: string,
    workspaceId?: string
  ): ReadonlyArray<{ id: string; name: string; description: string }>
}

export type RunSkillHookHostDepsBuilder = (workspacePath: string) => HostHookIntegrationDeps

export interface ResolveRunSkillHookContextInput {
  workspacePath?: string | null
  workspaceId?: string | null
  /** When true, skip skills + SessionStart even if a path is present. */
  isGlobalRun?: boolean
  allowWorkspaceHooks?: boolean
  /** Test / override seam; defaults to `getSkillsHooksSubsystem()?.skillsStore`. */
  skillsStore?: RunSkillHookContextSkillsStore | null
  /** Test / override seam; defaults to `runSessionStartHooksForWorkspace`. */
  runSessionStart?: (
    workspacePath: string,
    deps: HostHookIntegrationDeps
  ) => Promise<{ sessionStartContext?: string | null }>
  /** Test / override seam; defaults to `getSkillsHooksSubsystem()?.hooksStore`. */
  hooksStore?: HostHookIntegrationDeps['hooksStore'] | null
  /**
   * Optional full HostHookIntegrationDeps builder (ask-before / emitRunEvent).
   * Main registers one via `setRunSkillHookHostDepsBuilder` at subsystem boot.
   */
  buildHostHookDeps?: RunSkillHookHostDepsBuilder | null
}

export interface RunSkillHookContext {
  skillDiscoverySkills?: SkillDiscoveryEntry[]
  sessionStartContext?: string
}

const sessionStartContextByWorkspace = new Map<string, string>()
const sessionStartHooksFired = new Set<string>()
let defaultHostDepsBuilder: RunSkillHookHostDepsBuilder | null = null

export function resetRunSkillHookContextCacheForTests(): void {
  sessionStartContextByWorkspace.clear()
  sessionStartHooksFired.clear()
  defaultHostDepsBuilder = null
}

/** Main registers `buildHostHookCallDeps` so compose paths share ask/emit posture. */
export function setRunSkillHookHostDepsBuilder(builder: RunSkillHookHostDepsBuilder | null): void {
  defaultHostDepsBuilder = builder
}

export function resolveWorkspacePathForSkillHooks(input: {
  workspacePath?: string | null
  isGlobalRun?: boolean
}): string {
  if (input.isGlobalRun) return ''
  return typeof input.workspacePath === 'string' ? input.workspacePath.trim() : ''
}

export function resolveSkillDiscoverySkillsForRun(input: {
  workspacePath?: string | null
  workspaceId?: string | null
  isGlobalRun?: boolean
  skillsStore?: RunSkillHookContextSkillsStore | null
}): SkillDiscoveryEntry[] | undefined {
  const path = resolveWorkspacePathForSkillHooks(input)
  if (!path) return undefined
  const store =
    input.skillsStore === undefined
      ? (getSkillsHooksSubsystem()?.skillsStore ?? null)
      : input.skillsStore
  if (!store) return undefined
  const workspaceId =
    typeof input.workspaceId === 'string' && input.workspaceId.trim()
      ? input.workspaceId.trim()
      : undefined
  const skills = store.resolveEffectiveSkills(path, workspaceId).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description
  }))
  return skills.length > 0 ? skills : undefined
}

export async function resolveSessionStartContextForRun(input: {
  workspacePath?: string | null
  isGlobalRun?: boolean
  allowWorkspaceHooks?: boolean
  hooksStore?: HostHookIntegrationDeps['hooksStore'] | null
  runSessionStart?: ResolveRunSkillHookContextInput['runSessionStart']
  buildHostHookDeps?: RunSkillHookHostDepsBuilder | null
}): Promise<string | undefined> {
  const path = resolveWorkspacePathForSkillHooks(input)
  if (!path) return undefined

  if (sessionStartContextByWorkspace.has(path) || sessionStartHooksFired.has(path)) {
    return sessionStartContextByWorkspace.get(path)
  }

  const runSessionStart = input.runSessionStart ?? runSessionStartHooksForWorkspace
  const buildDeps =
    input.buildHostHookDeps === undefined ? defaultHostDepsBuilder : input.buildHostHookDeps

  let deps: HostHookIntegrationDeps | null = null
  if (buildDeps) {
    deps = buildDeps(path)
  } else {
    const hooksStore =
      input.hooksStore === undefined
        ? (getSkillsHooksSubsystem()?.hooksStore ?? null)
        : input.hooksStore
    if (hooksStore) {
      deps = {
        hooksStore,
        allowWorkspaceHooks: input.allowWorkspaceHooks === true
      }
    } else if (input.runSessionStart) {
      deps = {
        hooksStore: {
          resolveEffectiveHooks: async () => []
        } as unknown as HostHookIntegrationDeps['hooksStore'],
        allowWorkspaceHooks: input.allowWorkspaceHooks === true
      }
    }
  }

  if (!deps) return undefined

  sessionStartHooksFired.add(path)
  try {
    const outcome = await runSessionStart(path, deps)
    const context =
      typeof outcome.sessionStartContext === 'string' && outcome.sessionStartContext.trim()
        ? outcome.sessionStartContext
        : undefined
    if (context) {
      sessionStartContextByWorkspace.set(path, context)
    }
    return context
  } catch (error) {
    console.warn('[hooks] SessionStart failed:', error)
    return sessionStartContextByWorkspace.get(path)
  }
}

/**
 * Resolve progressive skill discovery + SessionStart stdout for a compose turn.
 * Empty when the run is global or has no workspace path.
 */
export async function resolveRunSkillHookContext(
  input: ResolveRunSkillHookContextInput
): Promise<RunSkillHookContext> {
  const path = resolveWorkspacePathForSkillHooks(input)
  if (!path) return {}

  const skillDiscoverySkills = resolveSkillDiscoverySkillsForRun({
    workspacePath: path,
    workspaceId: input.workspaceId,
    isGlobalRun: false,
    skillsStore: input.skillsStore
  })
  const sessionStartContext = await resolveSessionStartContextForRun({
    workspacePath: path,
    isGlobalRun: false,
    allowWorkspaceHooks: input.allowWorkspaceHooks,
    hooksStore: input.hooksStore,
    runSessionStart: input.runSessionStart,
    buildHostHookDeps: input.buildHostHookDeps
  })

  return {
    ...(skillDiscoverySkills ? { skillDiscoverySkills } : {}),
    ...(sessionStartContext ? { sessionStartContext } : {})
  }
}

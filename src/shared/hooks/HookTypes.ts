/** Shared types for TaskWraith host-mediated shell hooks (Wave A1). */

export type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export type HookOnError = 'continue' | 'block'

export type HookScope = 'user' | 'workspace'

export interface HookCommand {
  id: string
  event: HookEvent
  command: string
  matcher?: string
  timeoutMs?: number
  enabled: boolean
  onError?: HookOnError
  scope: HookScope
  workspaceId?: string
}

export interface HooksConfigSnapshot {
  schemaVersion: 1
  hooks: HookCommand[]
}

/** A hook that survived merge + enablement filtering for a workspace. */
export interface EffectiveHookCommand extends HookCommand {
  /** Which config file contributed the winning entry. */
  source: HookScope
}

export interface EffectiveHooksSnapshot {
  schemaVersion: 1
  workspacePath: string
  hooks: EffectiveHookCommand[]
}

export interface UpsertHookRequest {
  scope: HookScope
  hook: HookCommand
  /** Required when scope is `workspace`. */
  workspacePath?: string
}

export interface DeleteHookRequest {
  scope: HookScope
  id: string
  workspacePath?: string
}

export interface SetHookEnabledRequest {
  scope: HookScope
  id: string
  enabled: boolean
  workspacePath?: string
}

export const HOOKS_CONFIG_SCHEMA_VERSION = 1 as const

export const HOOK_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'Stop'
] as const

export const EMPTY_HOOKS_CONFIG: HooksConfigSnapshot = {
  schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION,
  hooks: []
}

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

export function isHookOnError(value: unknown): value is HookOnError {
  return value === 'continue' || value === 'block'
}

export function isHookScope(value: unknown): value is HookScope {
  return value === 'user' || value === 'workspace'
}

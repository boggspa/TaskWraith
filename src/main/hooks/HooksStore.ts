/**
 * Persistence for TaskWraith host-mediated shell hooks.
 *
 * Self-contained (injected userDataPath) so this slice never edits AppStore.
 * User config: `{userDataPath}/hooks.json`
 * Workspace config: `{workspacePath}/.taskwraith/hooks.json`
 *
 * Trust: workspace `.taskwraith/hooks.json` is inside the agent-writable tree.
 * Settings may edit it, but host execution skips workspace-scoped hooks unless
 * a caller passes `allowWorkspaceHooks: true` (v1 defaults to user hooks only).
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  EMPTY_HOOKS_CONFIG,
  HOOKS_CONFIG_SCHEMA_VERSION,
  isHookEvent,
  isHookOnError,
  isHookScope,
  type DeleteHookRequest,
  type EffectiveHookCommand,
  type EffectiveHooksSnapshot,
  type HookCommand,
  type HookScope,
  type HooksConfigSnapshot,
  type SetHookEnabledRequest,
  type UpsertHookRequest
} from '../../shared/hooks/HookTypes'
import { resolveWorkspaceChild } from '../PathScope'

const WORKSPACE_HOOKS_RELATIVE = path.join('.taskwraith', 'hooks.json')
const MAX_HOOKS = 256
const MAX_HOOK_ID_LENGTH = 128
const MAX_HOOK_COMMAND_LENGTH = 8_192
const MAX_HOOK_MATCHER_LENGTH = 512

export interface HooksStoreOptions {
  userDataPath: string
  log?: (line: string) => void
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relation = path.relative(parent, candidate)
  return (
    Boolean(relation) &&
    relation !== '..' &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
  )
}

function resolveUserChildPath(userDataPath: string, ...segments: string[]): string {
  const root = path.resolve(userDataPath)
  const child = path.resolve(root, ...segments)
  if (!isStrictDescendant(root, child)) {
    throw new Error('Hooks path escapes the userData directory.')
  }
  return child
}

function requireAbsoluteWorkspacePath(workspacePath: unknown): string {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw new Error('A workspace path is required.')
  }
  const trimmed = workspacePath.trim()
  if (!path.isAbsolute(trimmed)) {
    throw new Error('Workspace path must be absolute.')
  }
  return path.resolve(trimmed)
}

function resolveWorkspaceHooksPath(workspacePath: string): string {
  const root = requireAbsoluteWorkspacePath(workspacePath)
  return resolveWorkspaceChild(root, WORKSPACE_HOOKS_RELATIVE)
}

function readJson(filePath: string, log: (line: string) => void): unknown {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
  } catch (error) {
    log(`[HooksStore] Failed to read ${filePath}: ${String(error)}`)
    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      }
    } catch (backupError) {
      log(`[HooksStore] Failed to preserve corrupt ${filePath}: ${String(backupError)}`)
    }
    return null
  }
}

function writeJson(filePath: string, data: HooksConfigSnapshot): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
  fs.renameSync(tempPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function normalizeHookCommand(value: unknown, forcedScope: HookScope): HookCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<HookCommand>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!id || id.length > MAX_HOOK_ID_LENGTH) return null
  if (!command || command.length > MAX_HOOK_COMMAND_LENGTH) return null
  if (!isHookEvent(input.event)) return null

  const enabled = input.enabled !== false
  const hook: HookCommand = {
    id,
    event: input.event,
    command,
    enabled,
    scope: forcedScope
  }

  if (typeof input.matcher === 'string') {
    const matcher = input.matcher.trim()
    if (matcher && matcher.length <= MAX_HOOK_MATCHER_LENGTH) {
      hook.matcher = matcher
    }
  }

  if (
    typeof input.timeoutMs === 'number' &&
    Number.isFinite(input.timeoutMs) &&
    input.timeoutMs > 0
  ) {
    hook.timeoutMs = Math.min(Math.floor(input.timeoutMs), 600_000)
  }

  if (isHookOnError(input.onError)) {
    hook.onError = input.onError
  }

  if (forcedScope === 'workspace' && typeof input.workspaceId === 'string') {
    const workspaceId = input.workspaceId.trim()
    if (workspaceId) hook.workspaceId = workspaceId
  }

  return hook
}

function normalizeHooksConfig(value: unknown, forcedScope: HookScope): HooksConfigSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_HOOKS_CONFIG, hooks: [] }
  }
  const input = value as Partial<HooksConfigSnapshot>
  const rawHooks = Array.isArray(input.hooks) ? input.hooks : []
  const hooks: HookCommand[] = []
  const seen = new Set<string>()
  for (const raw of rawHooks.slice(0, MAX_HOOKS)) {
    const hook = normalizeHookCommand(raw, forcedScope)
    if (!hook || seen.has(hook.id)) continue
    seen.add(hook.id)
    hooks.push(hook)
  }
  return {
    schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION,
    hooks
  }
}

function requireHookInput(hook: unknown, scope: HookScope): HookCommand {
  const normalized = normalizeHookCommand(hook, scope)
  if (!normalized) {
    throw new Error('Invalid hook command.')
  }
  if (
    isHookScope((hook as HookCommand | undefined)?.scope) &&
    (hook as HookCommand).scope !== scope
  ) {
    throw new Error(`Hook scope must be '${scope}'.`)
  }
  return normalized
}

export class HooksStore {
  private readonly userHooksPath: string
  private readonly log: (line: string) => void

  constructor(options: HooksStoreOptions) {
    if (typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
      throw new Error('userDataPath is required.')
    }
    if (!path.isAbsolute(options.userDataPath.trim())) {
      throw new Error('userDataPath must be absolute.')
    }
    this.userHooksPath = resolveUserChildPath(options.userDataPath.trim(), 'hooks.json')
    this.log = options.log ?? (() => {})
  }

  /** Absolute PathScope-safe path to `{userData}/hooks.json`. */
  userHooksFilePath(): string {
    return this.userHooksPath
  }

  /** Absolute PathScope-safe path to `{workspace}/.taskwraith/hooks.json`. */
  workspaceHooksFilePath(workspacePath: string): string {
    return resolveWorkspaceHooksPath(workspacePath)
  }

  getUserHooks(): HooksConfigSnapshot {
    return normalizeHooksConfig(readJson(this.userHooksPath, this.log), 'user')
  }

  getWorkspaceHooks(workspacePath: string): HooksConfigSnapshot {
    const filePath = resolveWorkspaceHooksPath(workspacePath)
    return normalizeHooksConfig(readJson(filePath, this.log), 'workspace')
  }

  saveUserHooks(config: HooksConfigSnapshot | unknown): HooksConfigSnapshot {
    const normalized = normalizeHooksConfig(config, 'user')
    writeJson(this.userHooksPath, normalized)
    return normalized
  }

  saveWorkspaceHooks(
    workspacePath: string,
    config: HooksConfigSnapshot | unknown
  ): HooksConfigSnapshot {
    const filePath = resolveWorkspaceHooksPath(workspacePath)
    const normalized = normalizeHooksConfig(config, 'workspace')
    writeJson(filePath, normalized)
    return normalized
  }

  resolveEffectiveHooks(workspacePath: string): EffectiveHooksSnapshot {
    const root = requireAbsoluteWorkspacePath(workspacePath)
    // Validate containment for the workspace hooks file even when missing.
    resolveWorkspaceHooksPath(root)

    const byId = new Map<string, EffectiveHookCommand>()
    for (const hook of this.getUserHooks().hooks) {
      if (!hook.enabled) continue
      byId.set(hook.id, { ...hook, scope: 'user', source: 'user' })
    }
    for (const hook of this.getWorkspaceHooks(root).hooks) {
      if (!hook.enabled) {
        byId.delete(hook.id)
        continue
      }
      byId.set(hook.id, { ...hook, scope: 'workspace', source: 'workspace' })
    }

    return {
      schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION,
      workspacePath: root,
      hooks: Array.from(byId.values())
    }
  }

  upsertHook(request: UpsertHookRequest): HooksConfigSnapshot {
    const scope = request.scope
    if (!isHookScope(scope)) {
      throw new Error('Hook scope must be user or workspace.')
    }
    const hook = requireHookInput(request.hook, scope)
    if (scope === 'user') {
      const current = this.getUserHooks()
      const hooks = current.hooks.filter((entry) => entry.id !== hook.id)
      hooks.push({ ...hook, scope: 'user' })
      return this.saveUserHooks({ schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION, hooks })
    }
    const workspacePath = requireAbsoluteWorkspacePath(request.workspacePath)
    const current = this.getWorkspaceHooks(workspacePath)
    const hooks = current.hooks.filter((entry) => entry.id !== hook.id)
    hooks.push({ ...hook, scope: 'workspace' })
    return this.saveWorkspaceHooks(workspacePath, {
      schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION,
      hooks
    })
  }

  deleteHook(request: DeleteHookRequest): HooksConfigSnapshot {
    const id = typeof request.id === 'string' ? request.id.trim() : ''
    if (!id) throw new Error('Hook id is required.')
    if (!isHookScope(request.scope)) {
      throw new Error('Hook scope must be user or workspace.')
    }
    if (request.scope === 'user') {
      const current = this.getUserHooks()
      return this.saveUserHooks({
        schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION,
        hooks: current.hooks.filter((entry) => entry.id !== id)
      })
    }
    const workspacePath = requireAbsoluteWorkspacePath(request.workspacePath)
    const current = this.getWorkspaceHooks(workspacePath)
    return this.saveWorkspaceHooks(workspacePath, {
      schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION,
      hooks: current.hooks.filter((entry) => entry.id !== id)
    })
  }

  setEnabled(request: SetHookEnabledRequest): HooksConfigSnapshot {
    const id = typeof request.id === 'string' ? request.id.trim() : ''
    if (!id) throw new Error('Hook id is required.')
    if (!isHookScope(request.scope)) {
      throw new Error('Hook scope must be user or workspace.')
    }
    const enabled = request.enabled === true
    if (request.scope === 'user') {
      const current = this.getUserHooks()
      const hooks = current.hooks.map((entry) => (entry.id === id ? { ...entry, enabled } : entry))
      if (!hooks.some((entry) => entry.id === id)) {
        throw new Error(`Unknown user hook: ${id}`)
      }
      return this.saveUserHooks({ schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION, hooks })
    }
    const workspacePath = requireAbsoluteWorkspacePath(request.workspacePath)
    const current = this.getWorkspaceHooks(workspacePath)
    const hooks = current.hooks.map((entry) => (entry.id === id ? { ...entry, enabled } : entry))
    if (!hooks.some((entry) => entry.id === id)) {
      throw new Error(`Unknown workspace hook: ${id}`)
    }
    return this.saveWorkspaceHooks(workspacePath, {
      schemaVersion: HOOKS_CONFIG_SCHEMA_VERSION,
      hooks
    })
  }
}

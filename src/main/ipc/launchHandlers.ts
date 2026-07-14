import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { discoverLaunchTargets } from '../launchTargets/discovery'
import type { LocalServerEntry } from '../localServers/types'
import type { ProviderId } from '../store/types'
import type { LaunchManager } from '../launch/LaunchManager'
import type { LaunchAttempt } from '../launch/types'

const PROVIDERS = new Set<ProviderId>(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
const ACTIVE_ATTEMPT_STATUSES = new Set<LaunchAttempt['status']>([
  'starting',
  'running',
  'stopping'
])
const LAUNCH_SCOPE_ERROR = 'Launch data is unavailable to this renderer.'

export type LaunchSenderScope =
  | { kind: 'main' }
  | {
      kind: 'chat'
      chatId: string
      workspacePath: string
      workspaceId?: string
    }

export interface LaunchHandlerDeps {
  launchManager: LaunchManager
  resolveSenderLaunchScope: (event: IpcMainInvokeEvent) => LaunchSenderScope
  workspacePathsEqual: (left: string, right: string) => boolean
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  findWorkspaceId: (workspacePath: string) => string | undefined
  localServersSnapshot: () => { servers: LocalServerEntry[] }
  platform: NodeJS.Platform
}

function launchAttemptMatchesScope(
  scope: LaunchSenderScope,
  attempt: LaunchAttempt,
  workspacePathsEqual: LaunchHandlerDeps['workspacePathsEqual']
): boolean {
  if (scope.kind === 'main') return true
  if (attempt.chatId !== scope.chatId) return false
  if (!workspacePathsEqual(attempt.workspacePath, scope.workspacePath)) return false
  if (attempt.workspaceId && scope.workspaceId && attempt.workspaceId !== scope.workspaceId) {
    return false
  }
  return true
}

function assertLaunchAttemptScope(
  scope: LaunchSenderScope,
  attempt: LaunchAttempt | null | undefined,
  workspacePathsEqual: LaunchHandlerDeps['workspacePathsEqual']
): asserts attempt is LaunchAttempt {
  if (!attempt || !launchAttemptMatchesScope(scope, attempt, workspacePathsEqual)) {
    throw new Error(LAUNCH_SCOPE_ERROR)
  }
}

function assertLaunchWorkspaceScope(
  scope: LaunchSenderScope,
  workspacePath: string,
  workspacePathsEqual: LaunchHandlerDeps['workspacePathsEqual']
): void {
  if (scope.kind === 'chat' && !workspacePathsEqual(workspacePath, scope.workspacePath)) {
    throw new Error(LAUNCH_SCOPE_ERROR)
  }
}

export function registerLaunchHandlers(deps: LaunchHandlerDeps): void {
  ipcMain.handle('launch-attempts-snapshot', (event) => {
    const scope = deps.resolveSenderLaunchScope(event)
    const snapshot = deps.launchManager.snapshot()
    if (scope.kind === 'main') return snapshot
    return {
      ...snapshot,
      attempts: snapshot.attempts.filter((attempt) =>
        launchAttemptMatchesScope(scope, attempt, deps.workspacePathsEqual)
      )
    }
  })

  ipcMain.handle('launch-targets-snapshot', (event, workspacePath) => {
    const scope = deps.resolveSenderLaunchScope(event)
    if (typeof workspacePath !== 'string') {
      throw new Error('Workspace path is required.')
    }
    const registeredWorkspacePath = deps.requireRegisteredWorkspace(workspacePath, 'Workspace')
    assertLaunchWorkspaceScope(scope, registeredWorkspacePath, deps.workspacePathsEqual)
    return discoverLaunchTargets({
      workspacePath: registeredWorkspacePath,
      workspaceId: deps.findWorkspaceId(registeredWorkspacePath),
      localServers: deps.localServersSnapshot().servers,
      platform: deps.platform
    })
  })

  ipcMain.handle('launch-start', async (event, input: unknown) => {
    const scope = deps.resolveSenderLaunchScope(event)
    const parsed = parseLaunchStartInput(input)
    const workspacePath = deps.requireRegisteredWorkspace(parsed.workspacePath, 'Workspace')
    assertLaunchWorkspaceScope(scope, workspacePath, deps.workspacePathsEqual)
    if (scope.kind === 'chat' && parsed.chatId && parsed.chatId !== scope.chatId) {
      throw new Error(LAUNCH_SCOPE_ERROR)
    }
    const snapshot = await discoverLaunchTargets({
      workspacePath,
      workspaceId: deps.findWorkspaceId(workspacePath),
      localServers: deps.localServersSnapshot().servers,
      platform: deps.platform
    })
    const target = snapshot.targets.find((item) => item.id === parsed.targetId)
    if (!target) return { ok: false, error: 'Launch target was not found.' }
    assertLaunchWorkspaceScope(scope, target.workspacePath, deps.workspacePathsEqual)
    if (scope.kind === 'chat') {
      const activeAttempt = deps.launchManager
        .snapshot()
        .attempts.find(
          (attempt) =>
            attempt.targetId === target.id &&
            deps.workspacePathsEqual(attempt.workspacePath, target.workspacePath) &&
            ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
        )
      if (activeAttempt) {
        assertLaunchAttemptScope(scope, activeAttempt, deps.workspacePathsEqual)
      }
    }
    const result = await deps.launchManager.startTarget({
      sender: event.sender,
      provider: parsed.provider,
      target,
      chatId: scope.kind === 'chat' ? scope.chatId : parsed.chatId,
      runId: parsed.runId
    })
    if (scope.kind === 'chat' && result.attempt) {
      assertLaunchAttemptScope(scope, result.attempt, deps.workspacePathsEqual)
    }
    return result
  })

  ipcMain.handle('launch-stop', async (event, input: unknown) => {
    const scope = deps.resolveSenderLaunchScope(event)
    const parsed = parseLaunchStopInput(input)
    if (scope.kind === 'chat') {
      const attempt = deps.launchManager
        .snapshot()
        .attempts.find((candidate) => candidate.id === parsed.attemptId)
      assertLaunchAttemptScope(scope, attempt, deps.workspacePathsEqual)
    }
    const result = await deps.launchManager.stopAttempt(parsed.attemptId)
    if (scope.kind === 'chat' && result.attempt) {
      assertLaunchAttemptScope(scope, result.attempt, deps.workspacePathsEqual)
    }
    return result
  })
}

export function parseLaunchStartInput(input: unknown): {
  workspacePath: string
  targetId: string
  provider: ProviderId
  chatId?: string
  runId?: string
} {
  if (!input || typeof input !== 'object') throw new Error('launch-start input is required.')
  const value = input as Record<string, unknown>
  const workspacePath = requiredString(value.workspacePath, 'workspacePath')
  const targetId = requiredString(value.targetId, 'targetId')
  const provider = requiredProvider(value.provider)
  return {
    workspacePath,
    targetId,
    provider,
    chatId: optionalString(value.chatId),
    runId: optionalString(value.runId)
  }
}

export function parseLaunchStopInput(input: unknown): { attemptId: string } {
  if (!input || typeof input !== 'object') throw new Error('launch-stop input is required.')
  return {
    attemptId: requiredString((input as Record<string, unknown>).attemptId, 'attemptId')
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function requiredProvider(value: unknown): ProviderId {
  const provider = requiredString(value, 'provider') as ProviderId
  if (!PROVIDERS.has(provider)) throw new Error('provider is invalid.')
  return provider
}

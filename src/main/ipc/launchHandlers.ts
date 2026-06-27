import { ipcMain } from 'electron'
import { discoverLaunchTargets } from '../launchTargets/discovery'
import type { LocalServerEntry } from '../localServers/types'
import type { ProviderId } from '../store/types'
import type { LaunchManager } from '../launch/LaunchManager'

const PROVIDERS = new Set<ProviderId>(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])

export interface LaunchHandlerDeps {
  launchManager: LaunchManager
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  findWorkspaceId: (workspacePath: string) => string | undefined
  localServersSnapshot: () => { servers: LocalServerEntry[] }
  platform: NodeJS.Platform
}

export function registerLaunchHandlers(deps: LaunchHandlerDeps): void {
  ipcMain.handle('launch-attempts-snapshot', () => deps.launchManager.snapshot())

  ipcMain.handle('launch-targets-snapshot', (_event, workspacePath) => {
    if (typeof workspacePath !== 'string') {
      throw new Error('Workspace path is required.')
    }
    const registeredWorkspacePath = deps.requireRegisteredWorkspace(workspacePath, 'Workspace')
    return discoverLaunchTargets({
      workspacePath: registeredWorkspacePath,
      workspaceId: deps.findWorkspaceId(registeredWorkspacePath),
      localServers: deps.localServersSnapshot().servers,
      platform: deps.platform
    })
  })

  ipcMain.handle('launch-start', async (event, input: unknown) => {
    const parsed = parseLaunchStartInput(input)
    const workspacePath = deps.requireRegisteredWorkspace(parsed.workspacePath, 'Workspace')
    const snapshot = await discoverLaunchTargets({
      workspacePath,
      workspaceId: deps.findWorkspaceId(workspacePath),
      localServers: deps.localServersSnapshot().servers,
      platform: deps.platform
    })
    const target = snapshot.targets.find((item) => item.id === parsed.targetId)
    if (!target) return { ok: false, error: 'Launch target was not found.' }
    return deps.launchManager.startTarget({
      sender: event.sender,
      provider: parsed.provider,
      target,
      chatId: parsed.chatId,
      runId: parsed.runId
    })
  })

  ipcMain.handle('launch-stop', (_event, input: unknown) => {
    const parsed = parseLaunchStopInput(input)
    return deps.launchManager.stopAttempt(parsed.attemptId)
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

import { join } from 'path'
import * as fsSync from 'fs'

export interface GrokMcpSweepResult {
  mcpDir: string | null
  removed: string[]
}

export function grokProjectNameForWorkspace(workspacePath: string): string {
  return workspacePath
    .trim()
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, '-')
}

export function grokProjectMcpDirForWorkspace(
  homeDir: string,
  workspacePath: string
): string | null {
  const projectName = grokProjectNameForWorkspace(workspacePath)
  if (!projectName) return null
  return join(homeDir, '.grok', 'projects', projectName, 'mcps')
}

export function isReservedGrokTaskWraithMcpServerName(serverName: string): boolean {
  const normalized = serverName.trim().toLowerCase()
  if (!normalized) return false
  return (
    normalized === 'taskwraith' ||
    normalized.startsWith('taskwraith-') ||
    normalized === 'agbench' ||
    normalized.startsWith('agbench-')
  )
}

export function sweepGrokProjectTaskWraithMcpRegistrations(
  homeDir: string,
  workspacePath: string
): GrokMcpSweepResult {
  const mcpDir = grokProjectMcpDirForWorkspace(homeDir, workspacePath)
  if (!mcpDir || !fsSync.existsSync(mcpDir)) return { mcpDir, removed: [] }
  const removed: string[] = []
  for (const entry of fsSync.readdirSync(mcpDir)) {
    if (!isReservedGrokTaskWraithMcpServerName(entry)) continue
    const entryPath = join(mcpDir, entry)
    fsSync.rmSync(entryPath, { recursive: true, force: true })
    removed.push(entry)
  }
  return { mcpDir, removed }
}

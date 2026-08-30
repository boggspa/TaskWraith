import { findExecutableOnHost } from '../HostToolResolver'
import type { ProviderId } from '../store/types'
import {
  getTerminalCliCommand,
  isTerminalCliId,
  type TerminalCliId
} from '../../shared/terminalCli'

const PROVIDER_BY_TERMINAL_CLI: Partial<Record<TerminalCliId, ProviderId>> = {
  codex: 'codex',
  claude: 'claude',
  kimi: 'kimi',
  cursor: 'cursor',
  grok: 'grok',
  ollama: 'ollama',
  pi: 'pi',
  muse: 'muse'
}

export interface ResolvedInteractiveTerminalCli {
  cliId: TerminalCliId
  command: string
  binaryPath: string
  launchCommand: string
}

export interface InteractiveTerminalCliResolverDependencies {
  resolveProviderBinary?: (
    provider: ProviderId
  ) => Promise<{ binaryPath: string | null | undefined; error?: string }>
  findExecutable?: (command: string) => string | null
  platform?: NodeJS.Platform
}

async function resolveProviderBinary(provider: ProviderId): Promise<{
  binaryPath: string | null | undefined
  error?: string
}> {
  // Keep this module Electron-free for unit tests and early main-process
  // imports. The provider runtime imports AppStore, which requires Electron's
  // userData path; the terminal is only resolved after the app is ready.
  const runtime = await import('../providers/CliProviderRuntime')
  return runtime.resolveCliProviderBinary(provider)
}

/** Quote an executable path for the shell used by TerminalSessionManager. */
export function buildInteractiveTerminalLaunchCommand(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    // TerminalSessionManager uses PowerShell on Windows, where an absolute
    // path needs the call operator to execute rather than merely expand.
    return `& '${binaryPath.replace(/'/g, "''")}'`
  }
  return `'${binaryPath.replace(/'/g, "'\\''")}'`
}

/**
 * Resolve a picker id in MAIN. Renderer input is only an id; it never chooses
 * an executable path or writes an unverified command into the PTY.
 */
export async function resolveInteractiveTerminalCli(
  cliId: string,
  deps: InteractiveTerminalCliResolverDependencies = {}
): Promise<ResolvedInteractiveTerminalCli> {
  if (!isTerminalCliId(cliId) || cliId === 'default') {
    throw new Error('The selected terminal CLI is unavailable.')
  }

  const command = getTerminalCliCommand(cliId)
  if (!command) throw new Error(`No interactive command is registered for ${cliId}.`)

  const provider = PROVIDER_BY_TERMINAL_CLI[cliId]
  let binaryPath: string | null | undefined
  if (provider) {
    const resolved = await (deps.resolveProviderBinary ?? resolveProviderBinary)(provider)
    binaryPath = resolved.binaryPath
    if (!binaryPath) {
      throw new Error(
        resolved.error || `${cliId} CLI was not found on PATH or common local install locations.`
      )
    }
  } else {
    binaryPath = (deps.findExecutable ?? findExecutableOnHost)(command)
    if (!binaryPath) {
      const label = cliId === 'mistral' ? 'Mistral Vibe' : cliId
      throw new Error(
        `${label} CLI (${command}) was not found on PATH or common local install locations.`
      )
    }
  }

  return {
    cliId,
    command,
    binaryPath,
    launchCommand: buildInteractiveTerminalLaunchCommand(binaryPath, deps.platform)
  }
}

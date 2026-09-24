import { join } from 'path'
import { ipcMain } from 'electron'
import {
  hostCliTool,
  hostCliToolInstallCommand,
  hostCliToolManualInstallMessage,
  isHostCliToolId,
  type HostCliToolId
} from '../../shared/hostCliToolCatalog'
import {
  cliUpgradeCommand,
  detectCliInstallChannel,
  unknownInstallChannelMessage
} from '../providers/CliInstallChannel'

/**
 * Terminal install/upgrade for OPTIONAL HOST CLIs — today only `gh`.
 *
 * WHY THIS IS A SEPARATE LANE FROM providerTerminalHandlers
 * --------------------------------------------------------
 * The provider lane is typed on `ProviderId` end to end: its IPC arg spec
 * asserts a provider id, and the id set is a load-bearing choke-point where a
 * member without a runtime adapter fails at module scope. `gh` is not a
 * provider — it has no seat, model, posture, or run lane — so widening
 * ProviderId to carry it would trade a small amount of duplication for a real
 * risk in the highest-consequence enum in the app. This lane reuses the same
 * script-writing shape and the same channel-aware upgrade policy, over its own
 * bounded id set.
 *
 * Policy inherited from CliInstallChannel: we upgrade the copy we actually
 * RESOLVE, or we refuse. Running `brew upgrade gh` against an install that came
 * from somewhere else reports success while the binary TaskWraith executes never
 * moves — worse than declining, because the user stops looking for the problem.
 */

export type HostToolTerminalAction = 'install' | 'upgrade'

export interface HostToolTerminalResult {
  ok: boolean
  error?: string
  /** The command that was written to the script, for display/telemetry. */
  command?: string
  /** Whether the tool was already present (⇒ this was an upgrade). */
  alreadyInstalled?: boolean
}

export interface HostToolTerminalHandlersDeps {
  /** Absolute path to the resolved binary, or null when absent. */
  resolveHostToolPath: (binaryName: string) => string | null
  getUserDataPath: () => string
  openPath: (path: string) => Promise<string>
  mkdirSync: (path: string, options: { recursive: boolean; mode?: number }) => void
  writeFileSync: (path: string, data: string, options?: { mode?: number }) => void
  chmodSync: (path: string, mode: number) => void
  getPlatform: () => NodeJS.Platform
  /** Best-effort realpath so the install channel is visible past a symlink. */
  realpathSync?: (path: string) => string
  /** Drop cached presence so the next probe sees a freshly installed binary. */
  invalidateHostToolCache?: () => void
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveRealPath(deps: HostToolTerminalHandlersDeps, binaryPath: string): string {
  if (!deps.realpathSync) return binaryPath
  try {
    return deps.realpathSync(binaryPath)
  } catch {
    return binaryPath
  }
}

/**
 * Decide the command for this machine's actual state.
 *
 * Installed ⇒ upgrade through whatever owns the resolved copy. Absent ⇒ the
 * vetted per-platform install command, or an honest refusal when we have none
 * for this platform.
 */
export function hostToolTerminalCommand(
  deps: HostToolTerminalHandlersDeps,
  id: HostCliToolId
): { command: string; alreadyInstalled: boolean } | { error: string; alreadyInstalled: boolean } {
  const entry = hostCliTool(id)
  if (!entry) return { error: `Unknown host tool: ${String(id)}`, alreadyInstalled: false }
  const platform = deps.getPlatform()
  const resolved = deps.resolveHostToolPath(entry.binaryName)

  if (resolved) {
    const realPath = resolveRealPath(deps, resolved)
    const channel = detectCliInstallChannel(realPath)
    const upgrade = cliUpgradeCommand({
      channel,
      // `gh` has no npm distribution; npmPackage is required by the shared
      // input shape, and the npm branch is unreachable for a binary that never
      // resolves under node_modules.
      npmPackage: entry.binaryName,
      brewToken: entry.brewToken
    })
    if (!upgrade) {
      return {
        error: unknownInstallChannelMessage(entry.label, realPath || resolved),
        alreadyInstalled: true
      }
    }
    return { command: upgrade.map(shQuote).join(' '), alreadyInstalled: true }
  }

  const install = hostCliToolInstallCommand(id, platform)
  if (!install) return { error: hostCliToolManualInstallMessage(id), alreadyInstalled: false }
  return { command: install.command, alreadyInstalled: false }
}

async function openHostToolTerminal(
  deps: HostToolTerminalHandlersDeps,
  rawId: unknown
): Promise<HostToolTerminalResult> {
  try {
    if (!isHostCliToolId(rawId)) {
      return { ok: false, error: `No TaskWraith-managed setup for ${String(rawId)}.` }
    }
    const entry = hostCliTool(rawId)!
    const decision = hostToolTerminalCommand(deps, rawId)
    if ('error' in decision) {
      return { ok: false, error: decision.error, alreadyInstalled: decision.alreadyInstalled }
    }
    const { command, alreadyInstalled } = decision
    const action: HostToolTerminalAction = alreadyInstalled ? 'upgrade' : 'install'
    const actionVerb = alreadyInstalled ? 'Upgrading' : 'Installing'
    const actionLabel = alreadyInstalled ? 'Upgrade' : 'Install'
    const platform = deps.getPlatform()
    const dir = join(deps.getUserDataPath(), 'login')
    deps.mkdirSync(dir, { recursive: true })

    if (platform === 'win32') {
      const psFile = join(dir, `hosttool-${rawId}-${action}.ps1`)
      const cmdFile = join(dir, `hosttool-${rawId}-${action}.cmd`)
      const psScript =
        [
          `# Generated by TaskWraith - ${action} ${entry.label}.`,
          '$ErrorActionPreference = "Continue"',
          `Write-Host "${actionVerb} ${entry.label} for TaskWraith..."`,
          `Write-Host "> ${command.replace(/"/g, '`"')}"`,
          'Write-Host ""',
          command,
          '$status = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }',
          'Write-Host ""',
          `Write-Host "${actionLabel} finished (exit $status). Close this window and return to TaskWraith."`
        ].join('\r\n') + '\r\n'
      deps.writeFileSync(psFile, psScript)
      deps.writeFileSync(
        cmdFile,
        `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0${`hosttool-${rawId}-${action}.ps1`}"\r\n`
      )
      const err = await deps.openPath(cmdFile)
      if (err) return { ok: false, error: err, alreadyInstalled }
      deps.invalidateHostToolCache?.()
      return { ok: true, command, alreadyInstalled }
    }

    const script =
      [
        '#!/bin/zsh',
        `# Generated by TaskWraith — ${action} ${entry.label}.`,
        // Source the user's shell profile: the whole point is that the app's
        // launchd environment is narrower than their shell's, and `brew` itself
        // is frequently only on the shell PATH.
        '[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null',
        '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null',
        `echo "${actionVerb} ${entry.label} for TaskWraith…"`,
        `echo "> ${command}"`,
        'echo ""',
        command,
        // zsh treats `status` as a read-only alias of `$?`; assigning to it
        // aborts the script, so the POSIX branch captures into `exit_code`.
        'exit_code=$?',
        'echo ""',
        `echo "${actionLabel} finished (exit $exit_code). Close this window and return to TaskWraith."`
      ].join('\n') + '\n'
    const file = join(dir, `hosttool-${rawId}-${action}.command`)
    deps.writeFileSync(file, script, { mode: 0o755 })
    deps.chmodSync(file, 0o755)
    const err = await deps.openPath(file)
    if (err) return { ok: false, error: err, alreadyInstalled }
    // The terminal runs detached, so success here means "opened", not
    // "installed". Dropping the cache now means the next presence probe — which
    // happens when the user returns to the popover — sees the new binary
    // instead of the stale miss.
    deps.invalidateHostToolCache?.()
    return { ok: true, command, alreadyInstalled }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const HOST_TOOL_INSTALL_TERMINAL_CHANNEL = 'host-tool:open-install-terminal'
export const HOST_TOOL_STATUS_CHANNEL = 'host-tool:status'

export interface HostToolStatus {
  id: HostCliToolId
  available: boolean
  path?: string
}

export function registerHostToolTerminalHandlers(deps: HostToolTerminalHandlersDeps): void {
  ipcMain.handle(HOST_TOOL_INSTALL_TERMINAL_CHANNEL, async (_e, id: unknown) =>
    openHostToolTerminal(deps, id)
  )
  ipcMain.handle(HOST_TOOL_STATUS_CHANNEL, async (_e, id: unknown): Promise<HostToolStatus> => {
    if (!isHostCliToolId(id)) {
      throw new Error(`Unknown host tool: ${String(id)}`)
    }
    const entry = hostCliTool(id)!
    const resolved = deps.resolveHostToolPath(entry.binaryName)
    return resolved ? { id, available: true, path: resolved } : { id, available: false }
  })
}

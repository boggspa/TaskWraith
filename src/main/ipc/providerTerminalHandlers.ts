import { join, basename } from 'path'
import { ipcMain } from 'electron'
import type { ProviderId } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import { cursorManagedRunAdmission } from '../cursor/CursorManagedRunGate'

type TerminalAction = 'login' | 'logout' | 'upgrade'

export type ProviderTerminalResult = {
  ok: boolean
  error?: string
  /**
   * Kimi login/upgrade terminals are explicit user-owned setup handoffs. They
   * are not TaskWraith-managed provider turns and do not qualify a binary for
   * a later managed run.
   */
  scope?: 'user-owned-provider-setup'
  managedRunReady?: false
  notice?: string
}

const KIMI_USER_OWNED_SETUP_NOTICE =
  'This is a user-owned Kimi setup command outside TaskWraith managed-run containment. Success does not qualify this runtime for managed Kimi turns or compaction.'

export interface ProviderTerminalHandlersDeps {
  resolveCliProviderBinary: (provider: ProviderId) => Promise<ResolvedProviderBinary>
  getUserDataPath: () => string
  openPath: (path: string) => Promise<string>
  mkdirSync: (path: string, options: { recursive: boolean }) => void
  writeFileSync: (path: string, data: string, options?: { mode?: number }) => void
  chmodSync: (path: string, mode: number) => void
  getPlatform: () => NodeJS.Platform
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function openProviderAuthTerminal(
  deps: ProviderTerminalHandlersDeps,
  provider: ProviderId,
  action: TerminalAction
): Promise<ProviderTerminalResult> {
  try {
    // Cursor auth/upgrade commands still initialize provider-managed startup
    // surfaces. Keep the no-process invariant broader than ordinary runs: do
    // not resolve a binary, write a launcher, or open a terminal for Cursor.
    if (provider === 'cursor') {
      return { ok: false, error: cursorManagedRunAdmission().message }
    }
    let commandParts: string[] | null = null
    let rawCommand: string | null = null
    let label: string
    let setupNotice: string | null = null
    const actionLabel =
      action === 'login' ? 'Sign-in' : action === 'logout' ? 'Sign-out' : 'Upgrade'
    const actionVerb =
      action === 'login' ? 'Signing in to' : action === 'logout' ? 'Signing out of' : 'Upgrading'
    let postscript = `${actionLabel} finished (exit $status). Close this window and return to TaskWraith.`

    if (provider === 'codex') {
      label = 'Codex'
      const resolved = await deps.resolveCliProviderBinary('codex')
      commandParts =
        action === 'upgrade'
          ? ['npm', 'install', '-g', '@openai/codex@latest']
          : [resolved.binaryPath || 'codex', action]
    } else if (provider === 'gemini') {
      if (action !== 'upgrade') {
        return { ok: false, error: `Gemini terminal ${action} is not supported here.` }
      }
      label = 'Gemini'
      commandParts = ['npm', 'install', '-g', '@google/gemini-cli@latest']
    } else if (provider === 'claude') {
      label = 'Claude'
      const resolved = await deps.resolveCliProviderBinary('claude')
      if (action === 'upgrade') {
        if (resolved.binaryPath) {
          commandParts = [resolved.binaryPath, 'update']
        } else {
          rawCommand = 'curl -fsSL https://claude.ai/install.sh | bash'
        }
      } else {
        commandParts = [resolved.binaryPath || 'claude', 'auth', action]
      }
    } else if (provider === 'kimi') {
      label = 'Kimi'
      if (action === 'logout') {
        // Never replace a missing logout verb with a bare interactive Kimi
        // session. That would be an unadmitted provider process with a much
        // broader surface than the explicit account action the user asked for.
        return {
          ok: false,
          error:
            'Kimi Code does not expose a bounded logout command. No Kimi process was started; remove Kimi credentials using the documented account controls instead.',
          scope: 'user-owned-provider-setup',
          managedRunReady: false,
          notice: KIMI_USER_OWNED_SETUP_NOTICE
        }
      }
      const resolved = await deps.resolveCliProviderBinary('kimi')
      setupNotice = KIMI_USER_OWNED_SETUP_NOTICE
      if (action === 'upgrade') {
        // Kimi Code's subcommand is `upgrade` — the legacy `/upgrade` slash-arg
        // is gone and errors on a kimi-code binary.
        if (resolved.binaryPath) {
          commandParts = [resolved.binaryPath, 'upgrade']
        } else {
          rawCommand = 'curl -LsSf https://code.kimi.com/install.sh | bash'
        }
      } else {
        // login → `kimi login` (device-code flow).
        commandParts = [resolved.binaryPath || 'kimi', 'login']
      }
    } else if (provider === 'grok') {
      label = 'Grok'
      const resolved = await deps.resolveCliProviderBinary('grok')
      commandParts = action === 'upgrade' ? null : [resolved.binaryPath || 'grok']
      if (action === 'upgrade') {
        rawCommand = 'curl -fsSL https://x.ai/cli/install.sh | bash'
      }
      if (action === 'logout') {
        postscript =
          'Grok CLI does not expose a logout subcommand yet. Use the opened Grok session to manage account state, then close this window.'
      }
    } else if (provider === 'ollama') {
      label = 'Ollama'
      const resolved = await deps.resolveCliProviderBinary('ollama')
      if (action === 'upgrade') {
        rawCommand = 'curl -fsSL https://ollama.com/install.sh | sh'
      } else {
        commandParts = [
          resolved.binaryPath || 'ollama',
          action === 'logout' ? 'signout' : 'signin'
        ]
      }
    } else {
      return { ok: false, error: `No terminal ${action} for ${provider}.` }
    }

    if (!rawCommand && !commandParts) {
      return { ok: false, error: `No terminal ${action} command for ${provider}.` }
    }

    const platform = deps.getPlatform()
    const command = rawCommand
      ? rawCommand
      : platform === 'win32'
        ? commandParts!.map(psQuote).join(' ')
        : commandParts!.map(shQuote).join(' ')

    const dir = join(deps.getUserDataPath(), 'login')
    deps.mkdirSync(dir, { recursive: true })

    if (platform === 'win32') {
      const psFile = join(dir, `${provider}-${action}.ps1`)
      const cmdFile = join(dir, `${provider}-${action}.cmd`)
      const psScript =
        [
          `# Generated by TaskWraith - interactive provider ${action}.`,
          '$ErrorActionPreference = "Continue"',
          ...(setupNotice
            ? [`Write-Host "${setupNotice.replace(/"/g, '`"')}"`, 'Write-Host ""']
            : []),
          `Write-Host "${actionVerb} ${label} for TaskWraith..."`,
          `Write-Host "> ${command.replace(/"/g, '`"')}"`,
          'Write-Host ""',
          `& ${command}`,
          '$status = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }',
          'Write-Host ""',
          `Write-Host "${postscript.replace(/"/g, '`"').replace('$status', '$status')}"`
        ].join('\r\n') + '\r\n'
      deps.writeFileSync(psFile, psScript)
      deps.writeFileSync(
        cmdFile,
        `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0${basename(psFile)}"\r\n`
      )
      const err = await deps.openPath(cmdFile)
      if (err) {
        return setupNotice
          ? {
              ok: false,
              error: err,
              scope: 'user-owned-provider-setup',
              managedRunReady: false,
              notice: setupNotice
            }
          : { ok: false, error: err }
      }
      return setupNotice
        ? {
            ok: true,
            scope: 'user-owned-provider-setup',
            managedRunReady: false,
            notice: setupNotice
          }
        : { ok: true }
    }

    const script =
      [
        '#!/bin/zsh',
        `# Generated by TaskWraith — interactive provider ${action}.`,
        '[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null',
        '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null',
        ...(setupNotice ? [`echo "${setupNotice}"`, 'echo ""'] : []),
        `echo "${actionVerb} ${label} for TaskWraith…"`,
        `echo "> ${command}"`,
        'echo ""',
        command,
        'status=$?',
        'echo ""',
        `echo "${postscript}"`
      ].join('\n') + '\n'
    const file = join(dir, `${provider}-${action}.command`)
    deps.writeFileSync(file, script, { mode: 0o755 })
    deps.chmodSync(file, 0o755)
    const err = await deps.openPath(file)
    if (err) {
      return setupNotice
        ? {
            ok: false,
            error: err,
            scope: 'user-owned-provider-setup',
            managedRunReady: false,
            notice: setupNotice
          }
        : { ok: false, error: err }
    }
    return setupNotice
      ? {
          ok: true,
          scope: 'user-owned-provider-setup',
          managedRunReady: false,
          notice: setupNotice
        }
      : { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerProviderTerminalHandlers(deps: ProviderTerminalHandlersDeps): void {
  ipcMain.handle('provider:open-login-terminal', async (_e, provider: ProviderId) =>
    openProviderAuthTerminal(deps, provider, 'login')
  )
  ipcMain.handle('provider:open-logout-terminal', async (_e, provider: ProviderId) =>
    openProviderAuthTerminal(deps, provider, 'logout')
  )
  ipcMain.handle('provider:open-upgrade-terminal', async (_e, provider: ProviderId) =>
    openProviderAuthTerminal(deps, provider, 'upgrade')
  )
  ipcMain.handle('provider:open-kimi-upgrade-terminal', async () =>
    openProviderAuthTerminal(deps, 'kimi', 'upgrade')
  )
}

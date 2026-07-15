import { join, basename } from 'path'
import { ipcMain } from 'electron'
import type { ProviderId } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'

type TerminalAction = 'login' | 'logout' | 'upgrade'

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
): Promise<{ ok: boolean; error?: string }> {
  try {
    let commandParts: string[] | null = null
    let rawCommand: string | null = null
    let label: string
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
      const resolved = await deps.resolveCliProviderBinary('kimi')
      if (action === 'upgrade') {
        // Kimi Code's subcommand is `upgrade` — the legacy `/upgrade` slash-arg
        // is gone and errors on a kimi-code binary.
        if (resolved.binaryPath) {
          commandParts = [resolved.binaryPath, 'upgrade']
        } else {
          rawCommand = 'curl -LsSf https://code.kimi.com/install.sh | bash'
        }
      } else if (action === 'logout') {
        // Kimi Code has no `logout` subcommand (running it errors); open a Kimi
        // session so the user can manage account state instead.
        commandParts = [resolved.binaryPath || 'kimi']
        postscript =
          'Kimi Code does not expose a logout subcommand. Manage your account in the opened Kimi session, then close this window.'
      } else {
        // login → `kimi login` (device-code flow).
        commandParts = [resolved.binaryPath || 'kimi', 'login']
      }
    } else if (provider === 'cursor') {
      label = 'Cursor'
      const resolved = await deps.resolveCliProviderBinary('cursor')
      if (action === 'upgrade') {
        rawCommand = 'curl https://cursor.com/install -fsS | bash'
      } else {
        commandParts = [resolved.binaryPath || 'cursor-agent', action]
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
      if (err) return { ok: false, error: err }
      return { ok: true }
    }

    const script =
      [
        '#!/bin/zsh',
        `# Generated by TaskWraith — interactive provider ${action}.`,
        '[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null',
        '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null',
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
    if (err) return { ok: false, error: err }
    return { ok: true }
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

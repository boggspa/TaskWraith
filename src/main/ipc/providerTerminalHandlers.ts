import { join, basename } from 'path'
import { ipcMain } from 'electron'
import type { ProviderId } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import {
  TASKWRAITH_CODEX_PROTECTED_STATE_ENTRIES,
  taskWraithCodexHomePath
} from '../codex/CodexHome'
import {
  cliUpgradeCommand,
  detectCliInstallChannel,
  unknownInstallChannelMessage
} from '../providers/CliInstallChannel'
import { MUSE_INSTALL_COMMAND } from '../../shared/providerSetupCatalog'

/** Best-effort realpath. A failure classifies as 'unknown', which refuses to
 *  guess rather than upgrading the wrong copy. */
function resolveRealPath(deps: ProviderTerminalHandlersDeps, binaryPath: string): string {
  if (!deps.realpathSync) return binaryPath
  try {
    return deps.realpathSync(binaryPath)
  } catch {
    return binaryPath
  }
}

type TerminalAction = 'login' | 'logout' | 'upgrade'

export type ProviderTerminalResult = {
  ok: boolean
  error?: string
  /** Explicit user-owned setup handoffs are not TaskWraith-managed provider
   * turns and do not qualify a binary for a later managed run. */
  scope?: 'user-owned-provider-setup'
  managedRunReady?: false
  notice?: string
}

const KIMI_USER_OWNED_SETUP_NOTICE =
  'This is a user-owned Kimi setup command outside TaskWraith managed-run containment. Success does not qualify this runtime for managed Kimi turns or compaction.'

const ANTIGRAVITY_USER_OWNED_SETUP_NOTICE =
  'This opens the official user-installed agy CLI for a user-owned sign-in. TaskWraith does not read, copy, or store Google or AntiGravity OAuth or keyring credentials. Completing sign-in does not make AntiGravity available for managed runs until its runtime support is available.'

const ANTIGRAVITY_USER_OWNED_UPGRADE_NOTICE =
  "This opens the official user-installed agy CLI's own updater. TaskWraith resolves and invokes that same CLI installation but does not download or repackage the update. Updating agy does not make AntiGravity ToS-approved or ban-safe."

const MISTRAL_USER_OWNED_SETUP_NOTICE =
  'This opens the official Mistral Vibe setup wizard for a user-owned plan or API-key sign-in. TaskWraith does not read, copy, or store Vibe credentials. After setup, managed Mistral runs use the separate `vibe-acp` runtime.'

const MUSE_USER_OWNED_SETUP_NOTICE =
  'This opens the official Muse Code CLI for a user-owned Meta Model API login (`muse login`) or credential clear (`muse logout`). TaskWraith does not permanently store Meta credentials; managed runs project the Muse-owned credential into a private seat-local home that is deleted at teardown.'

const MUSE_USER_OWNED_UPGRADE_NOTICE =
  'This invokes the resolved Muse launcher with its synchronous-update flag, so the CLI TaskWraith actually runs is updated in place. Meta owns the launcher, download, and account flow.'

const MUSE_USER_OWNED_INSTALL_NOTICE =
  'Muse was not found on PATH. This saves Meta’s official launcher to ~/.local/bin/muse, validates its shell syntax, and invokes the launcher’s explicit install mode.'

export interface ProviderTerminalHandlersDeps {
  resolveCliProviderBinary: (provider: ProviderId) => Promise<ResolvedProviderBinary>
  getUserDataPath: () => string
  openPath: (path: string) => Promise<string>
  mkdirSync: (path: string, options: { recursive: boolean; mode?: number }) => void
  lstatSync: (path: string) => { isDirectory(): boolean; isSymbolicLink(): boolean }
  writeFileSync: (path: string, data: string, options?: { mode?: number }) => void
  chmodSync: (path: string, mode: number) => void
  getPlatform: () => NodeJS.Platform
  /** Resolve a binary past its symlink so the install channel is visible.
   *  Optional: when absent the raw path is classified, which simply yields
   *  'unknown' for a symlinked install rather than guessing wrong. */
  realpathSync?: (path: string) => string
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function shPrintLine(value: string): string {
  return `printf '%s\\n' ${shQuote(value)}`
}

function shPrintStatusLine(value: string): string {
  const marker = '$status'
  const index = value.indexOf(marker)
  if (index < 0) return shPrintLine(value)
  return `printf '%s%s%s\\n' ${shQuote(value.slice(0, index))} "$status" ${shQuote(
    value.slice(index + marker.length)
  )}`
}

function psWriteLine(value: string): string {
  return `Write-Host ${psQuote(value)}`
}

function psWriteStatusLine(value: string): string {
  const marker = '$status'
  const index = value.indexOf(marker)
  if (index < 0) return psWriteLine(value)
  return `Write-Host (${psQuote(value.slice(0, index))} + $status + ${psQuote(
    value.slice(index + marker.length)
  )})`
}

async function openProviderAuthTerminal(
  deps: ProviderTerminalHandlersDeps,
  provider: ProviderId,
  action: TerminalAction
): Promise<ProviderTerminalResult> {
  try {
    let commandParts: string[] | null = null
    let rawCommand: string | null = null
    const commandEnvironment: Record<string, string> = {}
    let label: string
    let setupNotice: string | null = null
    let stripGoogleCredentialEnvironment = false
    let codexHome: string | null = null
    const platform = deps.getPlatform()
    const actionLabel =
      action === 'login' ? 'Sign-in' : action === 'logout' ? 'Sign-out' : 'Upgrade'
    const actionVerb =
      action === 'login' ? 'Signing in to' : action === 'logout' ? 'Signing out of' : 'Upgrading'
    let postscript = `${actionLabel} finished (exit $status). Close this window and return to TaskWraith.`

    if (provider === 'codex') {
      label = 'Codex'
      const resolved = await deps.resolveCliProviderBinary('codex')
      if (action === 'upgrade') {
        // Upgrade the install we actually RUN. This was a hardcoded npm
        // command, which silently installs a second copy when the resolved
        // binary came from a Homebrew cask — reporting success while the
        // executed binary stays put, so version-gated model errors persist
        // through any number of "successful" upgrades.
        const binaryPath = resolved.binaryPath || 'codex'
        const realPath = resolveRealPath(deps, binaryPath)
        const channel = detectCliInstallChannel(realPath)
        const upgrade = cliUpgradeCommand({
          channel,
          npmPackage: '@openai/codex',
          brewToken: 'codex'
        })
        if (!upgrade) {
          return { ok: false, error: unknownInstallChannelMessage('Codex', realPath || binaryPath) }
        }
        commandParts = upgrade
      } else {
        commandParts = [resolved.binaryPath || 'codex', action]
      }
      if (action !== 'upgrade') {
        codexHome = taskWraithCodexHomePath(deps.getUserDataPath())
        postscript = `${actionLabel} finished (exit $status). Close this window, return to TaskWraith, and refresh provider status.`
      }
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
    } else if (provider === 'antigravity') {
      if (action === 'logout') {
        return {
          ok: false,
          error: `AntiGravity terminal ${action} is not supported here. No agy process was started.`
        }
      }
      label = 'AntiGravity'
      stripGoogleCredentialEnvironment = true
      if (action === 'upgrade') {
        // `agy update` is the CLI's own updater. Resolve the same executable
        // used by managed runs so a second PATH installation cannot report a
        // successful upgrade while TaskWraith keeps launching stale bytes.
        const resolved = await deps.resolveCliProviderBinary('antigravity')
        setupNotice = ANTIGRAVITY_USER_OWNED_UPGRADE_NOTICE
        commandParts = [resolved.binaryPath || 'agy', 'update']
      } else {
        // The official CLI starts its own browser/keyring sign-in when launched.
        // Do not resolve or inspect credentials for this interactive handoff.
        setupNotice = ANTIGRAVITY_USER_OWNED_SETUP_NOTICE
        commandParts = ['agy']
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
        commandParts = [resolved.binaryPath || 'ollama', action === 'logout' ? 'signout' : 'signin']
      }
    } else if (provider === 'mistral') {
      label = 'Mistral Vibe'
      if (action === 'logout') {
        // `vibe` has a bounded setup flow but no bounded logout verb. Never
        // replace the requested account action with its interactive TUI: that
        // would open an unbounded provider session and would not reliably sign
        // the user out.
        return {
          ok: false,
          error:
            'Mistral Vibe does not expose a bounded logout command. No Vibe process was started; manage account credentials using the documented Mistral or Vibe account controls instead.',
          scope: 'user-owned-provider-setup',
          managedRunReady: false,
          notice: MISTRAL_USER_OWNED_SETUP_NOTICE
        }
      }
      if (action === 'upgrade') {
        rawCommand = 'curl -LsSf https://mistral.ai/vibe/install.sh | bash'
      } else {
        // The interactive `vibe` binary owns plan / API-key setup. Managed
        // TaskWraith turns still use `vibe-acp`, never this terminal TUI.
        setupNotice = MISTRAL_USER_OWNED_SETUP_NOTICE
        commandParts = ['vibe', '--setup']
      }
    } else if (provider === 'muse') {
      label = 'Muse'
      setupNotice = MUSE_USER_OWNED_SETUP_NOTICE
      if (action === 'upgrade') {
        const resolved = await deps.resolveCliProviderBinary('muse')
        setupNotice = MUSE_USER_OWNED_UPGRADE_NOTICE
        if (resolved.binaryPath) {
          // The installed `muse` path is Meta's launcher. Force its normal
          // update check to run synchronously, then use a bounded --version
          // command instead of opening an interactive Muse session.
          commandEnvironment.MUSE_SYNC_UPDATE = '1'
          commandParts = [resolved.binaryPath, '--version']
        } else if (platform === 'win32') {
          return { ok: false, error: 'Muse installation is supported on macOS and Linux.' }
        } else {
          setupNotice = MUSE_USER_OWNED_INSTALL_NOTICE
          rawCommand = MUSE_INSTALL_COMMAND
        }
      } else {
        // `muse login` opens Meta browser login; `muse logout` clears stored
        // Meta credentials (does not touch META_API_KEY in the environment).
        const resolved = await deps.resolveCliProviderBinary('muse')
        commandParts = [resolved.binaryPath || 'muse', action === 'logout' ? 'logout' : 'login']
      }
    } else {
      return { ok: false, error: `No terminal ${action} for ${provider}.` }
    }

    if (!rawCommand && !commandParts) {
      return { ok: false, error: `No terminal ${action} command for ${provider}.` }
    }

    if (codexHome) {
      deps.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
      const codexHomeStat = deps.lstatSync(codexHome)
      if (!codexHomeStat.isDirectory() || codexHomeStat.isSymbolicLink()) {
        throw new Error('TaskWraith CODEX_HOME must resolve to a private directory, not a symlink.')
      }
      for (const entry of TASKWRAITH_CODEX_PROTECTED_STATE_ENTRIES) {
        try {
          const stat = deps.lstatSync(join(codexHome, entry))
          if (stat.isSymbolicLink()) {
            throw new Error(
              `TaskWraith CODEX_HOME contains a symlink in protected Codex state: ${entry}`
            )
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
          throw error
        }
      }
      if (platform !== 'win32') deps.chmodSync(codexHome, 0o700)
    }
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
          ...(codexHome ? [`$env:CODEX_HOME = ${psQuote(codexHome)}`] : []),
          ...(setupNotice ? [psWriteLine(setupNotice), 'Write-Host ""'] : []),
          ...(stripGoogleCredentialEnvironment
            ? [
                'Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue',
                'Remove-Item Env:GOOGLE_API_KEY -ErrorAction SilentlyContinue',
                'Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue'
              ]
            : []),
          ...Object.entries(commandEnvironment).map(
            ([key, value]) => `$env:${key} = ${psQuote(value)}`
          ),
          psWriteLine(`${actionVerb} ${label} for TaskWraith...`),
          psWriteLine(`> ${command}`),
          'Write-Host ""',
          `& ${command}`,
          '$status = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }',
          'Write-Host ""',
          psWriteStatusLine(postscript)
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
        ...(codexHome ? [`export CODEX_HOME=${shQuote(codexHome)}`] : []),
        ...(setupNotice ? [shPrintLine(setupNotice), 'echo ""'] : []),
        ...(stripGoogleCredentialEnvironment
          ? ['unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS']
          : []),
        ...Object.entries(commandEnvironment).map(
          ([key, value]) => `export ${key}=${shQuote(value)}`
        ),
        shPrintLine(`${actionVerb} ${label} for TaskWraith…`),
        shPrintLine(`> ${command}`),
        'echo ""',
        command,
        'status=$?',
        'echo ""',
        shPrintStatusLine(postscript)
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

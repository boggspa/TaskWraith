import { join, basename } from 'path'
import { homedir } from 'os'
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
import {
  buildProviderManualSetupFlow,
  providerManualSetupNotice
} from '../providers/ProviderManualSetupFlowCatalog'
import { createProviderTerminalSetupController } from '../providers/ProviderTerminalSetupController'
import { signOutKimiOAuth, type KimiOAuthSignOutResult } from '../kimi/KimiOAuthSignOut'

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
  /** Kimi sign-out seam (tests). Defaults to removing the managed OAuth slot
   *  under ~/.kimi-code, the home `kimi login` and every managed run use. */
  signOutKimi?: () => Promise<KimiOAuthSignOutResult>
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
  // The generated POSIX script captures `$?` into `exit_code`, never `status`:
  // zsh treats `status` as a read-only alias of `$?`, so `status=$?` aborts a
  // `#!/bin/zsh` script before its final lines run.
  return `printf '%s%s%s\\n' ${shQuote(value.slice(0, index))} "$exit_code" ${shQuote(
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

/**
 * A secondary provider account signs in through the same terminal flow with
 * its own config folder: a TaskWraith-owned private `CODEX_HOME` for Codex
 * (it takes the same symlink checks as the primary home), or an exported
 * `CLAUDE_CONFIG_DIR` for Claude. Nothing else about the command changes.
 */
export interface ProviderTerminalAccountOptions {
  /** Codex only: the account's private home instead of the primary one. */
  codexHome?: string
  /** Extra exports for the generated script (e.g. CLAUDE_CONFIG_DIR). */
  environment?: Record<string, string>
  /** Shown in the terminal banner so the user knows which account is signing in. */
  accountLabel?: string
}

export async function openProviderAuthTerminal(
  deps: ProviderTerminalHandlersDeps,
  provider: ProviderId,
  action: TerminalAction,
  accountOptions: ProviderTerminalAccountOptions = {}
): Promise<ProviderTerminalResult> {
  try {
    let commandParts: string[] | null = null
    let rawCommand: string | null = null
    const commandEnvironment: Record<string, string> = { ...(accountOptions.environment ?? {}) }
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
        codexHome = accountOptions.codexHome || taskWraithCodexHomePath(deps.getUserDataPath())
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
        // Kimi Code exposes no bounded logout subcommand, and a bare
        // interactive Kimi session would be an unadmitted provider process.
        // Kimi's own logout only deletes the OAuth slot file, so do exactly
        // that in-process; no Kimi process is started.
        const signedOut = await (
          deps.signOutKimi ??
          (() => signOutKimiOAuth({ sourceHome: join(homedir(), '.kimi-code') }))
        )()
        if (!signedOut.ok) return { ok: false, error: signedOut.error }
        return {
          ok: true,
          notice: signedOut.removed
            ? 'Signed out of Kimi Code: removed the `kimi login` OAuth token. No Kimi process was started.'
            : 'No Kimi Code OAuth login was stored, so there was nothing to remove.'
        }
      }
      const resolved = await deps.resolveCliProviderBinary('kimi')
      setupNotice = buildProviderManualSetupFlow('kimi', action)?.notice || null
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
      // Deliberately ungated by AntiGravity consent: user-started (Chris, 2026-09-23).
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
        setupNotice = buildProviderManualSetupFlow('antigravity', 'upgrade')?.notice || null
        commandParts = [resolved.binaryPath || 'agy', 'update']
      } else {
        // The official CLI starts its own browser/keyring sign-in when launched.
        // Do not resolve or inspect credentials for this interactive handoff.
        setupNotice = buildProviderManualSetupFlow('antigravity', 'login')?.notice || null
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
      // `grok login` / `grok logout` are the CLI's bounded account verbs
      // ("Sign out and clear cached credentials"); neither opens the TUI.
      // Managed Grok runs read the same default ~/.grok home.
      commandParts = action === 'upgrade' ? null : [resolved.binaryPath || 'grok', action]
      if (action === 'upgrade') {
        rawCommand = 'curl -fsSL https://x.ai/cli/install.sh | bash'
      }
    } else if (provider === 'ollama') {
      label = 'Ollama'
      const resolved = await deps.resolveCliProviderBinary('ollama')
      if (action === 'upgrade') {
        rawCommand = 'curl -fsSL https://ollama.com/install.sh | sh'
      } else {
        setupNotice = buildProviderManualSetupFlow('ollama', action)?.notice || null
        commandParts = [resolved.binaryPath || 'ollama', action === 'logout' ? 'signout' : 'signin']
        postscript = `${actionLabel} finished (exit $status). Close this window, return to TaskWraith, and refresh Ollama models.`
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
          notice: providerManualSetupNotice('mistral') || undefined
        }
      }
      if (action === 'upgrade') {
        rawCommand = 'curl -LsSf https://mistral.ai/vibe/install.sh | bash'
      } else {
        // The interactive `vibe` binary owns plan / API-key setup. Managed
        // TaskWraith turns still use `vibe-acp`, never this terminal TUI.
        setupNotice = buildProviderManualSetupFlow('mistral', action)?.notice || null
        commandParts = ['vibe', '--setup']
      }
    } else if (provider === 'muse') {
      label = 'Muse'
      setupNotice = buildProviderManualSetupFlow('muse', action)?.notice || null
      if (action === 'upgrade') {
        const resolved = await deps.resolveCliProviderBinary('muse')
        setupNotice = buildProviderManualSetupFlow('muse', 'upgrade')?.notice || null
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
    } else if (provider === 'devin') {
      label = 'Devin'
      setupNotice = buildProviderManualSetupFlow('devin', action)?.notice || null
      const resolved = await deps.resolveCliProviderBinary('devin')
      if (action === 'upgrade') {
        // `devin update` is the CLI's own updater. Resolve the same executable
        // managed runs launch so a second PATH install cannot report a
        // successful upgrade while TaskWraith keeps running stale bytes; with
        // no binary at all the official installer is the only path.
        if (resolved.binaryPath) {
          commandParts = [resolved.binaryPath, 'update']
        } else {
          rawCommand = 'curl -fsSL https://cli.devin.ai/install.sh | bash'
        }
      } else {
        // `devin auth login` opens the account sign-in; `devin auth logout`
        // removes the CLI's stored credentials.toml (it never touches a
        // WINDSURF_API_KEY / DEVIN_API_KEY in the environment).
        commandParts = [resolved.binaryPath || 'devin', 'auth', action]
      }
    } else {
      return { ok: false, error: `No terminal ${action} for ${provider}.` }
    }

    if (!rawCommand && !commandParts) {
      return { ok: false, error: `No terminal ${action} command for ${provider}.` }
    }
    if (accountOptions.accountLabel) {
      label = `${label} · ${accountOptions.accountLabel}`
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
    // An account sign-in gets its own script file so it never races the
    // primary account's launcher of the same provider/action.
    const scriptSuffix = accountOptions.accountLabel
      ? `-${
          accountOptions.accountLabel
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'account'
        }`
      : ''

    if (platform === 'win32') {
      const psFile = join(dir, `${provider}-${action}${scriptSuffix}.ps1`)
      const cmdFile = join(dir, `${provider}-${action}${scriptSuffix}.cmd`)
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
        'exit_code=$?',
        'echo ""',
        shPrintStatusLine(postscript)
      ].join('\n') + '\n'
    const file = join(dir, `${provider}-${action}${scriptSuffix}.command`)
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
  const controller = createProviderTerminalSetupController({
    launch: (provider, action) => openProviderAuthTerminal(deps, provider, action)
  })
  ipcMain.handle('provider:open-login-terminal', async (_e, provider: ProviderId) =>
    controller.open(provider, 'login')
  )
  ipcMain.handle('provider:open-logout-terminal', async (_e, provider: ProviderId) =>
    controller.open(provider, 'logout')
  )
  ipcMain.handle('provider:open-upgrade-terminal', async (_e, provider: ProviderId) =>
    controller.open(provider, 'upgrade')
  )
  ipcMain.handle('provider:open-kimi-upgrade-terminal', async () =>
    controller.open('kimi', 'upgrade')
  )
}

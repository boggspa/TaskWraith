import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import type { ProviderCliAccount } from '../store/types'
import {
  ProviderAccountError,
  isProviderAccountProvider,
  type ProviderAccountRegistry,
  type ProviderAccountSummary
} from '../providers/ProviderAccounts'
import type { ProviderTerminalResult } from './providerTerminalHandlers'

export const PROVIDER_ACCOUNTS_LIST_CHANNEL = 'provider-accounts:list'
export const PROVIDER_ACCOUNTS_ADD_CHANNEL = 'provider-accounts:add'
export const PROVIDER_ACCOUNTS_UPDATE_CHANNEL = 'provider-accounts:update'
export const PROVIDER_ACCOUNTS_REMOVE_CHANNEL = 'provider-accounts:remove'
export const PROVIDER_ACCOUNTS_SET_ACTIVE_CHANNEL = 'provider-accounts:set-active'
export const PROVIDER_ACCOUNTS_OPEN_LOGIN_TERMINAL_CHANNEL = 'provider-accounts:open-login-terminal'
export const PROVIDER_ACCOUNTS_PICK_CONFIG_DIR_CHANNEL = 'provider-accounts:pick-config-dir'
export const PROVIDER_ACCOUNTS_AUTH_STATE_CHANNEL = 'provider-accounts:auth-state'

export const PROVIDER_ACCOUNT_IPC_CHANNELS = [
  PROVIDER_ACCOUNTS_LIST_CHANNEL,
  PROVIDER_ACCOUNTS_ADD_CHANNEL,
  PROVIDER_ACCOUNTS_UPDATE_CHANNEL,
  PROVIDER_ACCOUNTS_REMOVE_CHANNEL,
  PROVIDER_ACCOUNTS_SET_ACTIVE_CHANNEL,
  PROVIDER_ACCOUNTS_OPEN_LOGIN_TERMINAL_CHANNEL,
  PROVIDER_ACCOUNTS_PICK_CONFIG_DIR_CHANNEL,
  PROVIDER_ACCOUNTS_AUTH_STATE_CHANNEL
] as const

export type ProviderAccountMutationResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Sign-in state of one account's config folder, as its CLI reports it. */
export interface ProviderAccountAuthState {
  accountId: string
  authState: string
}

interface OpenDialogResultLike {
  canceled: boolean
  filePaths: string[]
}

export interface ProviderAccountHandlersDeps {
  registry: ProviderAccountRegistry
  /** Opens the provider's terminal sign-in with the account's folder exported. */
  openAccountLoginTerminal: (account: ProviderCliAccount) => Promise<ProviderTerminalResult>
  /** Probe the CLI's own auth status against the account's folder. */
  readAccountAuthState: (account: ProviderCliAccount) => Promise<string>
  getMainWindow: () => BrowserWindow | null
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions
  ) => Promise<OpenDialogResultLike>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
}

function requireMainRenderer(deps: ProviderAccountHandlersDeps, event: IpcMainInvokeEvent): void {
  if (!deps.isMainRendererSender(event)) {
    throw new Error('Provider accounts are managed from the main window only.')
  }
}

function mutation<T>(run: () => T): ProviderAccountMutationResult<T> {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    if (error instanceof ProviderAccountError) return { ok: false, error: error.message }
    throw error
  }
}

function requireAccount(deps: ProviderAccountHandlersDeps, accountId: unknown): ProviderCliAccount {
  const id = typeof accountId === 'string' ? accountId.trim() : ''
  const account = deps.registry.list().find((candidate) => candidate.id === id)
  if (!account) throw new ProviderAccountError('That provider account no longer exists.')
  const { active: _active, envKey: _envKey, ...record } = account
  return record
}

export function registerProviderAccountHandlers(deps: ProviderAccountHandlersDeps): void {
  ipcMain.handle(
    PROVIDER_ACCOUNTS_LIST_CHANNEL,
    (event, provider?: unknown): ProviderAccountSummary[] => {
      requireMainRenderer(deps, event)
      return deps.registry.list(isProviderAccountProvider(provider) ? provider : undefined)
    }
  )

  ipcMain.handle(PROVIDER_ACCOUNTS_ADD_CHANNEL, (event, input: unknown) => {
    requireMainRenderer(deps, event)
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    return mutation(() =>
      deps.registry.add({
        provider: record.provider,
        label: record.label,
        configDir: record.configDir
      })
    )
  })

  ipcMain.handle(PROVIDER_ACCOUNTS_UPDATE_CHANNEL, (event, input: unknown) => {
    requireMainRenderer(deps, event)
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    return mutation(() =>
      deps.registry.update({ id: record.id, label: record.label, configDir: record.configDir })
    )
  })

  ipcMain.handle(PROVIDER_ACCOUNTS_REMOVE_CHANNEL, (event, accountId: unknown) => {
    requireMainRenderer(deps, event)
    return mutation(() => deps.registry.remove(accountId))
  })

  ipcMain.handle(PROVIDER_ACCOUNTS_SET_ACTIVE_CHANNEL, (event, input: unknown) => {
    requireMainRenderer(deps, event)
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    return mutation(() => deps.registry.setActive(record.provider, record.accountId ?? null))
  })

  ipcMain.handle(
    PROVIDER_ACCOUNTS_OPEN_LOGIN_TERMINAL_CHANNEL,
    async (event, accountId: unknown): Promise<ProviderTerminalResult> => {
      requireMainRenderer(deps, event)
      let account: ProviderCliAccount
      try {
        account = requireAccount(deps, accountId)
      } catch (error) {
        if (error instanceof ProviderAccountError) return { ok: false, error: error.message }
        throw error
      }
      return deps.openAccountLoginTerminal(account)
    }
  )

  ipcMain.handle(
    PROVIDER_ACCOUNTS_AUTH_STATE_CHANNEL,
    async (event, accountId: unknown): Promise<ProviderAccountAuthState | null> => {
      requireMainRenderer(deps, event)
      let account: ProviderCliAccount
      try {
        account = requireAccount(deps, accountId)
      } catch {
        return null
      }
      return { accountId: account.id, authState: await deps.readAccountAuthState(account) }
    }
  )

  ipcMain.handle(
    PROVIDER_ACCOUNTS_PICK_CONFIG_DIR_CHANNEL,
    async (event): Promise<string | null> => {
      requireMainRenderer(deps, event)
      const mainWindow = deps.getMainWindow()
      if (!mainWindow) return null
      const result = await deps.showOpenDialog(mainWindow, {
        title: 'Choose a folder for this Claude account',
        message:
          'Choose or create the config folder this account signs in with (e.g. ~/.claude-work).',
        buttonLabel: 'Use Folder',
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )
}

export function unregisterProviderAccountHandlers(): void {
  for (const channel of PROVIDER_ACCOUNT_IPC_CHANNELS) ipcMain.removeHandler(channel)
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../store/types'
import { createProviderAccountRegistry } from '../providers/ProviderAccounts'
import {
  PROVIDER_ACCOUNTS_ADD_CHANNEL,
  PROVIDER_ACCOUNTS_AUTH_STATE_CHANNEL,
  PROVIDER_ACCOUNTS_LIST_CHANNEL,
  PROVIDER_ACCOUNTS_OPEN_LOGIN_TERMINAL_CHANNEL,
  PROVIDER_ACCOUNTS_PICK_CONFIG_DIR_CHANNEL,
  PROVIDER_ACCOUNTS_REMOVE_CHANNEL,
  PROVIDER_ACCOUNTS_SET_ACTIVE_CHANNEL,
  PROVIDER_ACCOUNTS_UPDATE_CHANNEL,
  PROVIDER_ACCOUNT_IPC_CHANNELS,
  registerProviderAccountHandlers,
  unregisterProviderAccountHandlers,
  type ProviderAccountHandlersDeps
} from './providerAccountHandlers'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

const MAIN_EVENT = { sender: { id: 1 } }
const POPOUT_EVENT = { sender: { id: 2 } }

function handlerFor(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = handlers.get(channel)
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function harness() {
  let settings: Partial<AppSettings> = { providerAccounts: [], activeProviderAccountIds: {} }
  let counter = 0
  const registry = createProviderAccountRegistry({
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch }
    },
    getUserDataPath: () => '/Users/tester/Library/Application Support/taskwraith',
    randomSuffix: () => `r${(counter += 1)}`.padEnd(6, '0'),
    homeDir: () => '/Users/tester'
  })
  const deps: ProviderAccountHandlersDeps = {
    registry,
    openAccountLoginTerminal: vi.fn(async () => ({ ok: true })),
    readAccountAuthState: vi.fn(async () => 'authenticated'),
    getMainWindow: vi.fn(() => ({}) as never),
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ['/Users/tester/.claude-work']
    })),
    isMainRendererSender: vi.fn(
      (event: unknown) => (event as { sender: { id: number } }).sender.id === 1
    )
  }
  registerProviderAccountHandlers(deps)
  return { deps, settings: () => settings }
}

beforeEach(() => {
  handlers.clear()
})

describe('registerProviderAccountHandlers', () => {
  it('registers every account channel and unregisters them all', () => {
    harness()
    for (const channel of PROVIDER_ACCOUNT_IPC_CHANNELS) expect(handlers.has(channel)).toBe(true)
    unregisterProviderAccountHandlers()
    expect(handlers.size).toBe(0)
  })

  it('refuses every channel from a non-main renderer', async () => {
    harness()
    for (const channel of PROVIDER_ACCOUNT_IPC_CHANNELS) {
      await expect(async () => handlerFor(channel)(POPOUT_EVENT, 'x')).rejects.toThrow(
        /main window only/
      )
    }
  })

  it('adds, lists, activates, renames and removes an account through the registry', async () => {
    const { settings } = harness()
    const added = (await handlerFor(PROVIDER_ACCOUNTS_ADD_CHANNEL)(MAIN_EVENT, {
      provider: 'claude',
      label: 'Work',
      configDir: '~/.claude-work'
    })) as { ok: true; value: { id: string; active: boolean } }
    expect(added.ok).toBe(true)
    expect(added.value.active).toBe(false)

    const listed = (await handlerFor(PROVIDER_ACCOUNTS_LIST_CHANNEL)(
      MAIN_EVENT,
      'claude'
    )) as Array<{
      id: string
    }>
    expect(listed.map((entry) => entry.id)).toEqual([added.value.id])
    expect(await handlerFor(PROVIDER_ACCOUNTS_LIST_CHANNEL)(MAIN_EVENT, 'codex')).toEqual([])

    expect(
      await handlerFor(PROVIDER_ACCOUNTS_SET_ACTIVE_CHANNEL)(MAIN_EVENT, {
        provider: 'claude',
        accountId: added.value.id
      })
    ).toEqual({ ok: true, value: { provider: 'claude', accountId: added.value.id } })
    expect(settings().activeProviderAccountIds).toEqual({ claude: added.value.id })

    const renamed = (await handlerFor(PROVIDER_ACCOUNTS_UPDATE_CHANNEL)(MAIN_EVENT, {
      id: added.value.id,
      label: 'Boggspa'
    })) as { ok: true; value: { label: string; active: boolean } }
    expect(renamed.value).toMatchObject({ label: 'Boggspa', active: true })

    expect(await handlerFor(PROVIDER_ACCOUNTS_REMOVE_CHANNEL)(MAIN_EVENT, added.value.id)).toEqual({
      ok: true,
      value: true
    })
    expect(settings().providerAccounts).toEqual([])
    expect(settings().activeProviderAccountIds).toEqual({})
  })

  it('returns registry validation failures as {ok:false} instead of throwing', async () => {
    harness()
    expect(
      await handlerFor(PROVIDER_ACCOUNTS_ADD_CHANNEL)(MAIN_EVENT, {
        provider: 'claude',
        label: 'Primary',
        configDir: '~/.claude'
      })
    ).toEqual({ ok: false, error: expect.stringMatching(/primary Claude sign-in/) })
    expect(await handlerFor(PROVIDER_ACCOUNTS_REMOVE_CHANNEL)(MAIN_EVENT, 'missing')).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer exists/)
    })
    expect(await handlerFor(PROVIDER_ACCOUNTS_ADD_CHANNEL)(MAIN_EVENT, 'not an object')).toEqual({
      ok: false,
      error: expect.stringMatching(/Claude and Codex/)
    })
  })

  it('opens the account sign-in with the stored account record and probes its auth state', async () => {
    const { deps } = harness()
    const added = (await handlerFor(PROVIDER_ACCOUNTS_ADD_CHANNEL)(MAIN_EVENT, {
      provider: 'codex',
      label: 'Second'
    })) as { ok: true; value: { id: string; configDir: string } }
    await expect(
      handlerFor(PROVIDER_ACCOUNTS_OPEN_LOGIN_TERMINAL_CHANNEL)(MAIN_EVENT, added.value.id)
    ).resolves.toEqual({ ok: true })
    expect(deps.openAccountLoginTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: added.value.id,
        provider: 'codex',
        configDir: added.value.configDir
      })
    )
    // The summary-only fields never reach the launcher.
    const launched = vi.mocked(deps.openAccountLoginTerminal).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >
    expect(launched).not.toHaveProperty('active')
    expect(launched).not.toHaveProperty('envKey')

    await expect(
      handlerFor(PROVIDER_ACCOUNTS_AUTH_STATE_CHANNEL)(MAIN_EVENT, added.value.id)
    ).resolves.toEqual({ accountId: added.value.id, authState: 'authenticated' })
    await expect(
      handlerFor(PROVIDER_ACCOUNTS_OPEN_LOGIN_TERMINAL_CHANNEL)(MAIN_EVENT, 'missing')
    ).resolves.toEqual({ ok: false, error: expect.stringMatching(/no longer exists/) })
    await expect(
      handlerFor(PROVIDER_ACCOUNTS_AUTH_STATE_CHANNEL)(MAIN_EVENT, 'missing')
    ).resolves.toBeNull()
  })

  it('picks a config folder through the main window’s native chooser', async () => {
    const { deps } = harness()
    await expect(handlerFor(PROVIDER_ACCOUNTS_PICK_CONFIG_DIR_CHANNEL)(MAIN_EVENT)).resolves.toBe(
      '/Users/tester/.claude-work'
    )
    expect(deps.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
      })
    )
    vi.mocked(deps.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(
      handlerFor(PROVIDER_ACCOUNTS_PICK_CONFIG_DIR_CHANNEL)(MAIN_EVENT)
    ).resolves.toBeNull()
    vi.mocked(deps.getMainWindow).mockReturnValueOnce(null)
    await expect(
      handlerFor(PROVIDER_ACCOUNTS_PICK_CONFIG_DIR_CHANNEL)(MAIN_EVENT)
    ).resolves.toBeNull()
  })
})

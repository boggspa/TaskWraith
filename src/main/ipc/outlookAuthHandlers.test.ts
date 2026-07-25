import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { registerOutlookAuthHandlers, type OutlookAuthHandlerDeps } from './outlookAuthHandlers'
import type { OutlookCredentialStore } from '../outlook/OutlookCredentialStore'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

const mockedHandle = vi.mocked(ipcMain.handle)
const fakeEvent = {} as IpcMainInvokeEvent
const CLIENT_ID = '11111111-2222-3333-4444-555555555555'

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

const TOKENS = {
  accessToken: 'ACCESS',
  refreshToken: 'REFRESH',
  expiresAtMs: 1_800_003_600_000,
  scopes: ['Mail.Read'],
  account: null
}

function makeDeps(overrides: Partial<OutlookAuthHandlerDeps> = {}): OutlookAuthHandlerDeps {
  const saved: unknown[] = []
  const store = {
    status: vi.fn(() => ({ connected: saved.length > 0, encryptionAvailable: true })),
    save: vi.fn((credentials: unknown) => {
      saved.push(credentials)
      return { ok: true, status: { connected: true, encryptionAvailable: true } }
    }),
    clear: vi.fn(() => ({ ok: true, status: { connected: false, encryptionAvailable: true } }))
  } as unknown as OutlookCredentialStore
  return {
    store,
    assertMainRenderer: vi.fn(),
    resolveAccount: vi.fn(async () => 'alice@example.com'),
    createAuth: vi.fn(
      () =>
        ({
          startDeviceCode: async () => ({
            deviceCode: 'SECRET-DEVICE-CODE',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://microsoft.com/devicelogin',
            message: 'Enter ABCD-EFGH',
            expiresInSeconds: 900,
            pollIntervalSeconds: 5
          }),
          pollForToken: async () => ({ status: 'granted', tokens: TOKENS })
        }) as never
    ),
    nowMs: () => 1_800_000_000_000,
    ...overrides
  }
}

describe('registerOutlookAuthHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the four account channels', () => {
    registerOutlookAuthHandlers(makeDeps())
    expect(mockedHandle.mock.calls.map(([channel]) => channel)).toEqual([
      'outlook:status',
      'outlook:start-sign-in',
      'outlook:poll-sign-in',
      'outlook:disconnect'
    ])
  })

  it('asserts the main renderer on every channel', async () => {
    const deps = makeDeps({
      assertMainRenderer: vi.fn(() => {
        throw new Error('Only the main renderer can manage the Microsoft account.')
      })
    })
    registerOutlookAuthHandlers(deps)
    for (const channel of [
      'outlook:status',
      'outlook:start-sign-in',
      'outlook:poll-sign-in',
      'outlook:disconnect'
    ]) {
      await expect(handlerFor(channel)(fakeEvent, {})).rejects.toThrow(/main renderer/)
    }
  })

  it('never returns the device code to the renderer', async () => {
    registerOutlookAuthHandlers(makeDeps())
    const started = await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    expect(started).toMatchObject({ ok: true, userCode: 'ABCD-EFGH' })
    // The pollable secret stays in main.
    expect(JSON.stringify(started)).not.toContain('SECRET-DEVICE-CODE')
  })

  it('rejects a malformed client id before any network call', async () => {
    const deps = makeDeps()
    registerOutlookAuthHandlers(deps)
    const result = await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: 'nope' })
    expect(result).toMatchObject({ ok: false })
    expect(deps.createAuth).not.toHaveBeenCalled()
  })

  it('defaults to read scopes and only requests write when asked', async () => {
    const scopeModes: string[] = []
    const deps = makeDeps({
      createAuth: vi.fn(
        () =>
          ({
            startDeviceCode: async (mode: string) => {
              scopeModes.push(mode)
              return {
                deviceCode: 'd',
                userCode: 'u',
                verificationUri: 'v',
                message: 'm',
                expiresInSeconds: 900,
                pollIntervalSeconds: 5
              }
            },
            pollForToken: async () => ({ status: 'pending' })
          }) as never
      )
    })
    registerOutlookAuthHandlers(deps)
    await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    await handlerFor('outlook:start-sign-in')(fakeEvent, {
      clientId: CLIENT_ID,
      scopeMode: 'write'
    })
    await handlerFor('outlook:start-sign-in')(fakeEvent, {
      clientId: CLIENT_ID,
      scopeMode: 'nonsense'
    })
    expect(scopeModes).toEqual(['read', 'write', 'read'])
  })

  it('saves credentials and labels the account once the user approves', async () => {
    const deps = makeDeps()
    registerOutlookAuthHandlers(deps)
    await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    const polled = await handlerFor('outlook:poll-sign-in')(fakeEvent)
    expect(polled).toMatchObject({ status: 'connected' })
    expect(deps.store.save).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.store.save).mock.calls[1][0]).toMatchObject({
      account: 'alice@example.com',
      scopeMode: 'read'
    })
  })

  it('keeps the connection when the account label cannot be resolved', async () => {
    const deps = makeDeps({
      resolveAccount: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    registerOutlookAuthHandlers(deps)
    await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    expect(await handlerFor('outlook:poll-sign-in')(fakeEvent)).toMatchObject({
      status: 'connected'
    })
  })

  it('reports a storage refusal instead of pretending to be connected', async () => {
    const deps = makeDeps()
    vi.mocked(deps.store.save).mockReturnValue({
      ok: false,
      status: { connected: false, encryptionAvailable: false }
    })
    registerOutlookAuthHandlers(deps)
    await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    expect(await handlerFor('outlook:poll-sign-in')(fakeEvent)).toMatchObject({
      status: 'error',
      message: expect.stringContaining('cannot encrypt')
    })
  })

  it('reports no-pending before a sign-in starts and after disconnect', async () => {
    const deps = makeDeps()
    registerOutlookAuthHandlers(deps)
    expect(await handlerFor('outlook:poll-sign-in')(fakeEvent)).toEqual({ status: 'no-pending' })
    await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    await handlerFor('outlook:disconnect')(fakeEvent)
    expect(await handlerFor('outlook:poll-sign-in')(fakeEvent)).toEqual({ status: 'no-pending' })
    expect(deps.store.clear).toHaveBeenCalled()
  })

  it('expires a stale pending sign-in', async () => {
    let now = 1_800_000_000_000
    const deps = makeDeps({ nowMs: () => now })
    registerOutlookAuthHandlers(deps)
    await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    now += 21 * 60_000
    expect(await handlerFor('outlook:poll-sign-in')(fakeEvent)).toEqual({ status: 'expired' })
  })

  it('backs off on slow-down while staying pending', async () => {
    const deps = makeDeps({
      createAuth: vi.fn(
        () =>
          ({
            startDeviceCode: async () => ({
              deviceCode: 'd',
              userCode: 'u',
              verificationUri: 'v',
              message: 'm',
              expiresInSeconds: 900,
              pollIntervalSeconds: 5
            }),
            pollForToken: async () => ({ status: 'slow-down', nextIntervalSeconds: 10 })
          }) as never
      )
    })
    registerOutlookAuthHandlers(deps)
    await handlerFor('outlook:start-sign-in')(fakeEvent, { clientId: CLIENT_ID })
    expect(await handlerFor('outlook:poll-sign-in')(fakeEvent)).toEqual({ status: 'pending' })
  })
})

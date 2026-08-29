import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  WEB_LOGIN_IPC_CHANNELS,
  registerWebLoginHandlers,
  type WebLoginHandlerDeps
} from './webLoginHandlers'
import { ipcChannelRequiresMainRenderer } from '../RendererIpcPolicy'

const mockedHandle = vi.mocked(ipcMain.handle)

function harness(overrides: Partial<WebLoginHandlerDeps> = {}): {
  deps: WebLoginHandlerDeps
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
} {
  const deps: WebLoginHandlerDeps = {
    assertSenderCanManageWebLogins: vi.fn(),
    listSites: vi.fn(() => []),
    addSite: vi.fn(() => ({ ok: true })),
    updateSite: vi.fn(() => ({ ok: true })),
    removeSite: vi.fn(async () => ({ ok: true })),
    signOutSite: vi.fn(async () => ({ ok: true })),
    signInSite: vi.fn(async () => ({ ok: true })),
    ...overrides
  }
  registerWebLoginHandlers(deps)
  const invoke = async (channel: string, payload?: unknown): Promise<unknown> => {
    const entry = mockedHandle.mock.calls.find(([name]) => name === channel)
    if (!entry) throw new Error(`channel ${channel} was not registered`)
    return (entry[1] as (e: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>)(
      {} as IpcMainInvokeEvent,
      payload
    )
  }
  return { deps, invoke }
}

beforeEach(() => {
  mockedHandle.mockClear()
})

describe('registerWebLoginHandlers', () => {
  it('registers exactly the six site-login channels', () => {
    harness()
    expect(mockedHandle.mock.calls.map(([name]) => name)).toEqual([...WEB_LOGIN_IPC_CHANNELS])
  })

  it.each([...WEB_LOGIN_IPC_CHANNELS])('keeps %s main-renderer-only', (channel) => {
    // These channels grant and revoke the authority an agent has over a real
    // account; a popout has no business reaching them.
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
  })

  it('gates EVERY channel on the sender assertion before touching deps', async () => {
    const assertSenderCanManageWebLogins = vi.fn(() => {
      throw new Error('not the main renderer')
    })
    const listSites = vi.fn(() => [])
    const h = harness({ assertSenderCanManageWebLogins, listSites })
    for (const channel of WEB_LOGIN_IPC_CHANNELS) {
      await expect(h.invoke(channel, { id: 'example-com' })).rejects.toThrow(/main renderer/)
    }
    expect(assertSenderCanManageWebLogins).toHaveBeenCalledTimes(WEB_LOGIN_IPC_CHANNELS.length)
    expect(listSites).not.toHaveBeenCalled()
  })

  it('rejects an unknown top-level key rather than silently dropping it', async () => {
    const h = harness()
    await expect(
      h.invoke('web-login:add', { origin: 'a.example', agentAccess: 'act' })
    ).rejects.toThrow(/Malformed/)
    await expect(h.invoke('web-login:remove', { id: 'x', force: true })).rejects.toThrow(
      /Malformed/
    )
  })

  it('rejects an unknown agent access level', async () => {
    const h = harness()
    await expect(h.invoke('web-login:update', { id: 'x', agentAccess: 'root' })).rejects.toThrow(
      /agent access/i
    )
  })

  it('requires an id on every id-addressed channel', async () => {
    const h = harness()
    for (const channel of ['web-login:remove', 'web-login:sign-in', 'web-login:sign-out']) {
      await expect(h.invoke(channel, {})).rejects.toThrow(/Site id is required/)
      await expect(h.invoke(channel, { id: '   ' })).rejects.toThrow(/Site id is required/)
    }
  })

  it('requires a site address on add', async () => {
    const h = harness()
    await expect(h.invoke('web-login:add', {})).rejects.toThrow(/Site address is required/)
  })

  it('passes a well-formed update through with only the named fields', async () => {
    const updateSite = vi.fn(() => ({ ok: true }))
    const h = harness({ updateSite })
    await h.invoke('web-login:update', {
      id: 'example-com',
      label: 'Example',
      agentAccess: 'read',
      extraOrigins: ['https://idp.example.net']
    })
    expect(updateSite).toHaveBeenCalledWith('example-com', {
      label: 'Example',
      agentAccess: 'read',
      extraOrigins: ['https://idp.example.net']
    })
  })

  it('rejects a non-string entry in extraOrigins', async () => {
    const h = harness()
    await expect(
      h.invoke('web-login:update', { id: 'x', extraOrigins: ['https://a.example', 7] })
    ).rejects.toThrow(/Malformed/)
  })
})

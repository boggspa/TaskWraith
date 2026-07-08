import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { FaviconService } from '../services/FaviconService'
import { registerShellHandlers, type ShellHandlerDeps } from './shellHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  const getForUrl = vi.fn<FaviconService['getForUrl']>(async () => ({
    ok: true as const,
    origin: 'https://example.com',
    host: 'example.com',
    iconUrl: 'https://example.com/favicon.ico',
    dataUrl: 'data:image/png;base64,zz',
    contentType: 'image/png',
    source: 'network' as const
  }))
  const faviconService = { getForUrl } as unknown as FaviconService
  const deps = {
    openSafeShellTarget: vi.fn<ShellHandlerDeps['openSafeShellTarget']>(async () => ({
      ok: true
    })),
    revealPathInFinder: vi.fn<ShellHandlerDeps['revealPathInFinder']>(async () => ({
      ok: true
    })),
    getFaviconService: vi.fn<ShellHandlerDeps['getFaviconService']>(() => faviconService)
  } satisfies ShellHandlerDeps
  return { deps, getForUrl }
}

describe('registerShellHandlers', () => {
  it('registers the shell and favicon IPC channels', () => {
    const { deps } = createDeps()
    registerShellHandlers(deps)

    expect(handlerFor('shell:open-link')).toBeTypeOf('function')
    expect(handlerFor('shell:reveal-in-finder')).toBeTypeOf('function')
    expect(handlerFor('favicon:getForUrl')).toBeTypeOf('function')
  })

  it('delegates shell:open-link to openSafeShellTarget and returns its result', async () => {
    const { deps } = createDeps()
    vi.mocked(deps.openSafeShellTarget).mockResolvedValue({ ok: false, error: 'blocked scheme' })
    registerShellHandlers(deps)

    await expect(
      handlerFor('shell:open-link')({ sender: {} }, 'javascript:alert(1)')
    ).resolves.toEqual({ ok: false, error: 'blocked scheme' })
    expect(deps.openSafeShellTarget).toHaveBeenCalledWith('javascript:alert(1)')
  })

  it('delegates shell:reveal-in-finder to revealPathInFinder and returns its result', async () => {
    const { deps } = createDeps()
    vi.mocked(deps.revealPathInFinder).mockResolvedValue({ ok: true })
    registerShellHandlers(deps)

    await expect(
      handlerFor('shell:reveal-in-finder')({ sender: {} }, '/tmp/file.txt')
    ).resolves.toEqual({ ok: true })
    expect(deps.revealPathInFinder).toHaveBeenCalledWith('/tmp/file.txt')
  })

  it('looks up favicons for a given url through the injected favicon service', async () => {
    const { deps, getForUrl } = createDeps()
    registerShellHandlers(deps)

    await expect(
      handlerFor('favicon:getForUrl')({ sender: {} }, 'https://example.com/page')
    ).resolves.toEqual({
      ok: true,
      origin: 'https://example.com',
      host: 'example.com',
      iconUrl: 'https://example.com/favicon.ico',
      dataUrl: 'data:image/png;base64,zz',
      contentType: 'image/png',
      source: 'network'
    })
    expect(getForUrl).toHaveBeenCalledWith('https://example.com/page')
  })

  it('coerces a falsy href to an empty string before the favicon lookup', async () => {
    const { deps, getForUrl } = createDeps()
    registerShellHandlers(deps)

    await handlerFor('favicon:getForUrl')({ sender: {} }, undefined)

    expect(getForUrl).toHaveBeenCalledWith('')
  })
})

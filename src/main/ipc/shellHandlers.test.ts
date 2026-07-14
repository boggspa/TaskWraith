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
    getFaviconService: vi.fn<ShellHandlerDeps['getFaviconService']>(() => faviconService),
    authorizeLocalPath: vi.fn<NonNullable<ShellHandlerDeps['authorizeLocalPath']>>(
      async (_event, request) => request.requestedPath
    ),
    isMainRendererSender: vi.fn<NonNullable<ShellHandlerDeps['isMainRendererSender']>>(() => true),
    inspectLocalOpenTarget: vi.fn<NonNullable<ShellHandlerDeps['inspectLocalOpenTarget']>>(
      async () => ({
        kind: 'file',
        mode: 0o644,
        prefix: new Uint8Array()
      })
    )
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

  it('keeps external links usable without consulting local-path authority', async () => {
    const { deps } = createDeps()
    registerShellHandlers(deps)

    const openLink = handlerFor('shell:open-link')
    await expect(openLink({ sender: {} }, 'http://example.com/report')).resolves.toEqual({
      ok: true
    })
    await expect(openLink({ sender: {} }, 'https://example.com/report')).resolves.toEqual({
      ok: true
    })
    await expect(openLink({ sender: {} }, 'mailto:security@example.com')).resolves.toEqual({
      ok: true
    })
    expect(deps.authorizeLocalPath).not.toHaveBeenCalled()
    expect(deps.openSafeShellTarget).toHaveBeenNthCalledWith(1, 'http://example.com/report')
    expect(deps.openSafeShellTarget).toHaveBeenNthCalledWith(2, 'https://example.com/report')
    expect(deps.openSafeShellTarget).toHaveBeenNthCalledWith(3, 'mailto:security@example.com')
  })

  it('rejects unsafe schemes without delegating to the OS bridge', async () => {
    const { deps } = createDeps()
    registerShellHandlers(deps)

    await expect(
      handlerFor('shell:open-link')({ sender: {} }, 'javascript:alert(1)')
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unsafe/i) })
    expect(deps.authorizeLocalPath).not.toHaveBeenCalled()
    expect(deps.openSafeShellTarget).not.toHaveBeenCalled()
  })

  it('opens only the canonical local path returned by caller authorization', async () => {
    const { deps } = createDeps()
    vi.mocked(deps.authorizeLocalPath).mockResolvedValue('/canonical/workspace/report.pdf')
    vi.mocked(deps.isMainRendererSender).mockReturnValue(false)
    deps.inspectLocalOpenTarget = vi.fn(async () => ({
      kind: 'file',
      mode: 0o644,
      prefix: new Uint8Array([0x25, 0x50, 0x44, 0x46])
    }))
    registerShellHandlers(deps)

    const event = { sender: { id: 88 } }
    await expect(
      handlerFor('shell:open-link')(event, '/forged/outside/report.pdf')
    ).resolves.toEqual({ ok: true })
    expect(deps.authorizeLocalPath).toHaveBeenCalledWith(event, {
      operation: 'open',
      requestedPath: '/forged/outside/report.pdf'
    })
    expect(deps.openSafeShellTarget).toHaveBeenCalledWith('/canonical/workspace/report.pdf')
  })

  it('prevents a denied secondary local open from reaching the OS bridge', async () => {
    const { deps } = createDeps()
    vi.mocked(deps.authorizeLocalPath).mockRejectedValue(new Error('outside owned workspace'))
    vi.mocked(deps.isMainRendererSender).mockReturnValue(false)
    registerShellHandlers(deps)

    await expect(
      handlerFor('shell:open-link')({ sender: { id: 88 } }, '/private/secret.txt')
    ).rejects.toThrow(/outside owned workspace/i)
    expect(deps.openSafeShellTarget).not.toHaveBeenCalled()
  })

  it('prevents secondary renderers from launching authorized executable targets', async () => {
    const { deps } = createDeps()
    vi.mocked(deps.isMainRendererSender).mockReturnValue(false)
    registerShellHandlers(deps)

    await expect(
      handlerFor('shell:open-link')({ sender: { id: 88 } }, '/workspace/run.command')
    ).rejects.toThrow(/executable or active/i)
    expect(deps.openSafeShellTarget).not.toHaveBeenCalled()
  })

  it('reveals only the canonical path returned by caller authorization', async () => {
    const { deps } = createDeps()
    vi.mocked(deps.revealPathInFinder).mockResolvedValue({ ok: true })
    vi.mocked(deps.authorizeLocalPath).mockResolvedValue('/canonical/workspace/file.txt')
    registerShellHandlers(deps)

    const event = { sender: { id: 88 } }
    await expect(handlerFor('shell:reveal-in-finder')(event, '/tmp/file.txt')).resolves.toEqual({
      ok: true
    })
    expect(deps.authorizeLocalPath).toHaveBeenCalledWith(event, {
      operation: 'reveal',
      requestedPath: '/tmp/file.txt'
    })
    expect(deps.revealPathInFinder).toHaveBeenCalledWith('/canonical/workspace/file.txt')
  })

  it('prevents a denied secondary reveal from reaching Finder', async () => {
    const { deps } = createDeps()
    vi.mocked(deps.authorizeLocalPath).mockRejectedValue(new Error('outside owned workspace'))
    registerShellHandlers(deps)

    await expect(
      handlerFor('shell:reveal-in-finder')({ sender: { id: 88 } }, '/private/secret.txt')
    ).rejects.toThrow(/outside owned workspace/i)
    expect(deps.revealPathInFinder).not.toHaveBeenCalled()
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

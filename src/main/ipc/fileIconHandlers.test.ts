import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerFileIconHandlers } from './fileIconHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps(overrides: Partial<Parameters<typeof registerFileIconHandlers>[0]> = {}) {
  return {
    getFileIcon: vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,abc'
    })),
    authorizeLocalPath: vi.fn(async (_event, request) => request.requestedPath),
    cache: new Map<string, string | null>(),
    ...overrides
  }
}

describe('registerFileIconHandlers', () => {
  it('registers get-file-icon', () => {
    registerFileIconHandlers(createDeps())
    expect(handlerFor('get-file-icon')).toBeTypeOf('function')
  })

  it('returns null for non-string input without calling getFileIcon', async () => {
    const deps = createDeps()
    registerFileIconHandlers(deps)

    await expect(handlerFor('get-file-icon')({}, 123 as unknown as string)).resolves.toBeNull()
    expect(deps.getFileIcon).not.toHaveBeenCalled()
  })

  it('returns null for trimmed empty paths without calling getFileIcon', async () => {
    const deps = createDeps()
    registerFileIconHandlers(deps)

    await expect(handlerFor('get-file-icon')({}, '   ')).resolves.toBeNull()
    expect(deps.getFileIcon).not.toHaveBeenCalled()
  })

  it('stores and reuses successful data URLs from the cache', async () => {
    const deps = createDeps()
    registerFileIconHandlers(deps)

    await expect(handlerFor('get-file-icon')({}, ' /tmp/icon.png ')).resolves.toBe(
      'data:image/png;base64,abc'
    )
    expect(deps.getFileIcon).toHaveBeenCalledWith('/tmp/icon.png', { size: 'small' })
    expect(deps.cache.get('/tmp/icon.png')).toBe('data:image/png;base64,abc')

    await expect(handlerFor('get-file-icon')({}, '/tmp/icon.png')).resolves.toBe(
      'data:image/png;base64,abc'
    )
    expect(deps.getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('uses only the canonical path returned by caller authorization', async () => {
    const deps = createDeps({
      authorizeLocalPath: vi.fn(async () => '/canonical/workspace/icon.png')
    })
    registerFileIconHandlers(deps)

    const event = { sender: { id: 88 } }
    await expect(handlerFor('get-file-icon')(event, '/forged/outside/icon.png')).resolves.toBe(
      'data:image/png;base64,abc'
    )
    expect(deps.authorizeLocalPath).toHaveBeenCalledWith(event, {
      operation: 'file-icon',
      requestedPath: '/forged/outside/icon.png'
    })
    expect(deps.getFileIcon).toHaveBeenCalledWith('/canonical/workspace/icon.png', {
      size: 'small'
    })
    expect(deps.cache.get('/canonical/workspace/icon.png')).toBe('data:image/png;base64,abc')
  })

  it('prevents a denied secondary icon request from reaching the OS or cache', async () => {
    const deps = createDeps({
      authorizeLocalPath: vi.fn(async () => {
        throw new Error('outside owned workspace')
      })
    })
    registerFileIconHandlers(deps)

    await expect(
      handlerFor('get-file-icon')({ sender: { id: 88 } }, '/private/secret.txt')
    ).rejects.toThrow(/outside owned workspace/i)
    expect(deps.getFileIcon).not.toHaveBeenCalled()
    expect(deps.cache.size).toBe(0)
  })

  it('stores null on failure and returns cached null on subsequent calls', async () => {
    const deps = createDeps({
      getFileIcon: vi.fn(async () => {
        throw new Error('icon failure')
      })
    })
    registerFileIconHandlers(deps)

    await expect(handlerFor('get-file-icon')({}, '/tmp/missing.png')).resolves.toBeNull()
    expect(deps.cache.get('/tmp/missing.png')).toBeNull()
    expect(deps.getFileIcon).toHaveBeenCalledTimes(1)

    await expect(handlerFor('get-file-icon')({}, '/tmp/missing.png')).resolves.toBeNull()
    expect(deps.getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('returns cached null without re-fetching when injected cache already contains a miss', async () => {
    const deps = createDeps({
      cache: new Map<string, string | null>([['/tmp/already-missing.png', null]])
    })
    registerFileIconHandlers(deps)

    await expect(handlerFor('get-file-icon')({}, '/tmp/already-missing.png')).resolves.toBeNull()
    expect(deps.getFileIcon).not.toHaveBeenCalled()
  })
})

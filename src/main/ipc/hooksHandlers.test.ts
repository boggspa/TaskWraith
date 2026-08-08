import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerHooksHandlers } from './hooksHandlers'

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

describe('registerHooksHandlers', () => {
  it('rejects non-main renderer senders on hooks channels', async () => {
    const deps = {
      hooksStore: {
        getUserHooks: vi.fn(() => ({ schemaVersion: 1 as const, hooks: [] })),
        getWorkspaceHooks: vi.fn(() => ({ schemaVersion: 1 as const, hooks: [] })),
        resolveEffectiveHooks: vi.fn(() => ({
          schemaVersion: 1 as const,
          workspacePath: '/tmp/ws',
          hooks: []
        })),
        upsertHook: vi.fn(),
        deleteHook: vi.fn(),
        setEnabled: vi.fn(),
        userHooksFilePath: vi.fn(() => '/tmp/userData/hooks.json'),
        workspaceHooksFilePath: vi.fn(() => '/tmp/ws/.taskwraith/hooks.json')
      },
      revealPathInFinder: vi.fn(async () => ({ ok: true })),
      requireRegisteredWorkspace: vi.fn((path: string) => path),
      assertSenderScope: vi.fn(),
      isMainRendererSender: vi.fn(() => false),
      requireNonEmptyString: (value: unknown, label: string) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
        return value.trim()
      }
    }

    registerHooksHandlers(deps)
    const event = { sender: { id: 99 } }
    expect(() => handlerFor('hooks:get-user')(event)).toThrow(/main renderer/i)
    await expect(handlerFor('hooks:reveal-root')(event, { scope: 'user' })).rejects.toThrow(
      /main renderer/i
    )
    expect(deps.hooksStore.getUserHooks).not.toHaveBeenCalled()
  })

  it('reveals PathScope-safe user and workspace hooks.json paths', async () => {
    const registered = '/registered/ws'
    const deps = {
      hooksStore: {
        getUserHooks: vi.fn(() => ({ schemaVersion: 1 as const, hooks: [] })),
        getWorkspaceHooks: vi.fn(() => ({ schemaVersion: 1 as const, hooks: [] })),
        resolveEffectiveHooks: vi.fn(),
        upsertHook: vi.fn(),
        deleteHook: vi.fn(),
        setEnabled: vi.fn(),
        userHooksFilePath: vi.fn(() => '/tmp/userData/hooks.json'),
        workspaceHooksFilePath: vi.fn(() => `${registered}/.taskwraith/hooks.json`)
      },
      revealPathInFinder: vi.fn(async () => ({ ok: true })),
      requireRegisteredWorkspace: vi.fn(() => registered),
      assertSenderScope: vi.fn(),
      isMainRendererSender: vi.fn(() => true),
      requireNonEmptyString: (value: unknown, label: string) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
        return value.trim()
      }
    }

    registerHooksHandlers(deps)
    const event = { sender: { id: 1 } }

    const userResult = await handlerFor('hooks:reveal-root')(event, { scope: 'user' })
    expect(userResult).toEqual({ ok: true, path: '/tmp/userData/hooks.json' })
    expect(deps.revealPathInFinder).toHaveBeenCalledWith('/tmp/userData/hooks.json')

    const workspaceResult = await handlerFor('hooks:reveal-root')(event, {
      scope: 'workspace',
      workspacePath: '/alias/ws'
    })
    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/alias/ws')
    expect(deps.assertSenderScope).toHaveBeenCalledWith(event, registered)
    expect(deps.hooksStore.workspaceHooksFilePath).toHaveBeenCalledWith(registered)
    expect(workspaceResult).toEqual({
      ok: true,
      path: `${registered}/.taskwraith/hooks.json`
    })
  })

  it('falls back to revealing the parent directory when the hooks file is missing', async () => {
    const deps = {
      hooksStore: {
        getUserHooks: vi.fn(),
        getWorkspaceHooks: vi.fn(),
        resolveEffectiveHooks: vi.fn(),
        upsertHook: vi.fn(),
        deleteHook: vi.fn(),
        setEnabled: vi.fn(),
        userHooksFilePath: vi.fn(() => '/tmp/userData/hooks.json'),
        workspaceHooksFilePath: vi.fn()
      },
      revealPathInFinder: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'Path not found: /tmp/userData/hooks.json' })
        .mockResolvedValueOnce({ ok: true }),
      requireRegisteredWorkspace: vi.fn((path: string) => path),
      assertSenderScope: vi.fn(),
      isMainRendererSender: vi.fn(() => true),
      requireNonEmptyString: (value: unknown, label: string) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
        return value.trim()
      }
    }

    registerHooksHandlers(deps)
    const result = await handlerFor('hooks:reveal-root')({ sender: { id: 1 } }, { scope: 'user' })
    expect(deps.revealPathInFinder).toHaveBeenNthCalledWith(1, '/tmp/userData/hooks.json')
    expect(deps.revealPathInFinder).toHaveBeenNthCalledWith(2, '/tmp/userData')
    expect(result).toEqual({ ok: true, path: '/tmp/userData/hooks.json' })
  })
})

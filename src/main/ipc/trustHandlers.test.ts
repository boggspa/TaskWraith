import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerTrustHandlers } from './trustHandlers'
import type { TrustStatusResult, TrustWriteResult } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

function createDeps(overrides: Partial<Parameters<typeof registerTrustHandlers>[0]> = {}) {
  return {
    assertMainRendererSender: vi.fn(),
    assertSenderCanCheckWorkspaceTrust: vi.fn(),
    assertSenderCanReadTrustedSession: vi.fn(),
    checkTrust: vi.fn(
      (_workspacePath: string): TrustStatusResult => ({
        status: 'trusted'
      })
    ),
    trustWorkspace: vi.fn(
      (workspacePath: string): TrustWriteResult => ({
        ok: true,
        status: 'trusted',
        path: workspacePath
      })
    ),
    getSessionYoloMode: vi.fn(() => ({
      enabled: false,
      enabledAt: null
    })),
    setSessionYoloMode: vi.fn(),
    getTrustedSession: vi.fn(() => ({ enabled: false })),
    setTrustedSession: vi.fn((_scope, enabled) => ({ enabled })),
    ...overrides
  }
}

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

describe('registerTrustHandlers', () => {
  it('delegates trust status reads and persistent trust writes', async () => {
    const deps = createDeps()
    registerTrustHandlers(deps)
    const mainRenderer = { sender: { id: 1 } }

    expect(handlerFor('check-trust')(mainRenderer, '/repo')).toEqual({
      status: 'trusted'
    })
    expect(deps.assertSenderCanCheckWorkspaceTrust).toHaveBeenCalledWith(mainRenderer, '/repo')
    expect(deps.checkTrust).toHaveBeenCalledWith('/repo')

    expect(handlerFor('trust-workspace')(mainRenderer, '/repo')).toEqual({
      ok: true,
      status: 'trusted',
      path: '/repo'
    })
    expect(deps.assertMainRendererSender).toHaveBeenCalledWith(mainRenderer)
    expect(deps.trustWorkspace).toHaveBeenCalledWith('/repo')
  })

  it('denies a Test1 popout before it can read Test3 trust or persist Test3 trust', () => {
    const test1Popout = { sender: { id: 101 } }
    const deps = createDeps({
      assertSenderCanCheckWorkspaceTrust: vi.fn((event, workspacePath) => {
        if (event === test1Popout && workspacePath === '/Users/chrisizatt/Documents/Test 3') {
          throw new Error('Renderer workspace ownership does not match this request.')
        }
      }),
      assertMainRendererSender: vi.fn(() => {
        throw new Error('Only the main renderer can manage workspace authority.')
      })
    })
    registerTrustHandlers(deps)

    expect(() =>
      handlerFor('check-trust')(test1Popout, '/Users/chrisizatt/Documents/Test 3')
    ).toThrow('Renderer workspace ownership does not match this request.')
    expect(deps.checkTrust).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('trust-workspace')(test1Popout, '/Users/chrisizatt/Documents/Test 3')
    ).toThrow('Only the main renderer can manage workspace authority.')
    expect(deps.trustWorkspace).not.toHaveBeenCalled()
  })

  it('returns the current session yolo state', async () => {
    const deps = createDeps({
      getSessionYoloMode: vi.fn(() => ({
        enabled: true,
        enabledAt: '2026-06-27T16:00:00.000Z'
      }))
    })
    registerTrustHandlers(deps)
    const mainRenderer = { sender: { id: 1 } }

    expect(handlerFor('agentic-yolo-get')(mainRenderer)).toEqual({
      enabled: true,
      enabledAt: '2026-06-27T16:00:00.000Z'
    })
    expect(deps.assertMainRendererSender).toHaveBeenCalledWith(mainRenderer)
    expect(deps.getSessionYoloMode).toHaveBeenCalledTimes(1)
  })

  it('sets yolo mode and returns the updated session state', async () => {
    const deps = createDeps({
      getSessionYoloMode: vi.fn(() => ({
        enabled: true,
        enabledAt: '2026-06-27T16:00:00.000Z'
      }))
    })
    registerTrustHandlers(deps)
    const mainRenderer = { sender: { id: 1 } }

    expect(handlerFor('agentic-yolo-set')(mainRenderer, true)).toEqual({
      enabled: true,
      enabledAt: '2026-06-27T16:00:00.000Z'
    })
    expect(deps.assertMainRendererSender).toHaveBeenCalledWith(mainRenderer)
    expect(deps.setSessionYoloMode).toHaveBeenCalledWith(true)
    expect(deps.getSessionYoloMode).toHaveBeenCalledTimes(1)
  })

  it('returns a managed-policy blocked state from the setter without rereading', async () => {
    const deps = createDeps({
      setSessionYoloMode: vi.fn(() => ({
        enabled: false,
        enabledAt: null,
        managedBlocked: true,
        managedReason: 'Managed policy disables session YOLO.'
      }))
    })
    registerTrustHandlers(deps)
    const mainRenderer = { sender: { id: 1 } }

    expect(handlerFor('agentic-yolo-set')(mainRenderer, true)).toEqual({
      enabled: false,
      enabledAt: null,
      managedBlocked: true,
      managedReason: 'Managed policy disables session YOLO.'
    })
    expect(deps.setSessionYoloMode).toHaveBeenCalledWith(true)
    expect(deps.getSessionYoloMode).not.toHaveBeenCalled()
  })

  it('delegates scoped Full Access reads and writes', async () => {
    const deps = createDeps({
      getTrustedSession: vi.fn(() => ({
        enabled: true,
        grant: {
          chatId: 'chat-1',
          provider: 'codex' as const,
          workspacePath: '/repo',
          ensembleParticipantId: 'participant-1',
          grantedAt: '2026-07-06T09:00:00.000Z'
        }
      })),
      setTrustedSession: vi.fn((_scope, enabled) => ({ enabled }))
    })
    registerTrustHandlers(deps)
    const mainRenderer = { sender: { id: 1 } }
    const scope = {
      chatId: 'chat-1',
      provider: 'codex' as const,
      workspacePath: '/repo',
      ensembleParticipantId: 'participant-1'
    }

    expect(handlerFor('trusted-session-get')(mainRenderer, scope)).toMatchObject({
      enabled: true,
      grant: {
        chatId: 'chat-1',
        provider: 'codex',
        ensembleParticipantId: 'participant-1'
      }
    })
    expect(handlerFor('trusted-session-set')(mainRenderer, scope, false)).toEqual({
      enabled: false
    })
    expect(deps.assertSenderCanReadTrustedSession).toHaveBeenCalledWith(mainRenderer, scope)
    expect(deps.assertMainRendererSender).toHaveBeenCalledWith(mainRenderer)
    expect(deps.getTrustedSession).toHaveBeenCalledWith(scope)
    expect(deps.setTrustedSession).toHaveBeenCalledWith(scope, false)
  })

  it('allows a Test1 chat popout to read only its own Full Access scope', () => {
    const test1Popout = { sender: { id: 101 } }
    const ownScope = {
      chatId: 'test1-chat',
      provider: 'codex' as const,
      workspacePath: '/Users/chrisizatt/Documents/Test 1'
    }
    const deps = createDeps({
      assertSenderCanReadTrustedSession: vi.fn((event, scope) => {
        if (
          event !== test1Popout ||
          scope.chatId !== ownScope.chatId ||
          scope.workspacePath !== ownScope.workspacePath
        ) {
          throw new Error('Renderer cannot read another Full Access scope.')
        }
      }),
      getTrustedSession: vi.fn(() => ({ enabled: true }))
    })
    registerTrustHandlers(deps)

    expect(handlerFor('trusted-session-get')(test1Popout, ownScope)).toEqual({ enabled: true })
    expect(deps.getTrustedSession).toHaveBeenCalledWith(ownScope)
  })

  it('denies a Test1 popout from global YOLO reads or enabling YOLO or Full Access', () => {
    const test1Popout = { sender: { id: 101 } }
    const deps = createDeps({
      assertMainRendererSender: vi.fn(() => {
        throw new Error('Only the main renderer can manage workspace authority.')
      })
    })
    registerTrustHandlers(deps)
    const scope = {
      chatId: 'test1-chat',
      provider: 'codex' as const,
      workspacePath: '/Users/chrisizatt/Documents/Test 1'
    }

    expect(() => handlerFor('agentic-yolo-get')(test1Popout)).toThrow(
      'Only the main renderer can manage workspace authority.'
    )
    expect(() => handlerFor('agentic-yolo-set')(test1Popout, true)).toThrow(
      'Only the main renderer can manage workspace authority.'
    )
    expect(() => handlerFor('trusted-session-set')(test1Popout, scope, true)).toThrow(
      'Only the main renderer can manage workspace authority.'
    )
    expect(deps.getSessionYoloMode).not.toHaveBeenCalled()
    expect(deps.setSessionYoloMode).not.toHaveBeenCalled()
    expect(deps.setTrustedSession).not.toHaveBeenCalled()
  })

  it('denies a Test1 popout before disclosing another chat Full Access grant', () => {
    const test1Popout = { sender: { id: 101 } }
    const deps = createDeps({
      assertSenderCanReadTrustedSession: vi.fn(() => {
        throw new Error('Renderer cannot read another Full Access scope.')
      })
    })
    registerTrustHandlers(deps)

    expect(() =>
      handlerFor('trusted-session-get')(test1Popout, {
        chatId: 'test3-chat',
        provider: 'codex',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      })
    ).toThrow('Renderer cannot read another Full Access scope.')
    expect(deps.getTrustedSession).not.toHaveBeenCalled()
  })
})

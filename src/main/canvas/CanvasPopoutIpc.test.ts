import { describe, expect, it, vi } from 'vitest'
import { registerCanvasPopoutIpc } from './CanvasPopoutIpc'

type Handler = (event: { sender: { id: number } }, value: unknown) => unknown

function harness() {
  const handlers = new Map<string, Handler>()
  const transferRenderer = vi.fn(() => [
    {
      canvasId: 'canvas-a',
      driver: 'web' as const,
      url: 'https://example.test/',
      title: 'Example',
      status: 'active' as const,
      viewport: { width: 800, height: 600 },
      createdAt: 't0',
      updatedAt: 't0',
      presentation: 'dock' as const
    }
  ])
  const open = vi.fn(
    async (_input: unknown, beforePresent?: (senderId: number) => void | Promise<void>) => {
      await beforePresent?.(22)
      return { senderId: 22, created: true }
    }
  )
  const ownerForSender = vi.fn((senderId: number) =>
    senderId === 22 ? { chatId: 'chat-a' } : null
  )
  const closeForDock = vi.fn()
  const showInDock = vi.fn()
  const resolveContext = vi.fn((_event: unknown, chatId: string) => ({
    chatId,
    workspacePath: '/repo',
    surfaceHostId: 22
  }))
  registerCanvasPopoutIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    {
      windows: { open, ownerForSender, closeForDock },
      canvas: {
        transferRenderer,
        ownedCanvasIds: vi.fn(() => ['canvas-a'])
      },
      resolveContext,
      mainRendererSenderId: () => 1,
      showInDock
    }
  )
  const invoke = (senderId: number, channel: string, value: unknown) =>
    handlers.get(channel)!({ sender: { id: senderId } }, value)
  return {
    invoke,
    open,
    ownerForSender,
    closeForDock,
    showInDock,
    resolveContext,
    transferRenderer
  }
}

describe('registerCanvasPopoutIpc', () => {
  it('moves an owned live Browser view before presenting the pop-out', async () => {
    const h = harness()
    const result = await h.invoke(1, 'canvas:open-popout', {
      chatId: 'chat-a',
      surface: 'browser',
      session: {
        canvasId: 'canvas-a',
        kind: 'web',
        url: 'https://example.test/'
      }
    })

    expect(result).toEqual({ ok: true, senderId: 22, created: true })
    expect(h.transferRenderer).toHaveBeenCalledWith({
      canvasIds: ['canvas-a'],
      fromSenderId: 1,
      toSenderId: 22,
      context: { chatId: 'chat-a', workspacePath: '/repo', surfaceHostId: 22 },
      toSurfaceHostId: 22
    })
  })

  it('returns every pop-out-owned tab to main before focusing the dock', () => {
    const h = harness()
    const result = h.invoke(22, 'canvas:dock-popout', {
      chatId: 'chat-a',
      surface: 'browser'
    })

    expect(result).toEqual({ ok: true, canvasIds: ['canvas-a'] })
    expect(h.transferRenderer).toHaveBeenCalledWith({
      canvasIds: ['canvas-a'],
      fromSenderId: 22,
      toSenderId: 1,
      context: { chatId: 'chat-a', workspacePath: '/repo', surfaceHostId: 22 },
      presentation: 'dock'
    })
    expect(h.showInDock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-a', surface: 'browser' })
    )
    expect(h.closeForDock).toHaveBeenCalledWith(22)
  })

  it('refuses cross-chat dock requests and mismatched session kinds', async () => {
    const h = harness()
    expect(h.invoke(22, 'canvas:dock-popout', { chatId: 'chat-b', surface: 'mesh' })).toMatchObject(
      { ok: false, error: expect.stringMatching(/does not own/) }
    )
    await expect(
      h.invoke(1, 'canvas:open-popout', {
        chatId: 'chat-a',
        surface: 'mesh',
        session: { canvasId: 'canvas-a', kind: 'web' }
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/does not match/) })
  })
})

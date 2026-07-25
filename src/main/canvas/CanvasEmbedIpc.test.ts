import { describe, expect, it, vi } from 'vitest'
import { registerCanvasEmbedIpc } from './CanvasEmbedIpc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc() {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
  return {
    ipcMain: ipcMain as unknown as Parameters<typeof registerCanvasEmbedIpc>[0],
    invoke: (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender: { id: 1 } }, ...args),
    invokeAs: (senderId: number, channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender: { id: senderId } }, ...args),
    has: (channel: string) => handlers.has(channel)
  }
}

function fakeDeps() {
  const calls: Array<[string, unknown[]]> = []
  const controller = {
    open: async (input: unknown, ctx: unknown) => {
      calls.push(['open', [input, ctx]])
      return {
        canvasId: 'c1',
        url: 'http://localhost:3000/',
        title: 'T',
        viewport: { width: 800, height: 600 }
      }
    },
    close: async (id: string, ctx: unknown) => {
      calls.push(['close', [id, ctx]])
    },
    list: (ctx: unknown) => {
      calls.push(['list', [ctx]])
      return [{ canvasId: 'c1' }]
    }
  } as unknown as Parameters<typeof registerCanvasEmbedIpc>[1]['controller']
  const embed = {
    setBounds: (id: string, rect: unknown) => calls.push(['setBounds', [id, rect]]),
    setVisible: (id: string, visible: boolean) => calls.push(['setVisible', [id, visible]]),
    detach: (id: string) => calls.push(['detach', [id]])
  } as unknown as Parameters<typeof registerCanvasEmbedIpc>[1]['embed']
  const resolveContext = vi.fn((_event: unknown, chatId: string) => ({
    chatId,
    workspacePath: '/workspace/a'
  }))
  return { controller, embed, resolveContext, calls }
}

describe('registerCanvasEmbedIpc', () => {
  it('registers the canvas channels', () => {
    const ipc = fakeIpc()
    registerCanvasEmbedIpc(ipc.ipcMain, fakeDeps())
    for (const channel of [
      'canvas:open-window',
      'canvas:open-embedded',
      'canvas:open-sketch-window',
      'canvas:open-sketch-embedded',
      'canvas:set-bounds',
      'canvas:set-visible',
      'canvas:close',
      'canvas:close-chat',
      'canvas:list',
      'canvas:list-chat'
    ]) {
      expect(ipc.has(channel)).toBe(true)
    }
  })

  it('opens a standalone web canvas under canonical chat/workspace authority', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    const result = await ipc.invoke('canvas:open-window', {
      url: 'http://localhost:5173',
      chatId: 'chat-a'
    })

    expect(result).toMatchObject({ ok: true, canvasId: 'c1' })
    expect(deps.calls.find((call) => call[0] === 'open')?.[1]).toEqual([
      expect.objectContaining({
        driver: 'web',
        embed: false,
        url: 'http://localhost:5173'
      }),
      { chatId: 'chat-a', workspacePath: '/workspace/a' }
    ])
    expect(deps.resolveContext).toHaveBeenCalledTimes(2)
  })

  it('requires an exact chat id for embedded opens', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    await expect(
      ipc.invoke('canvas:open-embedded', {
        url: 'http://localhost:3000',
        chatId: 'chat-a'
      })
    ).resolves.toMatchObject({ ok: true, canvasId: 'c1' })
    const missing = await ipc.invoke('canvas:open-embedded', {
      url: 'http://localhost:3000'
    })
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/canonical chat/) })
  })

  it('opens a standalone sketch under the same canonical authority', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    const result = await ipc.invoke('canvas:open-sketch-window', { chatId: 'chat-a' })
    expect(result).toMatchObject({ ok: true, canvasId: 'c1' })
    expect(deps.calls.find((call) => call[0] === 'open')?.[1]).toEqual([
      { driver: 'sketch', embed: false },
      { chatId: 'chat-a', workspacePath: '/workspace/a' }
    ])
  })

  it('opens an embedded sketch for the right-dock canvas panel', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    const result = await ipc.invoke('canvas:open-sketch-embedded', { chatId: 'chat-a' })
    expect(result).toMatchObject({ ok: true, canvasId: 'c1' })
    expect(deps.calls.find((call) => call[0] === 'open')?.[1]).toEqual([
      { driver: 'sketch', embed: true },
      { chatId: 'chat-a', workspacePath: '/workspace/a' }
    ])
  })

  it('lists every canvas in the chat under resolved authority', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    expect(await ipc.invoke('canvas:list-chat', 'chat-a')).toEqual([{ canvasId: 'c1' }])
    expect(deps.calls).toContainEqual([
      'list',
      [{ chatId: 'chat-a', workspacePath: '/workspace/a' }]
    ])
    expect(() => ipc.invoke('canvas:list-chat', '')).toThrow(/canonical chat/)
    expect(() => ipc.invoke('canvas:list-chat', 42)).toThrow(/canonical chat/)
  })

  it('closes a chat canvas only when the controller accepts the close', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    await ipc.invoke('canvas:close-chat', 'chat-a', 'agent-canvas')
    expect(deps.calls).toContainEqual([
      'close',
      ['agent-canvas', { chatId: 'chat-a', workspacePath: '/workspace/a' }]
    ])
    expect(deps.calls).toContainEqual(['detach', ['agent-canvas']])
  })

  it('never detaches when a cross-chat close is rejected', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    ;(deps.controller as { close: unknown }).close = async () => {
      throw new Error('Canvas session not found for this chat.')
    }
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    await expect(ipc.invoke('canvas:close-chat', 'chat-b', 'foreign-canvas')).rejects.toThrow(
      /not found/
    )
    expect(deps.calls.some((call) => call[0] === 'detach')).toBe(false)
  })

  it('returns a normal error result when navigation fails', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    ;(deps.controller as { open: unknown }).open = async () => {
      throw new Error('Navigation failed (-102): ERR_CONNECTION_REFUSED')
    }
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    const result = await ipc.invoke('canvas:open-embedded', {
      url: 'http://localhost:3000',
      chatId: 'chat-a'
    })
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('ERR_CONNECTION_REFUSED')
    })
  })

  it('re-authorizes ownership for bounds, visibility, close, and list', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:open-embedded', {
      url: 'http://localhost:3000',
      chatId: 'chat-a'
    })
    await ipc.invoke('canvas:set-bounds', 'c1', { x: 1, y: 2, width: 3, height: 4 })
    await ipc.invoke('canvas:set-visible', 'c1', false)
    expect(await ipc.invoke('canvas:list')).toEqual([{ canvasId: 'c1' }])
    await ipc.invoke('canvas:close', 'c1')

    expect(deps.calls).toContainEqual([
      'setBounds',
      ['c1', { x: 1, y: 2, width: 3, height: 4 }]
    ])
    expect(deps.calls).toContainEqual(['setVisible', ['c1', false]])
    expect(deps.calls).toContainEqual([
      'close',
      ['c1', { chatId: 'chat-a', workspacePath: '/workspace/a' }]
    ])
    expect(deps.calls).toContainEqual(['detach', ['c1']])
    expect(await ipc.invoke('canvas:list')).toEqual([])
  })

  it('does not delegate malformed ids and rejects a different sender', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:set-bounds', 42, { x: 0 })
    await ipc.invoke('canvas:close', null)
    expect(deps.calls.some((call) => call[0] === 'setBounds' || call[0] === 'close')).toBe(false)

    await ipc.invoke('canvas:open-window', {
      url: 'http://localhost:3000',
      chatId: 'chat-a'
    })
    expect(() => ipc.invokeAs(2, 'canvas:set-visible', 'c1', true)).toThrow(/does not own/)
  })

  it('closes and detaches a late open when post-navigation authority changed', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    deps.resolveContext
      .mockReturnValueOnce({ chatId: 'chat-a', workspacePath: '/workspace/a' })
      .mockImplementationOnce(() => {
        throw new Error('Chat was deleted')
      })
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    const result = await ipc.invoke('canvas:open-window', {
      url: 'http://localhost:3000',
      chatId: 'chat-a'
    })
    expect(result).toMatchObject({ ok: false, error: 'Chat was deleted' })
    expect(deps.calls).toContainEqual([
      'close',
      ['c1', { chatId: 'chat-a', workspacePath: '/workspace/a' }]
    ])
    expect(deps.calls).toContainEqual(['detach', ['c1']])
  })

  it('invalidates exact authorities and tracks only still-owned chat ids', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    const authority = registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:open-window', {
      url: 'http://localhost:3000',
      chatId: 'chat-a'
    })
    expect(authority.openChatIds()).toEqual(new Set(['chat-a']))
    expect(authority.invalidateAuthorities({ chatIds: ['chat-a'] })).toEqual(['c1'])
    expect(authority.openChatIds()).toEqual(new Set())
    expect(deps.calls).toContainEqual(['detach', ['c1']])
  })
})

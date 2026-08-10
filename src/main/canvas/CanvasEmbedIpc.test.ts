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
      return [
        {
          canvasId: 'c1',
          driver: 'web',
          url: 'http://localhost:3000/',
          title: 'T',
          status: 'active',
          viewport: { width: 800, height: 600 },
          createdAt: 't0',
          updatedAt: 't0',
          presentation: 'dock'
        }
      ]
    },
    status: (_id: string, ctx: unknown) => {
      calls.push(['status', [ctx]])
      return {
        canvasId: 'c1',
        driver: 'web',
        url: 'http://localhost:3000/',
        title: 'T',
        status: 'active',
        viewport: { width: 800, height: 600 },
        createdAt: 't0',
        updatedAt: 't0',
        presentation: 'dock'
      }
    },
    getChartDocument: (id: string, ctx: unknown) => {
      calls.push(['getChartDocument', [id, ctx]])
      if (id !== 'chart-1') return null
      return {
        schemaVersion: 1,
        title: 'Latency',
        kind: 'line',
        series: [{ id: 'p50', label: 'p50', points: [{ x: 0, y: 1 }] }]
      }
    },
    navigate: async (id: string, input: unknown, ctx: unknown, opts: unknown) => {
      calls.push(['navigate', [id, input, ctx, opts]])
      return {
        url: 'https://example.test/settled',
        title: 'Settled',
        isLoading: false,
        canGoBack: true,
        canGoForward: false
      }
    }
  } as unknown as Parameters<typeof registerCanvasEmbedIpc>[1]['controller']
  const embed = {
    has: (id: string) => id === 'c1',
    setBounds: (id: string, rect: unknown) => calls.push(['setBounds', [id, rect]]),
    setVisible: (id: string, visible: boolean) => calls.push(['setVisible', [id, visible]]),
    detach: (id: string) => calls.push(['detach', [id]])
  } as unknown as Parameters<typeof registerCanvasEmbedIpc>[1]['embed']
  const resolveContext = vi.fn((_event: unknown, chatId: string) => ({
    chatId,
    workspacePath: '/workspace/a'
  }))
  const clearBrowserProfile = vi.fn(async () => ({
    closedCanvasIds: ['c1'],
    closedSurfaceCount: 1
  }))
  return { controller, embed, clearBrowserProfile, resolveContext, calls }
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
      'canvas:adopt-embedded',
      'canvas:set-bounds',
      'canvas:set-visible',
      'canvas:close',
      'canvas:close-chat',
      'canvas:clear-browser-profile',
      'canvas:navigate-chat',
      'canvas:list',
      'canvas:list-chat',
      'canvas:chart-document'
    ]) {
      expect(ipc.has(channel)).toBe(true)
    }
  })

  it('returns a chat-scoped chart document for TelemetryPane without pixels', () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    expect(ipc.invoke('canvas:chart-document', 'chat-a', 'chart-1')).toEqual({
      schemaVersion: 1,
      title: 'Latency',
      kind: 'line',
      series: [{ id: 'p50', label: 'p50', points: [{ x: 0, y: 1 }] }]
    })
    expect(deps.calls.find((call) => call[0] === 'getChartDocument')?.[1]).toEqual([
      'chart-1',
      { chatId: 'chat-a', workspacePath: '/workspace/a' }
    ])

    expect(ipc.invoke('canvas:chart-document', 'chat-a', 'missing')).toBeNull()
    expect(ipc.invoke('canvas:chart-document', 'chat-a', '')).toBeNull()
    expect(() => ipc.invoke('canvas:chart-document', '', 'chart-1')).toThrow(/canonical chat/)
  })

  it('clears the app-wide Browser profile as a human action and retires closed embeds', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:open-embedded', {
      url: 'https://example.test',
      chatId: 'chat-a'
    })

    await expect(ipc.invoke('canvas:clear-browser-profile')).resolves.toEqual({
      ok: true,
      closedSurfaceCount: 1
    })
    expect(deps.clearBrowserProfile).toHaveBeenCalledTimes(1)
    expect(deps.calls).toContainEqual(['detach', ['c1']])
    expect(await ipc.invoke('canvas:list')).toEqual([])
  })

  it('returns a normal reset error and preserves a still-live owned surface', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    deps.clearBrowserProfile.mockRejectedValueOnce(new Error('storage busy'))
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:open-embedded', {
      url: 'https://example.test',
      chatId: 'chat-a'
    })

    await expect(ipc.invoke('canvas:clear-browser-profile')).resolves.toEqual({
      ok: false,
      error: 'storage busy'
    })
    expect(await ipc.invoke('canvas:list')).toHaveLength(1)
  })

  it('navigates any chat canvas as the human, unmetered, with sanitized input', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    const result = await ipc.invoke('canvas:navigate-chat', 'chat-a', 'c1', {
      url: '  https://example.test/page  '
    })
    expect(result).toMatchObject({ ok: true, url: 'https://example.test/settled', canGoBack: true })
    expect(deps.calls.find((call) => call[0] === 'navigate')?.[1]).toEqual([
      'c1',
      { url: 'https://example.test/page' },
      { chatId: 'chat-a', workspacePath: '/workspace/a' },
      { chargeInteraction: false }
    ])

    const back = await ipc.invoke('canvas:navigate-chat', 'chat-a', 'c1', { action: 'back' })
    expect(back).toMatchObject({ ok: true })
    expect(deps.calls.filter((call) => call[0] === 'navigate').at(-1)?.[1]).toEqual([
      'c1',
      { action: 'back' },
      { chatId: 'chat-a', workspacePath: '/workspace/a' },
      { chargeInteraction: false }
    ])
  })

  it('navigate-chat fails closed on bad ids, bad actions, and thrown authority errors', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await expect(
      ipc.invoke('canvas:navigate-chat', 'chat-a', 7, { action: 'back' })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      ipc.invoke('canvas:navigate-chat', 'chat-a', 'c1', { action: 'teleport' })
    ).resolves.toMatchObject({ ok: false })
    await expect(ipc.invoke('canvas:navigate-chat', 'chat-a', 'c1', {})).resolves.toMatchObject({
      ok: false
    })
    // A cross-chat canvasId throws inside the controller; the handler returns a
    // result-shaped error instead of rejecting the invoke.
    ;(deps.controller as { navigate: unknown }).navigate = async () => {
      throw new Error('No open canvas with id "c1". Call canvas_open first.')
    }
    await expect(
      ipc.invoke('canvas:navigate-chat', 'chat-a', 'c1', { action: 'back' })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/No open canvas/) })
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

    expect(await ipc.invoke('canvas:list-chat', 'chat-a')).toEqual([
      expect.objectContaining({ canvasId: 'c1', presentation: 'dock' })
    ])
    expect(deps.calls).toContainEqual([
      'list',
      [{ chatId: 'chat-a', workspacePath: '/workspace/a' }]
    ])
    expect(() => ipc.invoke('canvas:list-chat', '')).toThrow(/canonical chat/)
    expect(() => ipc.invoke('canvas:list-chat', 42)).toThrow(/canonical chat/)
  })

  it('adopts an agent-opened dock canvas under exact renderer and chat authority', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    const adopted = await ipc.invoke('canvas:adopt-embedded', {
      chatId: 'chat-a',
      canvasId: 'c1'
    })

    expect(adopted).toMatchObject({ ok: true, canvasId: 'c1', presentation: 'dock' })
    await ipc.invoke('canvas:set-bounds', 'c1', { x: 1, y: 2, width: 3, height: 4 })
    expect(deps.calls).toContainEqual(['setBounds', ['c1', { x: 1, y: 2, width: 3, height: 4 }]])
    expect(await ipc.invoke('canvas:list')).toEqual([
      expect.objectContaining({ canvasId: 'c1', presentation: 'dock' })
    ])
  })

  it('refuses to adopt a canvas without a live embedded surface', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    ;(deps.embed as { has: (id: string) => boolean }).has = () => false
    registerCanvasEmbedIpc(ipc.ipcMain, deps)

    expect(ipc.invoke('canvas:adopt-embedded', { chatId: 'chat-a', canvasId: 'c1' })).toMatchObject(
      {
        ok: false,
        error: expect.stringMatching(/embedded/i)
      }
    )
    expect(await ipc.invoke('canvas:list')).toEqual([])
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
    expect(await ipc.invoke('canvas:list')).toEqual([
      expect.objectContaining({ canvasId: 'c1', presentation: 'dock' })
    ])
    await ipc.invoke('canvas:close', 'c1')

    expect(deps.calls).toContainEqual(['setBounds', ['c1', { x: 1, y: 2, width: 3, height: 4 }]])
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

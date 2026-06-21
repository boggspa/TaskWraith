import { describe, it, expect } from 'vitest'
import { registerCanvasEmbedIpc } from './CanvasEmbedIpc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc() {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
  return {
    ipcMain: ipcMain as unknown as Parameters<typeof registerCanvasEmbedIpc>[0],
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
    has: (channel: string) => handlers.has(channel)
  }
}

function fakeDeps() {
  const calls: Array<[string, unknown[]]> = []
  const controller = {
    open: async (input: unknown) => {
      calls.push(['open', [input]])
      return { canvasId: 'c1', url: 'http://localhost:3000/', title: 'T', viewport: { width: 800, height: 600 } }
    },
    close: async (id: string) => {
      calls.push(['close', [id]])
    },
    list: () => {
      calls.push(['list', []])
      return [{ canvasId: 'c1' }]
    }
  } as unknown as Parameters<typeof registerCanvasEmbedIpc>[1]['controller']
  const embed = {
    setBounds: (id: string, rect: unknown) => calls.push(['setBounds', [id, rect]]),
    setVisible: (id: string, v: boolean) => calls.push(['setVisible', [id, v]])
  } as unknown as Parameters<typeof registerCanvasEmbedIpc>[1]['embed']
  return { controller, embed, calls }
}

describe('registerCanvasEmbedIpc', () => {
  it('registers the five canvas channels', () => {
    const ipc = fakeIpc()
    registerCanvasEmbedIpc(ipc.ipcMain, fakeDeps())
    for (const ch of ['canvas:open-embedded', 'canvas:set-bounds', 'canvas:set-visible', 'canvas:close', 'canvas:list']) {
      expect(ipc.has(ch)).toBe(true)
    }
  })

  it('open-embedded forces driver:web + embed:true and returns the handle', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    const result = await ipc.invoke('canvas:open-embedded', { url: 'http://localhost:3000' })
    expect(result).toEqual({
      ok: true,
      canvasId: 'c1',
      url: 'http://localhost:3000/',
      title: 'T',
      viewport: { width: 800, height: 600 }
    })
    const openCall = deps.calls.find((c) => c[0] === 'open')!
    expect(openCall[1][0]).toMatchObject({ driver: 'web', embed: true, url: 'http://localhost:3000' })
  })

  it('open-embedded returns { ok:false, error } instead of throwing on a failed open', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    ;(deps.controller as { open: unknown }).open = async () => {
      throw new Error('Navigation failed (-102): ERR_CONNECTION_REFUSED')
    }
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    const result = (await ipc.invoke('canvas:open-embedded', { url: 'http://localhost:3000' })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ERR_CONNECTION_REFUSED')
  })

  it('set-bounds / set-visible delegate to the embed controller for a string id', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:set-bounds', 'c1', { x: 1, y: 2, width: 3, height: 4 })
    await ipc.invoke('canvas:set-visible', 'c1', false)
    expect(deps.calls).toContainEqual(['setBounds', ['c1', { x: 1, y: 2, width: 3, height: 4 }]])
    expect(deps.calls).toContainEqual(['setVisible', ['c1', false]])
  })

  it('ignores a non-string canvasId (no delegation)', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:set-bounds', 42, { x: 0 })
    await ipc.invoke('canvas:close', null)
    expect(deps.calls.some((c) => c[0] === 'setBounds' || c[0] === 'close')).toBe(false)
  })

  it('close + list delegate to the controller', async () => {
    const ipc = fakeIpc()
    const deps = fakeDeps()
    registerCanvasEmbedIpc(ipc.ipcMain, deps)
    await ipc.invoke('canvas:close', 'c1')
    const list = await ipc.invoke('canvas:list')
    expect(deps.calls).toContainEqual(['close', ['c1']])
    expect(list).toEqual([{ canvasId: 'c1' }])
  })
})

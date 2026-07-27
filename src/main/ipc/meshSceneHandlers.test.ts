import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerMeshSceneHandlers } from './meshSceneHandlers'

describe('registerMeshSceneHandlers', () => {
  it('only projects scene data through the caller’s resolved chat authority', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const controller = {
      listForChat: vi.fn(() => [{ sceneId: 'scene-a' }]),
      viewForChat: vi.fn(() => ({ id: 'scene-a', assetUrls: {} })),
      closePresentation: vi.fn(() => ({ id: 'scene-a' })),
      remove: vi.fn(() => 'scene-a'),
      importUserSelectedModel: vi.fn()
    }
    const resolveContext = vi.fn((_event: IpcMainInvokeEvent, chatId: string) => ({
      chatId,
      workspacePath: '/workspace'
    }))
    registerMeshSceneHandlers(ipcMain, {
      controller: controller as never,
      resolveContext,
      getRequestingWindow: vi.fn(() => ({}) as BrowserWindow),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
    })

    const event = {} as IpcMainInvokeEvent
    expect(await handlers.get('mesh-scene:list-chat')?.(event, 'chat-a')).toEqual([
      { sceneId: 'scene-a' }
    ])
    expect(await handlers.get('mesh-scene:view')?.(event, 'chat-a', 'scene-a')).toEqual({
      id: 'scene-a',
      assetUrls: {}
    })
    expect(await handlers.get('mesh-scene:close-presentation')?.(event, 'chat-a', 'scene-a')).toEqual({
      id: 'scene-a'
    })
    expect(await handlers.get('mesh-scene:delete')?.(event, 'chat-a', 'scene-a')).toBe('scene-a')
    expect(resolveContext).toHaveBeenCalledWith(event, 'chat-a')
    expect(controller.viewForChat).toHaveBeenCalledWith('scene-a', 'chat-a')
    expect(controller.closePresentation).toHaveBeenCalledWith('scene-a', {
      chatId: 'chat-a',
      workspacePath: '/workspace'
    })
    expect(controller.remove).toHaveBeenCalledWith('scene-a', {
      chatId: 'chat-a',
      workspacePath: '/workspace'
    })
  })

  it('rejects malformed chat and scene identities before a controller call', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const controller = {
      listForChat: vi.fn(),
      viewForChat: vi.fn(),
      closePresentation: vi.fn(),
      remove: vi.fn(),
      importUserSelectedModel: vi.fn()
    }
    registerMeshSceneHandlers(ipcMain, {
      controller: controller as never,
      resolveContext: () => ({ chatId: 'chat-a' }),
      getRequestingWindow: vi.fn(() => ({}) as BrowserWindow),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
    })

    expect(() => handlers.get('mesh-scene:list-chat')?.({} as IpcMainInvokeEvent, ' chat-a ')).toThrow(
      /canonical chat/
    )
    expect(() => handlers.get('mesh-scene:view')?.({} as IpcMainInvokeEvent, 'chat-a', ' ')).toThrow(
      /scene id/
    )
    expect(controller.listForChat).not.toHaveBeenCalled()
    expect(controller.viewForChat).not.toHaveBeenCalled()
  })

  it('imports only a native-picker-selected scene root into the caller chat without reflecting its path', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      })
    } as unknown as IpcMain
    const controller = {
      listForChat: vi.fn(),
      viewForChat: vi.fn(),
      closePresentation: vi.fn(),
      remove: vi.fn(),
      importUserSelectedModel: vi.fn(() => ({
        id: 'scene-imported',
        title: 'world',
        nodes: [{ kind: 'import' }],
        backgroundColor: '#171a21',
        updatedAt: '2026-07-27T12:00:00.000Z'
      }))
    }
    const resolveContext = vi.fn((_event: IpcMainInvokeEvent, chatId: string) => ({
      chatId,
      workspacePath: '/workspace'
    }))
    const window = {} as BrowserWindow
    const showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: ['/Users/artist/Downloads/world.glb']
    }))
    registerMeshSceneHandlers(ipcMain, {
      controller: controller as never,
      resolveContext,
      getRequestingWindow: vi.fn(() => window),
      showOpenDialog
    })

    const imported = await handlers.get('mesh-scene:import-user-model')?.(
      {} as IpcMainInvokeEvent,
      'chat-a'
    )

    expect(showOpenDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        title: 'Import a 3D scene or model into Mesh Canvas',
        properties: ['openFile'],
        filters: expect.arrayContaining([
          expect.objectContaining({
            name: '3D scenes and models',
            extensions: ['glb', 'gltf', 'obj']
          })
        ])
      })
    )
    expect(controller.importUserSelectedModel).toHaveBeenCalledWith(
      { sourcePath: '/Users/artist/Downloads/world.glb' },
      { chatId: 'chat-a', workspacePath: '/workspace' }
    )
    expect(imported).toEqual({
      canceled: false,
      scene: {
        sceneId: 'scene-imported',
        title: 'world',
        nodeCount: 1,
        importCount: 1,
        primitiveCount: 0,
        backgroundColor: '#171a21',
        updatedAt: '2026-07-27T12:00:00.000Z'
      }
    })
    expect(JSON.stringify(imported)).not.toContain('/Users/artist/Downloads/world.glb')
    expect(resolveContext).toHaveBeenCalledTimes(2)
  })
})

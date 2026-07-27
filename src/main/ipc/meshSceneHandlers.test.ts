import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
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
      remove: vi.fn(() => 'scene-a')
    }
    const resolveContext = vi.fn((_event: IpcMainInvokeEvent, chatId: string) => ({
      chatId,
      workspacePath: '/workspace'
    }))
    registerMeshSceneHandlers(ipcMain, { controller: controller as never, resolveContext })

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
      remove: vi.fn()
    }
    registerMeshSceneHandlers(ipcMain, {
      controller: controller as never,
      resolveContext: () => ({ chatId: 'chat-a' })
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
})

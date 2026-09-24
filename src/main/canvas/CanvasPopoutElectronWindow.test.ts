import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

import { canvasPopoutRendererQuery } from './CanvasPopoutElectronWindow'

describe('canvasPopoutRendererQuery', () => {
  it('serializes the exact chat, surface, and optional transferred session', () => {
    expect(
      canvasPopoutRendererQuery({
        chatId: 'chat-a',
        surface: 'browser',
        session: {
          canvasId: 'canvas-a',
          kind: 'web',
          url: 'https://example.test/',
          title: 'Example'
        }
      })
    ).toEqual({
      popout: 'canvas',
      chat: 'chat-a',
      surface: 'browser',
      canvas: 'canvas-a',
      canvasKind: 'web'
    })
  })

  it('keeps renderer-native surfaces session-free', () => {
    expect(canvasPopoutRendererQuery({ chatId: 'chat-a', surface: 'mesh' })).toEqual({
      popout: 'canvas',
      chat: 'chat-a',
      surface: 'mesh'
    })
  })
})

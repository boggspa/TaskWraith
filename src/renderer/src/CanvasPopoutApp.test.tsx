import { describe, expect, it } from 'vitest'
import { parseCanvasPopoutRequest } from './CanvasPopoutApp'

describe('parseCanvasPopoutRequest', () => {
  it('decodes a transferred live Browser tab', () => {
    expect(
      parseCanvasPopoutRequest(
        new URLSearchParams(
          'chat=chat-a&surface=browser&canvas=canvas-a&canvasKind=web&url=https%3A%2F%2Fexample.test%2F&title=Example'
        )
      )
    ).toEqual({
      chatId: 'chat-a',
      surface: 'browser',
      session: {
        canvasId: 'canvas-a',
        kind: 'web',
        url: 'https://example.test/',
        title: 'Example'
      }
    })
  })

  it('decodes a transferred live Emulator session without replacing its canvas id', () => {
    expect(
      parseCanvasPopoutRequest(
        new URLSearchParams(
          'chat=chat-a&surface=emulator&canvas=canvas-emulator-a&canvasKind=emulator'
        )
      )
    ).toEqual({
      chatId: 'chat-a',
      surface: 'emulator',
      session: { canvasId: 'canvas-emulator-a', kind: 'emulator' }
    })
  })

  it('accepts renderer-native surfaces without a CanvasService session', () => {
    expect(parseCanvasPopoutRequest(new URLSearchParams('chat=chat-a&surface=mesh'))).toEqual({
      chatId: 'chat-a',
      surface: 'mesh'
    })
    expect(parseCanvasPopoutRequest(new URLSearchParams('chat=chat-a&surface=simulator'))).toEqual({
      chatId: 'chat-a',
      surface: 'simulator'
    })
    expect(parseCanvasPopoutRequest(new URLSearchParams('chat=chat-a&surface=media'))).toEqual({
      chatId: 'chat-a',
      surface: 'media'
    })
  })

  it('fails closed on missing authority or unknown surfaces', () => {
    expect(parseCanvasPopoutRequest(new URLSearchParams('surface=browser'))).toBeNull()
    expect(parseCanvasPopoutRequest(new URLSearchParams('chat=chat-a&surface=terminal'))).toBeNull()
    expect(parseCanvasPopoutRequest(new URLSearchParams('chat=chat-a&surface=emulator'))).toBeNull()
    expect(
      parseCanvasPopoutRequest(
        new URLSearchParams('chat=chat-a&surface=emulator&canvas=canvas-a&canvasKind=web')
      )
    ).toBeNull()
  })
})

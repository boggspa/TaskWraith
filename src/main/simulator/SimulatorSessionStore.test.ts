import { describe, expect, it } from 'vitest'
import { SimulatorSessionStore } from './SimulatorSessionStore'

describe('SimulatorSessionStore', () => {
  it('upserts chat-scoped session preview state that survives across runs', () => {
    const store = new SimulatorSessionStore({ now: () => '2026-08-08T00:00:00.000Z' })
    expect(store.get('chat-a')).toBeNull()

    const first = store.upsert('chat-a', {
      udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
      simulatorAppOpen: true,
      ownedSimulatorPid: 4242
    })
    expect(first).toMatchObject({
      chatId: 'chat-a',
      udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
      simulatorAppOpen: true,
      ownedSimulatorPid: 4242,
      updatedAt: '2026-08-08T00:00:00.000Z'
    })

    const withFrame = store.upsert('chat-a', {
      lastFrame: {
        width: 780,
        height: 1688,
        pointWidth: 390,
        pointHeight: 844,
        capturedAt: '2026-08-08T00:00:01.000Z',
        udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
      }
    })
    expect(withFrame.lastFrame?.width).toBe(780)
    expect(withFrame.lastFrame?.pointWidth).toBe(390)
    expect(withFrame.lastFrame?.pointHeight).toBe(844)
    expect(withFrame.udid).toBe('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(store.get('chat-a')).toEqual(withFrame)
  })

  it('keeps chats isolated and clear removes only the named chat', () => {
    const store = new SimulatorSessionStore({ now: () => 't' })
    store.upsert('chat-a', { udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' })
    store.upsert('chat-b', { udid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB' })
    store.clear('chat-a')
    expect(store.get('chat-a')).toBeNull()
    expect(store.get('chat-b')?.udid).toBe('BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB')
  })

  it('stores last absolute orientation for chat-scoped rotate UI sync', () => {
    const store = new SimulatorSessionStore({ now: () => 't' })
    expect(store.get('chat-a')?.orientation).toBeUndefined()

    const updated = store.upsert('chat-a', { orientation: 'LANDSCAPE_RIGHT' })
    expect(updated.orientation).toBe('LANDSCAPE_RIGHT')
    expect(store.get('chat-a')?.orientation).toBe('LANDSCAPE_RIGHT')

    store.upsert('chat-a', { orientation: 'PORTRAIT_UPSIDE_DOWN' })
    expect(store.get('chat-a')?.orientation).toBe('PORTRAIT_UPSIDE_DOWN')
  })
})

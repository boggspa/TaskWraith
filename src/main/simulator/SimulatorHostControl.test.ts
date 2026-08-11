import { describe, expect, it, vi } from 'vitest'
import { SimulatorControllerLease } from './SimulatorControllerLease'
import { SimulatorHostControl, SIMULATOR_CONTROLLER_REQUIRED } from './SimulatorHostControl'
import { SimulatorSessionStore } from './SimulatorSessionStore'

const UDID = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'

describe('SimulatorHostControl', () => {
  it('rejects mutating verbs without a valid controller token', async () => {
    const host = {
      status: vi.fn(),
      openSimulatorApp: vi.fn(async () => ({ ok: true })),
      listDevices: vi.fn(),
      boot: vi.fn(async () => ({ ok: true, udid: UDID })),
      install: vi.fn(async () => ({ ok: true, udid: UDID })),
      launch: vi.fn(async () => ({ ok: true, udid: UDID })),
      terminate: vi.fn(async () => ({ ok: true, udid: UDID })),
      screenshot: vi.fn(async () => ({ ok: true, udid: UDID })),
      pasteboardSync: vi.fn(async () => ({ ok: true, udid: UDID })),
      getOwnedSimulatorPid: vi.fn(() => null)
    }
    const gate = new SimulatorHostControl({
      host,
      controllerLease: new SimulatorControllerLease(),
      sessionStore: new SimulatorSessionStore()
    })

    const denied = await gate.boot(UDID, { chatId: 'chat-a', controllerTokenId: 'missing' })
    expect(denied).toEqual({ ok: false, error: SIMULATOR_CONTROLLER_REQUIRED })
    expect(host.boot).not.toHaveBeenCalled()

    const deniedPasteboard = await gate.pasteboardSync(UDID, 'host-to-sim', {
      chatId: 'chat-a',
      controllerTokenId: 'missing'
    })
    expect(deniedPasteboard).toEqual({ ok: false, error: SIMULATOR_CONTROLLER_REQUIRED })
    expect(host.pasteboardSync).not.toHaveBeenCalled()
  })

  it('allows mutate + session upsert when the calling run holds the lease', async () => {
    const host = {
      status: vi.fn(),
      openSimulatorApp: vi.fn(async () => ({ ok: true, udid: UDID })),
      listDevices: vi.fn(),
      boot: vi.fn(async () => ({ ok: true, udid: UDID })),
      install: vi.fn(async () => ({ ok: true, udid: UDID })),
      launch: vi.fn(async () => ({ ok: true, udid: UDID })),
      terminate: vi.fn(async () => ({ ok: true, udid: UDID })),
      screenshot: vi.fn(async () => ({
        ok: true,
        udid: UDID,
        frame: {
          pngBase64: 'aa',
          width: 2,
          height: 2,
          pointWidth: 1,
          pointHeight: 1,
          capturedAt: 't',
          udid: UDID
        }
      })),
      pasteboardSync: vi.fn(async () => ({ ok: true, udid: UDID })),
      getOwnedSimulatorPid: vi.fn(() => 99)
    }
    const lease = new SimulatorControllerLease({ createId: () => 'tok-1' })
    const sessions = new SimulatorSessionStore({ now: () => 'now' })
    const gate = new SimulatorHostControl({ host, controllerLease: lease, sessionStore: sessions })
    const minted = lease.mint({ chatId: 'chat-a', runId: 'run-1' })
    expect(minted.ok).toBe(true)
    if (!minted.ok) return
    const control = { chatId: 'chat-a', controllerTokenId: minted.token.tokenId }

    expect((await gate.boot(UDID, control)).ok).toBe(true)
    expect(sessions.get('chat-a')?.udid).toBe(UDID)

    expect((await gate.openSimulatorApp(control)).ok).toBe(true)
    expect(sessions.get('chat-a')?.simulatorAppOpen).toBe(true)
    expect(sessions.get('chat-a')?.ownedSimulatorPid).toBe(99)

    // Screenshot remains readable without a controller.
    expect((await gate.screenshot(UDID, { chatId: 'chat-a' })).ok).toBe(true)
    expect(sessions.get('chat-a')?.lastFrame?.width).toBe(2)
    expect(sessions.get('chat-a')?.lastFrame?.pointWidth).toBe(1)
    expect(sessions.get('chat-a')?.lastFrame?.pointHeight).toBe(1)

    // Pasteboard sync delegates with the exact direction once the lease holds.
    expect((await gate.pasteboardSync(UDID, 'sim-to-host', control)).ok).toBe(true)
    expect(host.pasteboardSync).toHaveBeenCalledWith(UDID, 'sim-to-host')
  })
})

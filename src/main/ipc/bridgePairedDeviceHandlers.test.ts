import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  BRIDGE_LIST_PAIRED_DEVICES_CHANNEL,
  BRIDGE_UNPAIR_DEVICE_CHANNEL,
  registerBridgePairedDeviceHandlers,
  unregisterBridgePairedDeviceHandlers,
  type BridgePairedDeviceHandlerDeps,
  type BridgePairedDeviceRuntime
} from './bridgePairedDeviceHandlers'
import type { PairedDeviceSummary } from '../remote/RemoteBridgeRuntime'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

const EVENT = { sender: { id: 1 } }
const PAIRING_OFF_ERROR =
  'Remote iOS pairing is off — enable it in Settings → Devices, then restart.'

function handlerFor(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = handlers.get(channel)
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function deviceFixture(overrides: Partial<PairedDeviceSummary> = {}): PairedDeviceSummary {
  return {
    iphoneIdentityPubKey: 'device-key-1',
    pairId: 'pair-1',
    controllerDisplayName: "Chris's iPhone",
    pairedAt: '2026-09-05T18:00:00.000Z',
    connected: true,
    ...overrides
  }
}

type ListMock = Mock<() => PairedDeviceSummary[]>
type UnpairMock = Mock<(iphoneIdentityPubKey: string) => void>
type RemoveTokenMock = Mock<(pairId: string) => void>

interface Harness {
  deps: BridgePairedDeviceHandlerDeps
  runtime: BridgePairedDeviceRuntime
  list: ListMock
  unpair: UnpairMock
  removeApnsToken: RemoveTokenMock
  setRuntime: (runtime: BridgePairedDeviceRuntime | null) => void
}

function harness(withTokenStore = true): Harness {
  const list: ListMock = vi.fn(() => [deviceFixture()])
  const unpair: UnpairMock = vi.fn()
  const runtime: BridgePairedDeviceRuntime = { listPairedDevices: list, unpair }
  let current: BridgePairedDeviceRuntime | null = runtime
  const removeApnsToken: RemoveTokenMock = vi.fn()
  const deps: BridgePairedDeviceHandlerDeps = {
    getIosRemoteRuntime: () => current,
    ...(withTokenStore ? { removeApnsToken } : {})
  }
  registerBridgePairedDeviceHandlers(deps)
  return { deps, runtime, list, unpair, removeApnsToken, setRuntime: (next) => (current = next) }
}

describe('bridge paired-device handlers', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('registers exactly the list/unpair channels', () => {
    harness()
    expect([...handlers.keys()].sort()).toEqual(
      [BRIDGE_LIST_PAIRED_DEVICES_CHANNEL, BRIDGE_UNPAIR_DEVICE_CHANNEL].sort()
    )
    expect(BRIDGE_LIST_PAIRED_DEVICES_CHANNEL).toBe('bridge-list-paired-devices')
    expect(BRIDGE_UNPAIR_DEVICE_CHANNEL).toBe('bridge-unpair-device')
  })

  it('lists paired devices from the runtime', async () => {
    const { list } = harness()
    const devices = [deviceFixture({ pairId: 'a' }), deviceFixture({ pairId: 'b' })]
    list.mockReturnValue(devices)
    const result = await handlerFor(BRIDGE_LIST_PAIRED_DEVICES_CHANNEL)(EVENT)
    expect(list).toHaveBeenCalledTimes(1)
    expect(result).toBe(devices)
  })

  it('lists an empty array when the bridge runtime is off', async () => {
    const { list, setRuntime } = harness()
    setRuntime(null)
    const result = await handlerFor(BRIDGE_LIST_PAIRED_DEVICES_CHANNEL)(EVENT)
    expect(result).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('reads the runtime at invocation time, not registration time', async () => {
    const { list, setRuntime, runtime } = harness()
    setRuntime(null)
    expect(await handlerFor(BRIDGE_LIST_PAIRED_DEVICES_CHANNEL)(EVENT)).toEqual([])
    setRuntime(runtime)
    await handlerFor(BRIDGE_LIST_PAIRED_DEVICES_CHANNEL)(EVENT)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty device identity before touching the runtime', async () => {
    const { list, unpair } = harness()
    await expect(handlerFor(BRIDGE_UNPAIR_DEVICE_CHANNEL)(EVENT, '   ')).rejects.toThrow(
      /Device identity/
    )
    expect(list).not.toHaveBeenCalled()
    expect(unpair).not.toHaveBeenCalled()
  })

  it('reports pairing-off when unpairing with no runtime', async () => {
    const { setRuntime } = harness()
    setRuntime(null)
    const result = await handlerFor(BRIDGE_UNPAIR_DEVICE_CHANNEL)(EVENT, 'device-key-1')
    expect(result).toEqual({ ok: false, error: PAIRING_OFF_ERROR })
  })

  it('reports not-found for an unknown device without unpairing', async () => {
    const { unpair, removeApnsToken } = harness()
    const result = await handlerFor(BRIDGE_UNPAIR_DEVICE_CHANNEL)(EVENT, 'unknown-key')
    expect(result).toEqual({ ok: false, error: 'Paired device not found.' })
    expect(unpair).not.toHaveBeenCalled()
    expect(removeApnsToken).not.toHaveBeenCalled()
  })

  it('unpaires a known device and removes its APNS token', async () => {
    const { unpair, removeApnsToken } = harness()
    const result = await handlerFor(BRIDGE_UNPAIR_DEVICE_CHANNEL)(EVENT, 'device-key-1')
    expect(unpair).toHaveBeenCalledTimes(1)
    expect(unpair).toHaveBeenCalledWith('device-key-1')
    expect(removeApnsToken).toHaveBeenCalledTimes(1)
    expect(removeApnsToken).toHaveBeenCalledWith('pair-1')
    expect(result).toEqual({ ok: true })
  })

  it('unpaires without a token store when the dep is omitted', async () => {
    const { unpair } = harness(false)
    const result = await handlerFor(BRIDGE_UNPAIR_DEVICE_CHANNEL)(EVENT, 'device-key-1')
    expect(unpair).toHaveBeenCalledWith('device-key-1')
    expect(result).toEqual({ ok: true })
  })

  it('unregisters both channels', () => {
    harness()
    expect(handlers.size).toBe(2)
    unregisterBridgePairedDeviceHandlers()
    expect(handlers.size).toBe(0)
  })
})

import { join } from 'node:path'
import * as protoLoader from '@grpc/proto-loader'
import { describe, expect, it, vi } from 'vitest'
import {
  DefaultIdbGrpcTransport,
  IDB_GRPC_PROTO_VERSION,
  idbSwipeToHidEvents,
  idbTapToHidEvents,
  idbTextToHidEvents,
  type CompanionConnection,
  type IdbHidEvent
} from './IdbGrpcTransport'

const UDID = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'

describe('IdbGrpcTransport HID parity', () => {
  it('matches fb-idb tap and swipe event shapes', () => {
    expect(idbTapToHidEvents(12, 40)).toEqual([
      {
        press: {
          action: { touch: { point: { x: 12, y: 40 } } },
          direction: 0
        }
      },
      {
        press: {
          action: { touch: { point: { x: 12, y: 40 } } },
          direction: 1
        }
      }
    ])
    expect(idbSwipeToHidEvents(1, 2, 3, 4)).toEqual([
      {
        swipe: {
          start: { x: 1, y: 2 },
          end: { x: 3, y: 4 }
        }
      }
    ])
  })

  it('preserves a coalesced text batch including embedded newlines', () => {
    const events = idbTextToHidEvents('A\nb')
    expect(events).toEqual([
      { press: { action: { key: { keycode: 225 } }, direction: 0 } },
      { press: { action: { key: { keycode: 4 } }, direction: 0 } },
      { press: { action: { key: { keycode: 4 } }, direction: 1 } },
      { press: { action: { key: { keycode: 225 } }, direction: 1 } },
      { press: { action: { key: { keycode: 40 } }, direction: 0 } },
      { press: { action: { key: { keycode: 40 } }, direction: 1 } },
      { press: { action: { key: { keycode: 5 } }, direction: 0 } },
      { press: { action: { key: { keycode: 5 } }, direction: 1 } }
    ])
  })

  it('falls back upstream for characters fb-idb itself cannot encode', () => {
    expect(() => idbTextToHidEvents('🙂')).toThrow(/No fb-idb HID keycode/)
  })

  it('pins the vendored proto to the expected service contract', () => {
    expect(IDB_GRPC_PROTO_VERSION).toBe('fb-idb 1.1.7')
    const definition = protoLoader.loadSync(join(__dirname, 'proto', 'idb.proto'))
    const service = definition['idb.CompanionService']
    expect(service && 'hid' in service ? service.hid.path : undefined).toBe(
      '/idb.CompanionService/hid'
    )
    expect(service && 'hid' in service ? service.hid.requestStream : undefined).toBe(true)
    expect(service && 'describe' in service ? service.describe.path : undefined).toBe(
      '/idb.CompanionService/describe'
    )
  })
})

describe('DefaultIdbGrpcTransport', () => {
  it('targets the per-udid Unix socket and reuses its connection', async () => {
    const sent: Array<{ events: readonly IdbHidEvent[]; deadline: Date }> = []
    const addresses: string[] = []
    const connection: CompanionConnection = {
      sendHid: vi.fn(async (events, deadline) => {
        sent.push({ events, deadline })
      }),
      describe: vi.fn(async () => undefined),
      close: vi.fn()
    }
    const transport = new DefaultIdbGrpcTransport({
      socketExists: (path) => path === '/tmp/idb/' + UDID + '_companion.sock',
      createConnection: (address) => {
        addresses.push(address)
        return connection
      },
      now: () => 1_000,
      timeoutMs: 750
    })

    await transport.tap(UDID, 10, 20)
    await transport.text(UDID, 'ok')

    expect(addresses).toEqual(['unix:///tmp/idb/' + UDID + '_companion.sock'])
    expect(sent).toHaveLength(2)
    expect(sent[0].deadline).toEqual(new Date(1_750))
    expect(sent[1].events).toEqual(idbTextToHidEvents('ok'))
  })

  it('rejects malformed targets before constructing a socket path', async () => {
    const createConnection = vi.fn()
    const transport = new DefaultIdbGrpcTransport({
      socketExists: () => true,
      createConnection
    })

    await expect(transport.tap('../physical-device', 1, 2)).rejects.toThrow(/simulator UUID/)
    expect(createConnection).not.toHaveBeenCalled()
  })

  it('evicts a failed channel so the next gesture can reconnect', async () => {
    const connections: CompanionConnection[] = []
    const transport = new DefaultIdbGrpcTransport({
      socketExists: () => true,
      createConnection: () => {
        const ordinal = connections.length
        const connection: CompanionConnection = {
          sendHid:
            ordinal === 0
              ? vi.fn(async () => {
                  throw new Error('socket closed')
                })
              : vi.fn(async () => undefined),
          describe: vi.fn(async () => undefined),
          close: vi.fn()
        }
        connections.push(connection)
        return connection
      }
    })

    await expect(transport.tap(UDID, 1, 2)).rejects.toThrow('socket closed')
    await expect(transport.tap(UDID, 3, 4)).resolves.toBeUndefined()

    expect(connections).toHaveLength(2)
    expect(connections[0].close).toHaveBeenCalledOnce()
  })
})

const liveUdid = process.env.IDB_GRPC_LIVE_UDID
it.runIf(Boolean(liveUdid))('measures the live companion describe round-trip', async () => {
  const transport = new DefaultIdbGrpcTransport({ timeoutMs: 2_000 })
  const samples: number[] = []
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now()
    await transport.describe(liveUdid ?? '')
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const medianMs = sorted[Math.floor(sorted.length / 2)]
  console.info(
    '[idb-grpc-benchmark] samples_ms=' +
      samples.map((sample) => sample.toFixed(1)).join(',') +
      ' median_ms=' +
      medianMs.toFixed(1)
  )
  expect(medianMs).toBeLessThan(500)
})

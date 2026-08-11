/**
 * Low-latency HID transport for the already-running fb-idb companion.
 *
 * The companion owns the Unix socket lifecycle. This module only connects to
 * /tmp/idb/<udid>_companion.sock; it never starts or stops companion processes.
 * The descriptor mirrors the HID subset of fb-idb 1.1.7's vendored proto so
 * packaged builds do not depend on source-tree file paths.
 */
import { existsSync } from 'node:fs'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

const UUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const DEFAULT_GRPC_TIMEOUT_MS = 750

export const IDB_GRPC_PROTO_VERSION = 'fb-idb 1.1.7'

type Point = { x: number; y: number }
type HidDirection = 0 | 1

export type IdbHidEvent =
  | {
      press: {
        action: { touch: { point: Point } } | { key: { keycode: number } }
        direction: HidDirection
      }
    }
  | {
      swipe: {
        start: Point
        end: Point
      }
    }

export interface IdbGrpcTransport {
  tap(udid: string, x: number, y: number): Promise<void>
  text(udid: string, value: string): Promise<void>
  swipe(udid: string, xStart: number, yStart: number, xEnd: number, yEnd: number): Promise<void>
  describe(udid: string): Promise<void>
}

export interface CompanionConnection {
  sendHid(events: readonly IdbHidEvent[], deadline: Date): Promise<void>
  describe(deadline: Date): Promise<void>
  close(): void
}

export interface IdbGrpcTransportDeps {
  socketExists?: (path: string) => boolean
  createConnection?: (address: string) => CompanionConnection
  now?: () => number
  timeoutMs?: number
}

const IDB_PROTO_DESCRIPTOR = {
  nested: {
    idb: {
      nested: {
        Point: {
          fields: {
            x: { type: 'double', id: 1 },
            y: { type: 'double', id: 2 }
          }
        },
        TargetDescriptionRequest: {
          fields: {
            fetch_diagnostics: { type: 'bool', id: 1 }
          }
        },
        // The health/latency probe ignores the body. Unknown fields are
        // wire-compatible and discarded by protobuf decoding.
        TargetDescriptionResponse: { fields: {} },
        HIDEvent: {
          fields: {
            press: { type: 'HIDPress', id: 1 },
            swipe: { type: 'HIDSwipe', id: 2 }
          },
          oneofs: {
            event: { oneof: ['press', 'swipe'] }
          },
          nested: {
            HIDDirection: {
              values: { DOWN: 0, UP: 1 }
            },
            HIDTouch: {
              fields: {
                point: { type: 'Point', id: 1 }
              }
            },
            HIDKey: {
              fields: {
                keycode: { type: 'uint64', id: 1 }
              }
            },
            HIDPressAction: {
              fields: {
                touch: { type: 'HIDTouch', id: 1 },
                key: { type: 'HIDKey', id: 3 }
              },
              oneofs: {
                action: { oneof: ['touch', 'key'] }
              }
            },
            HIDPress: {
              fields: {
                action: { type: 'HIDPressAction', id: 1 },
                direction: { type: 'HIDDirection', id: 2 }
              }
            },
            HIDSwipe: {
              fields: {
                start: { type: 'Point', id: 1 },
                end: { type: 'Point', id: 2 },
                delta: { type: 'double', id: 5 },
                duration: { type: 'double', id: 6 }
              }
            }
          }
        },
        HIDResponse: { fields: {} },
        CompanionService: {
          methods: {
            describe: {
              requestType: 'TargetDescriptionRequest',
              responseType: 'TargetDescriptionResponse',
              comment: ''
            },
            hid: {
              requestType: 'HIDEvent',
              responseType: 'HIDResponse',
              requestStream: true,
              comment: ''
            }
          }
        }
      }
    }
  }
} as Parameters<typeof protoLoader.fromJSON>[0]

const packageDefinition = protoLoader.fromJSON(IDB_PROTO_DESCRIPTOR, {
  keepCase: true,
  longs: String,
  oneofs: true
})
const serviceDefinition = packageDefinition['idb.CompanionService']
if (!serviceDefinition || !('hid' in serviceDefinition)) {
  throw new Error('The embedded fb-idb descriptor is missing CompanionService.hid.')
}
const CompanionClient = grpc.makeGenericClientConstructor(
  serviceDefinition as grpc.ServiceDefinition,
  'idb.CompanionService'
)

type DynamicCompanionClient = grpc.Client & {
  hid(
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response?: unknown) => void
  ): grpc.ClientWritableStream<IdbHidEvent>
  describe(
    request: { fetch_diagnostics: boolean },
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response?: unknown) => void
  ): grpc.ClientUnaryCall
}

function createDefaultConnection(address: string): CompanionConnection {
  const client = new CompanionClient(
    address,
    grpc.credentials.createInsecure()
  ) as unknown as DynamicCompanionClient
  return {
    sendHid(events, deadline) {
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (error?: Error | null): void => {
          if (settled) return
          settled = true
          if (error) reject(error)
          else resolve()
        }
        const stream = client.hid({ deadline }, (error) => settle(error))
        stream.once('error', (error) => settle(error))
        try {
          for (const event of events) stream.write(event)
          stream.end()
        } catch (error) {
          stream.cancel()
          settle(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    describe(deadline) {
      return new Promise<void>((resolve, reject) => {
        client.describe({ fetch_diagnostics: false }, { deadline }, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
    close() {
      client.close()
    }
  }
}

function socketPathForUdid(udid: string): string {
  const id = udid.trim()
  if (!UUID_PATTERN.test(id)) {
    throw new Error('idb gRPC requires a simulator UUID.')
  }
  return '/tmp/idb/' + id + '_companion.sock'
}

function keyDirection(keycode: number, direction: HidDirection): IdbHidEvent {
  return { press: { action: { key: { keycode } }, direction } }
}

function pressKey(keycode: number): IdbHidEvent[] {
  return [keyDirection(keycode, 0), keyDirection(keycode, 1)]
}

function pressShiftedKey(keycode: number): IdbHidEvent[] {
  return [
    keyDirection(225, 0),
    keyDirection(keycode, 0),
    keyDirection(keycode, 1),
    keyDirection(225, 1)
  ]
}

const KEYCODES = new Map<string, { keycode: number; shifted?: true }>()

for (const [index, character] of [...'abcdefghijklmnopqrstuvwxyz'].entries()) {
  KEYCODES.set(character, { keycode: index + 4 })
  KEYCODES.set(character.toUpperCase(), { keycode: index + 4, shifted: true })
}

for (const [index, character] of [...'1234567890'].entries()) {
  KEYCODES.set(character, { keycode: index + 30 })
}

for (const [character, keycode] of Object.entries({
  '\n': 40,
  ' ': 44,
  '-': 45,
  '=': 46,
  '[': 47,
  ']': 48,
  '\\': 49,
  ';': 51,
  "'": 52,
  ',': 54,
  '.': 55,
  '/': 56
})) {
  KEYCODES.set(character, { keycode })
}
KEYCODES.set(String.fromCharCode(96), { keycode: 53 })

for (const [character, keycode] of Object.entries({
  '!': 30,
  '@': 31,
  '#': 32,
  $: 33,
  '%': 34,
  '^': 35,
  '&': 36,
  '*': 37,
  '(': 38,
  ')': 39,
  _: 45,
  '+': 46,
  '{': 47,
  '}': 48,
  '|': 49,
  ':': 51,
  '"': 52,
  '~': 53,
  '<': 54,
  '>': 55,
  '?': 56
})) {
  KEYCODES.set(character, { keycode, shifted: true })
}

export function idbTextToHidEvents(value: string): IdbHidEvent[] {
  const events: IdbHidEvent[] = []
  for (const character of value) {
    const mapping = KEYCODES.get(character)
    if (!mapping) {
      throw new Error('No fb-idb HID keycode exists for ' + JSON.stringify(character) + '.')
    }
    events.push(...(mapping.shifted ? pressShiftedKey(mapping.keycode) : pressKey(mapping.keycode)))
  }
  return events
}

export function idbTapToHidEvents(x: number, y: number): IdbHidEvent[] {
  const action = { touch: { point: { x, y } } }
  return [{ press: { action, direction: 0 } }, { press: { action, direction: 1 } }]
}

export function idbSwipeToHidEvents(
  xStart: number,
  yStart: number,
  xEnd: number,
  yEnd: number
): IdbHidEvent[] {
  return [
    {
      swipe: {
        start: { x: xStart, y: yStart },
        end: { x: xEnd, y: yEnd }
      }
    }
  ]
}

export class DefaultIdbGrpcTransport implements IdbGrpcTransport {
  private readonly socketExists: (path: string) => boolean
  private readonly createConnection: (address: string) => CompanionConnection
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly connections = new Map<string, CompanionConnection>()

  constructor(deps: IdbGrpcTransportDeps = {}) {
    this.socketExists = deps.socketExists ?? existsSync
    this.createConnection = deps.createConnection ?? createDefaultConnection
    this.now = deps.now ?? (() => Date.now())
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_GRPC_TIMEOUT_MS
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.send(udid, idbTapToHidEvents(x, y))
  }

  async text(udid: string, value: string): Promise<void> {
    await this.send(udid, idbTextToHidEvents(value))
  }

  async swipe(
    udid: string,
    xStart: number,
    yStart: number,
    xEnd: number,
    yEnd: number
  ): Promise<void> {
    await this.send(udid, idbSwipeToHidEvents(xStart, yStart, xEnd, yEnd))
  }

  async describe(udid: string): Promise<void> {
    const connection = this.connectionFor(udid)
    try {
      await connection.describe(this.deadline())
    } catch (error) {
      this.evict(udid, connection)
      throw error
    }
  }

  private async send(udid: string, events: readonly IdbHidEvent[]): Promise<void> {
    const connection = this.connectionFor(udid)
    try {
      await connection.sendHid(events, this.deadline())
    } catch (error) {
      this.evict(udid, connection)
      throw error
    }
  }

  private deadline(): Date {
    return new Date(this.now() + this.timeoutMs)
  }

  private connectionFor(udid: string): CompanionConnection {
    const socketPath = socketPathForUdid(udid)
    if (!this.socketExists(socketPath)) {
      throw new Error('idb companion socket is unavailable for ' + udid.trim() + '.')
    }
    const existing = this.connections.get(socketPath)
    if (existing) return existing
    const connection = this.createConnection('unix://' + socketPath)
    this.connections.set(socketPath, connection)
    return connection
  }

  private evict(udid: string, connection: CompanionConnection): void {
    const socketPath = socketPathForUdid(udid)
    if (this.connections.get(socketPath) === connection) {
      this.connections.delete(socketPath)
      connection.close()
    }
  }
}

export function createDefaultIdbGrpcTransport(): IdbGrpcTransport {
  return new DefaultIdbGrpcTransport()
}

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HOST_COMMAND_FINGERPRINT_HEX_LENGTH,
  HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  createEmptyHostSnapshot,
  decodeHostBootstrapHello,
  decodeHostBootstrapWelcome,
  decodeHostCommand,
  decodeHostCommandReceipt,
  decodeHostDeltasFrame,
  decodeHostHealthFrame,
  decodeHostSnapshotFrame,
  type HostBootstrapHello,
  type HostBootstrapWelcome,
  type HostCommand,
  type HostCommandReceipt,
  type HostDeltasFrame,
  type HostHealthFrame,
  type HostSnapshotFrame
} from './hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_ERROR_CODES,
  HOST_LOCAL_TRANSPORT_EVENT_KINDS,
  HOST_LOCAL_TRANSPORT_MAX_ID,
  HOST_LOCAL_TRANSPORT_REQUEST_KINDS,
  HOST_LOCAL_TRANSPORT_VERSION,
  assertHostLocalTransportErrorBodyFree,
  decodeHostLocalTransportClientFrame,
  decodeHostLocalTransportHostFrame,
  encodeHostLocalTransportClientFrame,
  encodeHostLocalTransportHostFrame,
  type HostLocalTransportClientFrame,
  type HostLocalTransportError,
  type HostLocalTransportHostFrame,
  type HostLocalTransportRequest,
  type HostLocalTransportResponse
} from './hostProtocolTransport'

const client = {
  clientId: 'client-desktop-1',
  clientClass: 'desktop' as const,
  clientVersion: '1.9.2'
}

const actor = {
  actorId: 'user-1',
  clientId: client.clientId,
  clientClass: client.clientClass
}

const FP_A = 'a'.repeat(HOST_COMMAND_FINGERPRINT_HEX_LENGTH)

function sampleHello(): HostBootstrapHello {
  const decoded = decodeHostBootstrapHello({
    type: 'host.hello',
    protocolVersion: HOST_PROTOCOL_VERSION,
    controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    client,
    capabilities: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health']
  })
  if (!decoded.ok) throw new Error(`fixture hello invalid: ${decoded.error}`)
  return decoded.value
}

function sampleWelcome(): HostBootstrapWelcome {
  const decoded = decodeHostBootstrapWelcome({
    type: 'host.welcome',
    protocolVersion: HOST_PROTOCOL_VERSION,
    controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    hostId: 'host-local-1',
    hostVersion: '1.9.2',
    sessionId: 'sess-1',
    generation: 3,
    cursor: 10,
    authenticatedClient: client,
    capabilities: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
    freshness: 'live'
  })
  if (!decoded.ok) throw new Error(`fixture welcome invalid: ${decoded.error}`)
  return decoded.value
}

function sampleCommand(): HostCommand {
  const decoded = decodeHostCommand({
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    actor,
    name: 'composer.send',
    target: { threadId: 'thread-1' },
    arguments: { text: 'hello host' },
    issuedAt: '2026-08-03T17:00:00.000Z'
  })
  if (!decoded.ok) throw new Error(`fixture command invalid: ${decoded.error}`)
  return decoded.value
}

function sampleReceipt(): HostCommandReceipt {
  const decoded = decodeHostCommandReceipt({
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    name: 'composer.send',
    actor,
    authority: { decision: 'allow' },
    status: 'succeeded',
    commandFingerprint: FP_A,
    generation: 3,
    cursor: 11,
    createdAt: '2026-08-03T17:00:00.000Z',
    updatedAt: '2026-08-03T17:00:01.000Z',
    resultSummary: 'queued'
  })
  if (!decoded.ok) throw new Error(`fixture receipt invalid: ${decoded.error}`)
  return decoded.value
}

function sampleSnapshotFrame(): HostSnapshotFrame {
  const snapshot = createEmptyHostSnapshot({
    generatedAt: '2026-08-03T17:00:00.000Z',
    generation: 3,
    cursor: 10,
    freshness: 'live'
  })
  const decoded = decodeHostSnapshotFrame({
    type: 'host.snapshot',
    protocolVersion: HOST_PROTOCOL_VERSION,
    snapshot
  })
  if (!decoded.ok) throw new Error(`fixture snapshot frame invalid: ${decoded.error}`)
  return decoded.value
}

function sampleDeltasFrame(): HostDeltasFrame {
  const decoded = decodeHostDeltasFrame({
    type: 'host.deltas',
    protocolVersion: HOST_PROTOCOL_VERSION,
    result: {
      kind: 'deltas',
      generation: 3,
      fromCursor: 10,
      toCursor: 11,
      deltas: [
        {
          protocolVersion: HOST_PROTOCOL_VERSION,
          projectionVersion: HOST_PROJECTION_VERSION,
          generation: 3,
          cursor: 11,
          previousCursor: 10,
          kind: 'upsert',
          family: 'thread',
          entityId: 'thread-1',
          payload: { title: 'Mission' },
          at: '2026-08-03T17:00:00.000Z'
        }
      ]
    }
  })
  if (!decoded.ok) throw new Error(`fixture deltas frame invalid: ${decoded.error}`)
  return decoded.value
}

function sampleHealthFrame(): HostHealthFrame {
  const decoded = decodeHostHealthFrame({
    type: 'host.health',
    protocolVersion: HOST_PROTOCOL_VERSION,
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    }
  })
  if (!decoded.ok) throw new Error(`fixture health frame invalid: ${decoded.error}`)
  return decoded.value
}

function expectClientRoundTrip(frame: HostLocalTransportClientFrame): void {
  const encoded = encodeHostLocalTransportClientFrame(frame)
  expect(encoded.ok).toBe(true)
  if (!encoded.ok) return
  const decoded = decodeHostLocalTransportClientFrame(JSON.parse(JSON.stringify(encoded.value)))
  expect(decoded).toEqual({ ok: true, value: frame })
}

function expectHostRoundTrip(frame: HostLocalTransportHostFrame): void {
  const encoded = encodeHostLocalTransportHostFrame(frame)
  expect(encoded).toEqual({ ok: true, value: frame })
  if (!encoded.ok || !('value' in encoded)) return
  const decoded = decodeHostLocalTransportHostFrame(JSON.parse(JSON.stringify(encoded.value)))
  expect(decoded).toEqual({ ok: true, value: frame })
}

describe('hostProtocolTransport Wave 3.2', () => {
  describe('round-trip every frame', () => {
    it('round-trips hello with token + HostBootstrapHello', () => {
      expectClientRoundTrip({
        type: 'hello',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        token: 'tok-'.padEnd(32, 'a'),
        hello: sampleHello()
      })
    })

    it.each(HOST_LOCAL_TRANSPORT_REQUEST_KINDS)('round-trips request kind %s', (kind) => {
      const base = {
        type: 'request' as const,
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: `req-${kind}`
      }
      let frame: HostLocalTransportRequest
      switch (kind) {
        case 'snapshot.get':
          frame = { ...base, kind, params: {} }
          break
        case 'deltas.since':
          frame = { ...base, kind, params: { generation: 3, cursor: 10 } }
          break
        case 'receipt.lookup':
          frame = { ...base, kind, params: { commandId: 'cmd-1' } }
          break
        case 'health.get':
          frame = { ...base, kind, params: {} }
          break
        case 'command.submit':
          frame = { ...base, kind, params: sampleCommand() }
          break
        default: {
          const _never: never = kind
          throw new Error(`unhandled ${_never}`)
        }
      }
      expectClientRoundTrip(frame)
    })

    it('round-trips welcome with HostBootstrapWelcome', () => {
      expectHostRoundTrip({
        type: 'welcome',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        welcome: sampleWelcome()
      })
    })

    it('round-trips success responses for every request kind', () => {
      const receipt = sampleReceipt()
      const results: HostLocalTransportResponse[] = [
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r-snap',
          ok: true,
          result: { kind: 'snapshot.get', frame: sampleSnapshotFrame() }
        },
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r-deltas',
          ok: true,
          result: { kind: 'deltas.since', frame: sampleDeltasFrame() }
        },
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r-receipt',
          ok: true,
          result: { kind: 'receipt.lookup', receipt }
        },
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r-health',
          ok: true,
          result: { kind: 'health.get', frame: sampleHealthFrame() }
        },
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r-cmd',
          ok: true,
          result: { kind: 'command.submit', receipt }
        }
      ]
      for (const frame of results) {
        expectHostRoundTrip(frame)
      }
    })

    it('round-trips body-free error responses for every closed code', () => {
      for (const code of HOST_LOCAL_TRANSPORT_ERROR_CODES) {
        expectHostRoundTrip({
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: `err-${code}`,
          ok: false,
          error: { code }
        })
      }
    })

    it.each(HOST_LOCAL_TRANSPORT_EVENT_KINDS)('round-trips event kind %s', (event) => {
      if (event === 'deltas') {
        expectHostRoundTrip({
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event,
          sequence: 7,
          payload: sampleDeltasFrame()
        })
        return
      }
      if (event === 'health') {
        expectHostRoundTrip({
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event,
          sequence: 8,
          payload: sampleHealthFrame()
        })
        return
      }
      expectHostRoundTrip({
        type: 'event',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        event: 'host.closing',
        sequence: 9
      })
    })
  })

  describe('fail-closed matrix', () => {
    it('rejects unknown client frame kind', () => {
      expect(
        decodeHostLocalTransportClientFrame({
          type: 'ping',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION
        })
      ).toEqual({ ok: false, error: { code: 'unknown_frame_kind' } })
    })

    it('rejects unknown host frame kind', () => {
      expect(
        decodeHostLocalTransportHostFrame({
          type: 'goodbye',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION
        })
      ).toEqual({ ok: false, error: { code: 'unknown_frame_kind' } })
    })

    it('rejects bad transport version on client and host', () => {
      expect(
        decodeHostLocalTransportClientFrame({
          type: 'hello',
          transportVersion: 99,
          token: 'tok',
          hello: sampleHello()
        })
      ).toEqual({ ok: false, error: { code: 'unsupported_transport_version' } })
      expect(
        decodeHostLocalTransportHostFrame({
          type: 'welcome',
          transportVersion: 0,
          welcome: sampleWelcome()
        })
      ).toEqual({ ok: false, error: { code: 'unsupported_transport_version' } })
    })

    it('rejects missing and oversize request ids', () => {
      expect(
        decodeHostLocalTransportClientFrame({
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          kind: 'snapshot.get',
          params: {}
        })
      ).toEqual({ ok: false, error: { code: 'missing_id' } })
      expect(
        decodeHostLocalTransportClientFrame({
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: '',
          kind: 'snapshot.get',
          params: {}
        })
      ).toEqual({ ok: false, error: { code: 'missing_id' } })
      expect(
        decodeHostLocalTransportClientFrame({
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'x'.repeat(HOST_LOCAL_TRANSPORT_MAX_ID + 1),
          kind: 'snapshot.get',
          params: {}
        })
      ).toEqual({ ok: false, error: { code: 'oversize_id' } })
      expect(
        decodeHostLocalTransportHostFrame({
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'y'.repeat(HOST_LOCAL_TRANSPORT_MAX_ID + 1),
          ok: false,
          error: { code: 'host_unavailable' }
        })
      ).toEqual({ ok: false, error: { code: 'oversize_id' } })
    })

    it('rejects unknown request kinds (never skips)', () => {
      expect(
        decodeHostLocalTransportClientFrame({
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'req-unknown',
          kind: 'ensemble.yield',
          params: {}
        })
      ).toEqual({ ok: false, error: { code: 'unknown_request_kind' } })
    })

    it('skips unknown event kinds (forward compat) without rejecting', () => {
      expect(
        decodeHostLocalTransportHostFrame({
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'mission.progress',
          sequence: 42,
          payload: { anything: true }
        })
      ).toEqual({
        ok: true,
        skipped: true,
        reason: 'unknown_event_kind',
        event: 'mission.progress',
        sequence: 42,
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION
      })
    })

    it('rejects non-object frames without throwing', () => {
      expect(decodeHostLocalTransportClientFrame(null)).toEqual({
        ok: false,
        error: { code: 'invalid_frame' }
      })
      expect(decodeHostLocalTransportHostFrame('nope')).toEqual({
        ok: false,
        error: { code: 'invalid_frame' }
      })
    })
  })

  describe('id-correlation and body-free errors', () => {
    it('preserves request id onto correlated success and error responses', () => {
      const requestId = 'corr-42'
      const request = decodeHostLocalTransportClientFrame({
        type: 'request',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: requestId,
        kind: 'health.get',
        params: {}
      })
      expect(request).toEqual({
        ok: true,
        value: {
          type: 'request',
          transportVersion: 1,
          id: requestId,
          kind: 'health.get',
          params: {}
        }
      })

      const success = decodeHostLocalTransportHostFrame({
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: requestId,
        ok: true,
        result: { kind: 'health.get', frame: sampleHealthFrame() }
      })
      expect(success.ok).toBe(true)
      if (success.ok && 'value' in success) {
        expect(success.value.type).toBe('response')
        if (success.value.type === 'response') {
          expect(success.value.id).toBe(requestId)
        }
      }

      const failure = decodeHostLocalTransportHostFrame({
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: requestId,
        ok: false,
        error: { code: 'unauthorized' }
      })
      expect(failure).toEqual({
        ok: true,
        value: {
          type: 'response',
          transportVersion: 1,
          id: requestId,
          ok: false,
          error: { code: 'unauthorized' }
        }
      })
    })

    it('rejects error responses that carry prose or extra fields', () => {
      expect(
        decodeHostLocalTransportHostFrame({
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r1',
          ok: false,
          error: { code: 'unauthorized', message: 'nope' }
        })
      ).toEqual({ ok: false, error: { code: 'invalid_payload' } })
      expect(
        decodeHostLocalTransportHostFrame({
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r2',
          ok: false,
          error: { code: 'not_a_real_code' }
        })
      ).toEqual({ ok: false, error: { code: 'invalid_payload' } })
    })

    it('assertHostLocalTransportErrorBodyFree accepts closed codes only', () => {
      for (const code of HOST_LOCAL_TRANSPORT_ERROR_CODES) {
        expect(assertHostLocalTransportErrorBodyFree({ code })).toEqual({
          ok: true,
          value: { code }
        })
      }
      const withProse = { code: 'unauthorized', message: 'secret' } as HostLocalTransportError & {
        message: string
      }
      expect(assertHostLocalTransportErrorBodyFree(withProse)).toEqual({
        ok: false,
        error: { code: 'invalid_payload' }
      })
    })

    it('JSON-serialized error responses never leak message/args/actor keys', () => {
      for (const code of HOST_LOCAL_TRANSPORT_ERROR_CODES) {
        const frame: HostLocalTransportHostFrame = {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: `bf-${code}`,
          ok: false,
          error: { code }
        }
        const parsed = JSON.parse(JSON.stringify(frame)) as {
          error: Record<string, unknown>
        }
        expect(Object.keys(parsed.error)).toEqual(['code'])
        expect(parsed.error).toEqual({ code })
        expect(parsed.error).not.toHaveProperty('message')
        expect(parsed.error).not.toHaveProperty('args')
        expect(parsed.error).not.toHaveProperty('actor')
        expect(parsed.error).not.toHaveProperty('token')
      }
    })
  })

  describe('import isolation', () => {
    it('production module uses type-only hostProtocol import and bans server/store/Authority', () => {
      const source = readFileSync(new URL('./hostProtocolTransport.ts', import.meta.url), 'utf8')
      const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
      const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '')

      expect(withoutLineComments).toMatch(
        /import\s+type\s*\{[\s\S]*HostBootstrapHello[\s\S]*\}\s*from\s*['"]\.\/hostProtocol['"]/
      )
      expect(withoutLineComments).not.toMatch(
        /import\s*\{[^}]*\}\s*from\s*['"]\.\/hostProtocol['"]/
      )
      expect(withoutLineComments).not.toMatch(
        /from\s*['"][^'"]*(main\/host|Authority|LocalControl|HostRuntime|HostDeferred|HostCommand|store\/)[^'"]*['"]/
      )
      expect(withoutLineComments).not.toMatch(/from\s*['"]node:/)
      expect(withoutLineComments).not.toMatch(/require\s*\(/)
      expect(withoutLineComments).not.toMatch(/electron/i)
      expect(withoutLineComments).not.toMatch(/\bnet\b|\bfs\b|\bchild_process\b/)
    })
  })
})

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
  HOST_WORKSPACE_GIT_RESULT_MAX_BYTES,
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
import type { TaskWraithControlThreadOffers } from './taskWraithControlProtocol'

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

function sampleThreadOffers(): TaskWraithControlThreadOffers {
  return {
    threadId: 'thread-1',
    provider: {
      runtimeProvider: 'codex',
      displayProvider: 'Codex',
      hueKey: 'codex',
      accent: '#705AFF',
      model: 'gpt-5.6-sol',
      modelLabel: 'GPT-5.6-Sol',
      shortCode: 'CDX'
    },
    currentModel: 'gpt-5.6-sol',
    currentReasoningEffort: 'high',
    models: [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        current: true,
        reasoningEfforts: [{ id: 'high', isDefault: true }],
        defaultReasoningEffort: 'high'
      }
    ],
    source: 'curated'
  }
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
        case 'thread.offers':
          frame = { ...base, kind, params: { threadId: 'thread-1' } }
          break
        case 'provider.status':
          frame = { ...base, kind, params: {} }
          break
        case 'provider.offers':
        case 'provider.auth.flows':
        case 'provider.auth.status':
          frame = { ...base, kind, params: { providerId: 'codex' } }
          break
        case 'thread.history':
          frame = { ...base, kind, params: { threadId: 'thread-1', limit: 25 } }
          break
        case 'workspace.git.read':
          frame = {
            ...base,
            kind,
            params: { workspaceId: 'workspace-1', scope: 'status' }
          }
          break
        case 'history.since':
          frame = {
            ...base,
            kind,
            params: { threadId: 'thread-1', since: { generation: 1, cursor: 2 } }
          }
          break
        case 'receipt.lookup':
          frame = { ...base, kind, params: { commandId: 'cmd-1' } }
          break
        case 'health.get':
        case 'host.shutdown':
          frame = { ...base, kind, params: {} }
          break
        case 'command.submit':
          frame = { ...base, kind, params: sampleCommand() }
          break
        case 'twmission.export':
          frame = { ...base, kind, params: {} }
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
          id: 'r-offers',
          ok: true,
          result: { kind: 'thread.offers', offers: sampleThreadOffers() }
        },
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r-workspace-git',
          ok: true,
          result: {
            kind: 'workspace.git.read',
            result: {
              scope: 'status',
              branch: 'main',
              head: 'a'.repeat(40),
              files: [],
              truncated: false
            }
          }
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
          id: 'r-shutdown',
          ok: true,
          result: { kind: 'host.shutdown', state: 'stopping' }
        },
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'r-shutdown-again',
          ok: true,
          result: { kind: 'host.shutdown', state: 'already_stopping' }
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

    it('round-trips setup/history responses and the separate history event', () => {
      const historyResult = {
        kind: 'deltas' as const,
        threadId: 'thread-1',
        generation: 1,
        fromCursor: 2,
        toCursor: 3,
        deltas: [
          {
            kind: 'append' as const,
            entry: { entryId: 'message-1', role: 'assistant' as const, createdAt: 1, text: 'Hello' }
          }
        ]
      }
      for (const result of [
        {
          kind: 'provider.status' as const,
          statuses: [{ providerId: 'codex', status: 'ready' as const, label: 'Codex' }]
        },
        {
          kind: 'provider.offers' as const,
          offers: {
            providerId: 'codex',
            offerRevision: 'catalog-r1',
            models: [{ modelId: 'gpt-5.6', label: 'GPT-5.6', available: true, reasoning: [] }],
            postures: [
              {
                postureId: 'plan',
                label: 'Plan',
                available: true,
                requiresExplicitConsent: true,
                ceiling: 'workspace_write' as const
              }
            ]
          }
        },
        {
          kind: 'provider.auth.flows' as const,
          flows: [
            { flowId: 'browser', kind: 'browser' as const, label: 'Browser', available: true }
          ]
        },
        {
          kind: 'provider.auth.status' as const,
          status: { providerId: 'codex', state: 'unauthenticated' as const }
        },
        {
          kind: 'thread.history' as const,
          page: { threadId: 'thread-1', generation: 1, cursor: 3, entries: [] }
        },
        { kind: 'history.since' as const, result: historyResult }
      ]) {
        expectHostRoundTrip({
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: `r-${result.kind}`,
          ok: true,
          result
        } as HostLocalTransportResponse)
      }
      expectHostRoundTrip({
        type: 'event',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        event: 'history',
        sequence: 9,
        payload: {
          type: 'host.history',
          protocolVersion: 2,
          threadId: 'thread-1',
          result: historyResult
        }
      })
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

  describe('workspace Git read contract', () => {
    it('accepts either a workspace or thread target and round-trips typed results', () => {
      for (const frame of [
        {
          type: 'request' as const,
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'git-workspace',
          kind: 'workspace.git.read' as const,
          params: {
            workspaceId: 'workspace-1',
            scope: 'diff' as const,
            path: 'src/shared/hostProtocol.ts'
          }
        },
        {
          type: 'request' as const,
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'git-thread',
          kind: 'workspace.git.read' as const,
          params: { threadId: 'thread-1', scope: 'status' as const }
        }
      ]) {
        expect(decodeHostLocalTransportClientFrame(frame)).toEqual({ ok: true, value: frame })
      }

      for (const frame of [
        {
          type: 'response' as const,
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'git-status',
          ok: true as const,
          result: {
            kind: 'workspace.git.read' as const,
            result: {
              scope: 'status' as const,
              branch: 'main',
              head: 'a'.repeat(40),
              files: [
                {
                  path: 'src/shared/hostProtocol.ts',
                  index: 'M',
                  workingTree: ' ',
                  kind: 'modified' as const,
                  staged: true,
                  unstaged: false
                }
              ],
              truncated: false
            }
          }
        },
        {
          type: 'response' as const,
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'git-diff',
          ok: true as const,
          result: {
            kind: 'workspace.git.read' as const,
            result: {
              scope: 'diff' as const,
              branch: null,
              head: null,
              text: 'diff --git a/file b/file',
              truncated: true
            }
          }
        },
        {
          type: 'response' as const,
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'git-log',
          ok: true as const,
          result: {
            kind: 'workspace.git.read' as const,
            result: {
              scope: 'log' as const,
              branch: 'feature',
              head: 'b'.repeat(64),
              text: 'b'.repeat(64) + ' subject',
              truncated: false
            }
          }
        }
      ]) {
        expect(decodeHostLocalTransportHostFrame(frame)).toEqual({ ok: true, value: frame })
      }
    })

    it('rejects ambiguous targets, invalid scopes, unsafe paths, and unknown fields', () => {
      for (const params of [
        { scope: 'status' },
        { workspaceId: 'workspace-1', threadId: 'thread-1', scope: 'status' },
        { workspaceId: 'workspace-1', scope: 'show' },
        { workspaceId: 'workspace-1', scope: 'diff', path: '/etc/passwd' },
        { workspaceId: 'workspace-1', scope: 'diff', path: 'C:\\Windows\\system.ini' },
        { workspaceId: 'workspace-1', scope: 'diff', path: 'src/../secret' },
        { workspaceId: 'workspace-1', scope: 'diff', extra: true }
      ]) {
        expect(
          decodeHostLocalTransportClientFrame({
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: 'git-invalid',
            kind: 'workspace.git.read',
            params
          })
        ).toEqual({ ok: false, error: { code: 'invalid_payload' } })
      }
    })

    it('strictly decodes bounded results with an explicit truncation marker', () => {
      expect(HOST_WORKSPACE_GIT_RESULT_MAX_BYTES).toBe(128 * 1024)
      const base = {
        type: 'response' as const,
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: 'git-result',
        ok: true as const
      }
      for (const result of [
        {
          kind: 'workspace.git.read',
          result: {
            scope: 'diff',
            branch: 'main',
            head: 'a'.repeat(40),
            text: 'diff',
            truncated: false,
            extra: true
          }
        },
        {
          kind: 'workspace.git.read',
          result: {
            scope: 'status',
            branch: 'main',
            head: 'not-a-revision',
            files: [],
            truncated: false
          }
        },
        {
          kind: 'workspace.git.read',
          result: {
            scope: 'status',
            branch: 'main',
            head: 'a'.repeat(40),
            files: [
              {
                path: '../outside',
                index: '?',
                workingTree: '?',
                kind: 'untracked',
                staged: false,
                unstaged: true
              }
            ],
            truncated: false
          }
        },
        {
          kind: 'workspace.git.read',
          result: {
            scope: 'diff',
            branch: 'main',
            head: 'a'.repeat(40),
            text: '\\'.repeat(HOST_WORKSPACE_GIT_RESULT_MAX_BYTES),
            truncated: true
          }
        },
        {
          kind: 'workspace.git.read',
          result: {
            scope: 'log',
            branch: null,
            head: null,
            text: 'log without marker'
          }
        }
      ]) {
        expect(decodeHostLocalTransportHostFrame({ ...base, result })).toEqual({
          ok: false,
          error: { code: 'invalid_payload' }
        })
      }
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

    it('rejects malformed thread.offers params and response catalogues', () => {
      expect(
        decodeHostLocalTransportClientFrame({
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'offers-bad',
          kind: 'thread.offers',
          params: { threadId: '', extra: true }
        })
      ).toEqual({ ok: false, error: { code: 'invalid_payload' } })

      expect(
        decodeHostLocalTransportHostFrame({
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'offers-bad-result',
          ok: true,
          result: {
            kind: 'thread.offers',
            offers: { ...sampleThreadOffers(), models: [{ id: 'invented' }] }
          }
        })
      ).toEqual({ ok: false, error: { code: 'invalid_payload' } })
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

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
import { PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER } from './providerModelCatalogLimits'
import {
  HOST_LOCAL_TRANSPORT_ERROR_CODES,
  HOST_LOCAL_TRANSPORT_EVENT_KINDS,
  HOST_LOCAL_TRANSPORT_MAX_ID,
  HOST_LOCAL_TRANSPORT_REQUEST_KINDS,
  HOST_LOCAL_TRANSPORT_THREAD_CLAIM_REFUSALS,
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
    currentPostureId: 'default',
    postures: [
      {
        id: 'default',
        label: 'Accept Edits',
        requiresExplicitConsent: false
      }
    ],
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

/** Byte goldens of every pre-lease client frame, recorded at 2a71f9580. */
const PRE_LEASE_CLIENT_GOLDENS: Record<string, string> = {
  hello:
    '{"type":"hello","transportVersion":1,"token":"tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaa","hello":{"type":"host.hello","protocolVersion":2,"projectionVersion":2,"controlProtocolCompat":1,"client":{"clientId":"client-desktop-1","clientClass":"desktop","clientVersion":"1.9.2"},"capabilities":["bootstrap","snapshot","deltas","commands","receipts","health"]}}',
  'snapshot.get':
    '{"type":"request","transportVersion":1,"id":"req-snapshot.get","kind":"snapshot.get","params":{}}',
  'deltas.since':
    '{"type":"request","transportVersion":1,"id":"req-deltas.since","kind":"deltas.since","params":{"generation":3,"cursor":10}}',
  'thread.offers':
    '{"type":"request","transportVersion":1,"id":"req-thread.offers","kind":"thread.offers","params":{"threadId":"thread-1"}}',
  'provider.status':
    '{"type":"request","transportVersion":1,"id":"req-provider.status","kind":"provider.status","params":{}}',
  'provider.offers':
    '{"type":"request","transportVersion":1,"id":"req-provider.offers","kind":"provider.offers","params":{"providerId":"codex"}}',
  'provider.auth.flows':
    '{"type":"request","transportVersion":1,"id":"req-provider.auth.flows","kind":"provider.auth.flows","params":{"providerId":"codex"}}',
  'provider.auth.status':
    '{"type":"request","transportVersion":1,"id":"req-provider.auth.status","kind":"provider.auth.status","params":{"providerId":"codex"}}',
  'thread.history':
    '{"type":"request","transportVersion":1,"id":"req-thread.history","kind":"thread.history","params":{"threadId":"thread-1","limit":25}}',
  'thread.catalogue':
    '{"type":"request","transportVersion":1,"id":"req-thread.catalogue","kind":"thread.catalogue","params":{"method":"list","limit":25}}',
  'thread.catalogue.maintenance':
    '{"type":"request","transportVersion":1,"id":"req-thread.catalogue.maintenance","kind":"thread.catalogue.maintenance","params":{"method":"owner","owner":{"writer":"desktop","writerId":"desktop-id"}}}',
  'workspace.git.read':
    '{"type":"request","transportVersion":1,"id":"req-workspace.git.read","kind":"workspace.git.read","params":{"workspaceId":"workspace-1","scope":"status"}}',
  'history.since':
    '{"type":"request","transportVersion":1,"id":"req-history.since","kind":"history.since","params":{"threadId":"thread-1","since":{"generation":1,"cursor":2}}}',
  'receipt.lookup':
    '{"type":"request","transportVersion":1,"id":"req-receipt.lookup","kind":"receipt.lookup","params":{"commandId":"cmd-1"}}',
  'health.get':
    '{"type":"request","transportVersion":1,"id":"req-health.get","kind":"health.get","params":{}}',
  'host.shutdown':
    '{"type":"request","transportVersion":1,"id":"req-host.shutdown","kind":"host.shutdown","params":{}}',
  'command.submit':
    '{"type":"request","transportVersion":1,"id":"req-command.submit","kind":"command.submit","params":{"type":"host.command","protocolVersion":2,"commandId":"cmd-1","idempotencyKey":"idem-1","actor":{"actorId":"user-1","clientId":"client-desktop-1","clientClass":"desktop"},"name":"composer.send","target":{"threadId":"thread-1"},"arguments":{"text":"hello host"},"issuedAt":"2026-08-03T17:00:00.000Z"}}',
  'twmission.export':
    '{"type":"request","transportVersion":1,"id":"req-twmission.export","kind":"twmission.export","params":{}}',
  'thread.catalogue+background':
    '{"type":"request","transportVersion":1,"id":"catalogue-priority","kind":"thread.catalogue","params":{"method":"summary","chatId":"chat-1"},"priority":"background"}'
}

/** Byte goldens of every pre-lease host frame, recorded at 2a71f9580. */
const PRE_LEASE_HOST_GOLDENS: Record<string, string> = {
  welcome:
    '{"type":"welcome","transportVersion":1,"welcome":{"type":"host.welcome","protocolVersion":2,"controlProtocolCompat":1,"projectionVersion":2,"hostId":"host-local-1","hostVersion":"1.9.2","sessionId":"sess-1","generation":3,"cursor":10,"authenticatedClient":{"clientId":"client-desktop-1","clientClass":"desktop","clientVersion":"1.9.2"},"capabilities":["bootstrap","snapshot","deltas","commands","receipts","health"],"freshness":"live"}}',
  'response:snapshot.get':
    '{"type":"response","transportVersion":1,"id":"r-snap","ok":true,"result":{"kind":"snapshot.get","frame":{"type":"host.snapshot","protocolVersion":2,"snapshot":{"protocolVersion":2,"projectionVersion":2,"generatedAt":"2026-08-03T17:00:00.000Z","generation":3,"cursor":10,"freshness":"live","health":{"hostStatus":"ok","connectionPhase":"live","supervised":true,"freshness":"live"},"workspaces":[],"threads":[],"runs":[],"missions":[],"rounds":[],"participants":[],"providers":[],"questions":[],"approvals":[],"schedules":[],"usage":{"availability":"unavailable","confidence":"unknown","band":"unknown"},"artifacts":[],"warnings":[],"recovery":{"reopenStatus":"unknown"}}}}}',
  'response:deltas.since':
    '{"type":"response","transportVersion":1,"id":"r-deltas","ok":true,"result":{"kind":"deltas.since","frame":{"type":"host.deltas","protocolVersion":2,"result":{"kind":"deltas","generation":3,"fromCursor":10,"toCursor":11,"deltas":[{"protocolVersion":2,"projectionVersion":2,"generation":3,"cursor":11,"previousCursor":10,"kind":"upsert","family":"thread","at":"2026-08-03T17:00:00.000Z","entityId":"thread-1","payload":{"title":"Mission"}}]}}}}',
  'response:thread.offers':
    '{"type":"response","transportVersion":1,"id":"r-offers","ok":true,"result":{"kind":"thread.offers","offers":{"threadId":"thread-1","provider":{"runtimeProvider":"codex","displayProvider":"Codex","hueKey":"codex","accent":"#705AFF","model":"gpt-5.6-sol","modelLabel":"GPT-5.6-Sol","shortCode":"CDX"},"currentModel":"gpt-5.6-sol","currentReasoningEffort":"high","currentPostureId":"default","postures":[{"id":"default","label":"Accept Edits","requiresExplicitConsent":false}],"models":[{"id":"gpt-5.6-sol","label":"GPT-5.6-Sol","current":true,"reasoningEfforts":[{"id":"high","isDefault":true}],"defaultReasoningEffort":"high"}],"source":"curated"}}}',
  'response:workspace.git.read':
    '{"type":"response","transportVersion":1,"id":"r-workspace-git","ok":true,"result":{"kind":"workspace.git.read","result":{"scope":"status","branch":"main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":[],"truncated":false}}}',
  'response:receipt.lookup':
    '{"type":"response","transportVersion":1,"id":"r-receipt","ok":true,"result":{"kind":"receipt.lookup","receipt":{"type":"host.receipt","protocolVersion":2,"commandId":"cmd-1","idempotencyKey":"idem-1","name":"composer.send","actor":{"actorId":"user-1","clientId":"client-desktop-1","clientClass":"desktop"},"authority":{"decision":"allow"},"status":"succeeded","commandFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":3,"cursor":11,"createdAt":"2026-08-03T17:00:00.000Z","updatedAt":"2026-08-03T17:00:01.000Z","resultSummary":"queued"}}}',
  'response:health.get':
    '{"type":"response","transportVersion":1,"id":"r-health","ok":true,"result":{"kind":"health.get","frame":{"type":"host.health","protocolVersion":2,"health":{"hostStatus":"ok","connectionPhase":"live","supervised":true,"freshness":"live"}}}}',
  'response:host.shutdown:stopping':
    '{"type":"response","transportVersion":1,"id":"r-shutdown","ok":true,"result":{"kind":"host.shutdown","state":"stopping"}}',
  'response:host.shutdown:already_stopping':
    '{"type":"response","transportVersion":1,"id":"r-shutdown-again","ok":true,"result":{"kind":"host.shutdown","state":"already_stopping"}}',
  'response:command.submit':
    '{"type":"response","transportVersion":1,"id":"r-cmd","ok":true,"result":{"kind":"command.submit","receipt":{"type":"host.receipt","protocolVersion":2,"commandId":"cmd-1","idempotencyKey":"idem-1","name":"composer.send","actor":{"actorId":"user-1","clientId":"client-desktop-1","clientClass":"desktop"},"authority":{"decision":"allow"},"status":"succeeded","commandFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":3,"cursor":11,"createdAt":"2026-08-03T17:00:00.000Z","updatedAt":"2026-08-03T17:00:01.000Z","resultSummary":"queued"}}}',
  'response:provider.status':
    '{"type":"response","transportVersion":1,"id":"r-provider.status","ok":true,"result":{"kind":"provider.status","statuses":[{"providerId":"codex","status":"ready","label":"Codex"}]}}',
  'response:provider.offers':
    '{"type":"response","transportVersion":1,"id":"r-provider.offers","ok":true,"result":{"kind":"provider.offers","offers":{"providerId":"codex","offerRevision":"catalog-r1","models":[{"modelId":"gpt-5.6","label":"GPT-5.6","available":true,"reasoning":[]}],"postures":[{"postureId":"plan","label":"Plan","available":true,"requiresExplicitConsent":true,"ceiling":"workspace_write"}]}}}',
  'response:provider.auth.flows':
    '{"type":"response","transportVersion":1,"id":"r-provider.auth.flows","ok":true,"result":{"kind":"provider.auth.flows","flows":[{"flowId":"browser","kind":"browser","label":"Browser","available":true}]}}',
  'response:provider.auth.status':
    '{"type":"response","transportVersion":1,"id":"r-provider.auth.status","ok":true,"result":{"kind":"provider.auth.status","status":{"providerId":"codex","state":"unauthenticated"}}}',
  'response:thread.history':
    '{"type":"response","transportVersion":1,"id":"r-thread.history","ok":true,"result":{"kind":"thread.history","page":{"threadId":"thread-1","generation":1,"cursor":3,"entries":[]}}}',
  'response:history.since':
    '{"type":"response","transportVersion":1,"id":"r-history.since","ok":true,"result":{"kind":"history.since","result":{"kind":"deltas","threadId":"thread-1","generation":1,"fromCursor":2,"toCursor":3,"deltas":[{"kind":"append","entry":{"entryId":"message-1","role":"assistant","createdAt":1,"text":"Hello"}}]}}}',
  'response:thread.catalogue':
    '{"type":"response","transportVersion":1,"id":"catalogue-error","ok":true,"result":{"kind":"thread.catalogue","reply":{"data":null,"error":{"code":"source_changed"}}}}',
  'response:twmission.export':
    '{"type":"response","transportVersion":1,"id":"r-tw","ok":true,"result":{"kind":"twmission.export","result":{"bundle":{"a":1}}}}',
  'error:unsupported_transport_version':
    '{"type":"response","transportVersion":1,"id":"err-unsupported_transport_version","ok":false,"error":{"code":"unsupported_transport_version"}}',
  'error:unknown_frame_kind':
    '{"type":"response","transportVersion":1,"id":"err-unknown_frame_kind","ok":false,"error":{"code":"unknown_frame_kind"}}',
  'error:unknown_request_kind':
    '{"type":"response","transportVersion":1,"id":"err-unknown_request_kind","ok":false,"error":{"code":"unknown_request_kind"}}',
  'error:invalid_frame':
    '{"type":"response","transportVersion":1,"id":"err-invalid_frame","ok":false,"error":{"code":"invalid_frame"}}',
  'error:missing_id':
    '{"type":"response","transportVersion":1,"id":"err-missing_id","ok":false,"error":{"code":"missing_id"}}',
  'error:oversize_id':
    '{"type":"response","transportVersion":1,"id":"err-oversize_id","ok":false,"error":{"code":"oversize_id"}}',
  'error:invalid_token':
    '{"type":"response","transportVersion":1,"id":"err-invalid_token","ok":false,"error":{"code":"invalid_token"}}',
  'error:invalid_payload':
    '{"type":"response","transportVersion":1,"id":"err-invalid_payload","ok":false,"error":{"code":"invalid_payload"}}',
  'error:unauthorized':
    '{"type":"response","transportVersion":1,"id":"err-unauthorized","ok":false,"error":{"code":"unauthorized"}}',
  'error:host_unavailable':
    '{"type":"response","transportVersion":1,"id":"err-host_unavailable","ok":false,"error":{"code":"host_unavailable"}}',
  'error:shutting_down':
    '{"type":"response","transportVersion":1,"id":"err-shutting_down","ok":false,"error":{"code":"shutting_down"}}',
  'event:deltas':
    '{"type":"event","transportVersion":1,"event":"deltas","sequence":7,"payload":{"type":"host.deltas","protocolVersion":2,"result":{"kind":"deltas","generation":3,"fromCursor":10,"toCursor":11,"deltas":[{"protocolVersion":2,"projectionVersion":2,"generation":3,"cursor":11,"previousCursor":10,"kind":"upsert","family":"thread","at":"2026-08-03T17:00:00.000Z","entityId":"thread-1","payload":{"title":"Mission"}}]}}}',
  'event:history':
    '{"type":"event","transportVersion":1,"event":"history","sequence":9,"payload":{"type":"host.history","protocolVersion":2,"threadId":"thread-1","result":{"kind":"deltas","threadId":"thread-1","generation":1,"fromCursor":2,"toCursor":3,"deltas":[]}}}',
  'event:health':
    '{"type":"event","transportVersion":1,"event":"health","sequence":8,"payload":{"type":"host.health","protocolVersion":2,"health":{"hostStatus":"ok","connectionPhase":"live","supervised":true,"freshness":"live"}}}',
  'event:host.closing': '{"type":"event","transportVersion":1,"event":"host.closing","sequence":9}'
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
        case 'thread.catalogue':
          frame = { ...base, kind, params: { method: 'list', limit: 25 } }
          break
        case 'thread.catalogue.maintenance':
          frame = {
            ...base,
            kind,
            params: { method: 'owner', owner: { writer: 'desktop', writerId: 'desktop-id' } }
          }
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
        case 'host.lease':
          frame = { ...base, kind, params: { action: 'renew', leaseId: 'lease-1' } }
          break
        case 'host.status':
          frame = { ...base, kind, params: {} }
          break
        case 'thread.owner':
          frame = {
            ...base,
            kind,
            params: {
              action: 'claim',
              threadId: 'thread-1',
              writerId: 'desktop-1',
              claimId: 1,
              baseRevision: 4,
              headRevision: 6
            }
          }
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

    it('accepts the shared provider model cap and rejects cap plus one', () => {
      const responseWithModelCount = (modelCount: number) => ({
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: 'offers-model-cap',
        ok: true,
        result: {
          kind: 'thread.offers',
          offers: {
            ...sampleThreadOffers(),
            models: Array.from({ length: modelCount }, (_, index) => ({
              id: `model-${index}`,
              label: `Model ${index}`,
              reasoningEfforts: []
            }))
          }
        }
      })

      expect(PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER).toBe(64)
      expect(
        decodeHostLocalTransportHostFrame(
          responseWithModelCount(PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER)
        )
      ).toMatchObject({ ok: true })
      expect(
        decodeHostLocalTransportHostFrame(
          responseWithModelCount(PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER + 1)
        )
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

  describe('Host lease and status request kinds (Host-lifetime programme)', () => {
    const request = (kind: 'host.lease' | 'host.status', params: unknown) => ({
      type: 'request',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: `req-${kind}`,
      kind,
      params
    })
    const response = (result: unknown) => ({
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: 'r-lease',
      ok: true,
      result
    })

    it('adds request kinds only: the event kind set is exactly what it was', () => {
      expect(HOST_LOCAL_TRANSPORT_REQUEST_KINDS).toEqual(
        expect.arrayContaining(['host.lease', 'host.status'])
      )
      expect([...HOST_LOCAL_TRANSPORT_EVENT_KINDS]).toEqual([
        'deltas',
        'history',
        'health',
        'host.closing'
      ])
    })

    it('round-trips every lease action and rejects malformed params', () => {
      for (const params of [
        { action: 'acquire' },
        { action: 'decline' },
        { action: 'renew', leaseId: 'lease-1' },
        { action: 'release', leaseId: 'lease-1' }
      ]) {
        const frame = request('host.lease', params)
        expect(decodeHostLocalTransportClientFrame(frame)).toEqual({ ok: true, value: frame })
      }
      for (const params of [
        {},
        { action: 'steal' },
        { action: 'acquire', leaseId: 'lease-1' },
        { action: 'renew' },
        { action: 'renew', leaseId: '' },
        { action: 'renew', leaseId: 'x'.repeat(HOST_LOCAL_TRANSPORT_MAX_ID + 1) },
        { action: 'release', leaseId: 'lease-1', force: true },
        'acquire'
      ]) {
        expect(decodeHostLocalTransportClientFrame(request('host.lease', params))).toEqual({
          ok: false,
          error: { code: 'invalid_payload' }
        })
      }
      expect(
        decodeHostLocalTransportClientFrame(request('host.status', { verbose: true }))
      ).toEqual({ ok: false, error: { code: 'invalid_payload' } })
    })

    it('round-trips lease results and rejects malformed or padded ones', () => {
      for (const result of [
        {
          kind: 'host.lease',
          action: 'acquire',
          leaseId: 'lease-1',
          heartbeatMs: 5000,
          ttlMs: 20000,
          hostNowMs: 0
        },
        {
          kind: 'host.lease',
          action: 'renew',
          leaseId: 'lease-1',
          expiresInMs: 20000,
          hostNowMs: 12
        },
        { kind: 'host.lease', action: 'release', released: true },
        { kind: 'host.lease', action: 'decline', declined: true }
      ]) {
        const frame = response(result)
        expect(decodeHostLocalTransportHostFrame(frame)).toEqual({ ok: true, value: frame })
      }
      for (const result of [
        {
          kind: 'host.lease',
          action: 'acquire',
          leaseId: 'lease-1',
          heartbeatMs: 0,
          ttlMs: 20000,
          hostNowMs: 0
        },
        {
          kind: 'host.lease',
          action: 'acquire',
          leaseId: 'lease-1',
          heartbeatMs: 5000,
          ttlMs: 20000,
          hostNowMs: -1
        },
        {
          kind: 'host.lease',
          action: 'acquire',
          leaseId: 'lease-1',
          heartbeatMs: 5000,
          ttlMs: 20000,
          hostNowMs: 0,
          extra: 1
        },
        { kind: 'host.lease', action: 'renew', leaseId: 'lease-1', expiresInMs: 1.5, hostNowMs: 0 },
        { kind: 'host.lease', action: 'release', released: false },
        { kind: 'host.lease', action: 'decline', declined: true, note: 'x' },
        { kind: 'host.lease', action: 'evict' }
      ]) {
        expect(decodeHostLocalTransportHostFrame(response(result))).toEqual({
          ok: false,
          error: { code: 'invalid_payload' }
        })
      }
    })

    it('passes a host.status record through for hostProtocol to decode and rejects anything else', () => {
      const frame = response({ kind: 'host.status', status: { pid: 1, unknown: true } })
      expect(decodeHostLocalTransportHostFrame(frame)).toEqual({ ok: true, value: frame })
      for (const result of [
        { kind: 'host.status' },
        { kind: 'host.status', status: 'up' },
        { kind: 'host.status', status: {}, extra: 1 }
      ]) {
        expect(decodeHostLocalTransportHostFrame(response(result))).toEqual({
          ok: false,
          error: { code: 'invalid_payload' }
        })
      }
    })
  })

  describe('thread owner request kind (thread log authority)', () => {
    const request = (params: unknown) => ({
      type: 'request',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: 'req-owner',
      kind: 'thread.owner',
      params
    })
    const response = (result: unknown) => ({
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: 'r-owner',
      ok: true,
      result
    })
    const epoch = { host: 'host-a', grant: 3 }
    const claim = {
      action: 'claim',
      threadId: 'thread-1',
      writerId: 'desktop-1',
      claimId: 7,
      baseRevision: 4,
      headRevision: 6
    }

    it('adds a request kind only: the event kind set is exactly what it was', () => {
      expect(HOST_LOCAL_TRANSPORT_REQUEST_KINDS).toContain('thread.owner')
      expect([...HOST_LOCAL_TRANSPORT_EVENT_KINDS]).toEqual([
        'deltas',
        'history',
        'health',
        'host.closing'
      ])
    })

    it('round-trips claim, release and advanced, and rejects anything else', () => {
      for (const params of [
        claim,
        { ...claim, claimId: 0, baseRevision: 0, headRevision: 0 },
        { ...claim, headRevision: Number.MAX_SAFE_INTEGER },
        { action: 'release', threadId: 'thread-1', epoch, revision: 9 },
        { action: 'release', threadId: 'thread-1', epoch, revision: null },
        { action: 'advanced', threadId: 'thread-1', epoch, revision: 0 }
      ]) {
        const frame = request(params)
        expect(decodeHostLocalTransportClientFrame(frame), JSON.stringify(params)).toEqual({
          ok: true,
          value: frame
        })
      }
      const { writerId: _writerId, ...withoutWriter } = claim
      for (const params of [
        {},
        'claim',
        { ...claim, action: 'declined' },
        { ...claim, threadId: '' },
        { ...claim, threadId: 'x'.repeat(HOST_LOCAL_TRANSPORT_MAX_ID + 1) },
        withoutWriter,
        { ...claim, writerId: '' },
        { ...claim, claimId: -1 },
        { ...claim, baseRevision: 1.5 },
        { ...claim, headRevision: Number.MAX_SAFE_INTEGER + 1 },
        { ...claim, baseRevision: 7 },
        { ...claim, epoch },
        { action: 'release', threadId: 'thread-1', epoch },
        { action: 'release', threadId: 'thread-1', epoch, revision: -1 },
        { action: 'release', threadId: 'thread-1', revision: 9 },
        { action: 'release', threadId: 'thread-1', epoch: { ...epoch, grant: 0 }, revision: 9 },
        { action: 'release', threadId: 'thread-1', epoch: { ...epoch, host: '' }, revision: 9 },
        { action: 'release', threadId: 'thread-1', epoch: { ...epoch, extra: 1 }, revision: 9 },
        { action: 'release', threadId: 'thread-1', epoch: [epoch.host, epoch.grant], revision: 9 },
        { action: 'advanced', threadId: 'thread-1', epoch, revision: null },
        { action: 'advanced', threadId: 'thread-1', epoch, revision: 9, writerId: 'desktop-1' }
      ]) {
        expect(
          decodeHostLocalTransportClientFrame(request(params)),
          JSON.stringify(params)
        ).toEqual({ ok: false, error: { code: 'invalid_payload' } })
      }
    })

    it('round-trips every owner result and rejects malformed or padded ones', () => {
      const granted = { threadId: 'thread-1', claimId: 7, granted: true, epoch }
      const refused = {
        threadId: 'thread-1',
        claimId: 7,
        granted: false,
        reason: 'host_ahead',
        revision: 8
      }
      for (const result of [
        { kind: 'thread.owner', action: 'claim', reply: granted },
        ...HOST_LOCAL_TRANSPORT_THREAD_CLAIM_REFUSALS.map((reason) => ({
          kind: 'thread.owner',
          action: 'claim',
          reply: { ...refused, reason }
        })),
        { kind: 'thread.owner', action: 'claim', reply: { ...refused, revision: null } },
        { kind: 'thread.owner', action: 'release', released: true },
        { kind: 'thread.owner', action: 'release', released: false },
        { kind: 'thread.owner', action: 'advanced', recorded: true },
        { kind: 'thread.owner', action: 'advanced', recorded: false }
      ]) {
        const frame = response(result)
        expect(decodeHostLocalTransportHostFrame(frame), JSON.stringify(result)).toEqual({
          ok: true,
          value: frame
        })
      }
      const { revision: _revision, ...withoutRevision } = refused
      for (const result of [
        { kind: 'thread.owner', action: 'claim' },
        { kind: 'thread.owner', action: 'claim', reply: granted, extra: 1 },
        { kind: 'thread.owner', action: 'claim', reply: { ...granted, reason: 'host_ahead' } },
        { kind: 'thread.owner', action: 'claim', reply: { ...granted, epoch: { host: 'a' } } },
        { kind: 'thread.owner', action: 'claim', reply: { ...granted, granted: 'yes' } },
        { kind: 'thread.owner', action: 'claim', reply: { ...refused, reason: 'busy' } },
        { kind: 'thread.owner', action: 'claim', reply: { ...refused, revision: -1 } },
        { kind: 'thread.owner', action: 'claim', reply: { ...refused, epoch } },
        { kind: 'thread.owner', action: 'claim', reply: withoutRevision },
        { kind: 'thread.owner', action: 'claim', reply: { ...refused, threadId: '' } },
        { kind: 'thread.owner', action: 'claim', reply: { ...refused, claimId: 0.5 } },
        { kind: 'thread.owner', action: 'release' },
        { kind: 'thread.owner', action: 'release', released: 1 },
        { kind: 'thread.owner', action: 'release', released: true, revision: 9 },
        { kind: 'thread.owner', action: 'advanced', recorded: 'true' },
        { kind: 'thread.owner', action: 'advanced', released: true },
        { kind: 'thread.owner', action: 'declined', recorded: true }
      ]) {
        expect(decodeHostLocalTransportHostFrame(response(result)), JSON.stringify(result)).toEqual(
          { ok: false, error: { code: 'invalid_payload' } }
        )
      }
    })
  })

  describe('pre-lease wire bytes', () => {
    // Recorded from a pristine worktree at 2a71f9580. The lease request kinds
    // landed on top of a6c49813f, twelve commits later; neither protocol module
    // changed in between, and these goldens replay green at a6c49813f. The
    // lease slice may add kinds; it may not move a byte of any frame an older
    // client or Host already speaks.
    it('encodes every pre-lease client frame byte-identically to the HEAD goldens', () => {
      const base = (kind: string) => ({
        type: 'request' as const,
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: `req-${kind}`
      })
      const frames: Record<string, HostLocalTransportClientFrame> = {
        hello: {
          type: 'hello',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          token: 'tok-'.padEnd(32, 'a'),
          hello: sampleHello()
        },
        'snapshot.get': { ...base('snapshot.get'), kind: 'snapshot.get', params: {} },
        'deltas.since': {
          ...base('deltas.since'),
          kind: 'deltas.since',
          params: { generation: 3, cursor: 10 }
        },
        'thread.offers': {
          ...base('thread.offers'),
          kind: 'thread.offers',
          params: { threadId: 'thread-1' }
        },
        'provider.status': { ...base('provider.status'), kind: 'provider.status', params: {} },
        'provider.offers': {
          ...base('provider.offers'),
          kind: 'provider.offers',
          params: { providerId: 'codex' }
        },
        'provider.auth.flows': {
          ...base('provider.auth.flows'),
          kind: 'provider.auth.flows',
          params: { providerId: 'codex' }
        },
        'provider.auth.status': {
          ...base('provider.auth.status'),
          kind: 'provider.auth.status',
          params: { providerId: 'codex' }
        },
        'thread.history': {
          ...base('thread.history'),
          kind: 'thread.history',
          params: { threadId: 'thread-1', limit: 25 }
        },
        'thread.catalogue': {
          ...base('thread.catalogue'),
          kind: 'thread.catalogue',
          params: { method: 'list', limit: 25 }
        },
        'thread.catalogue.maintenance': {
          ...base('thread.catalogue.maintenance'),
          kind: 'thread.catalogue.maintenance',
          params: { method: 'owner', owner: { writer: 'desktop', writerId: 'desktop-id' } }
        },
        'workspace.git.read': {
          ...base('workspace.git.read'),
          kind: 'workspace.git.read',
          params: { workspaceId: 'workspace-1', scope: 'status' }
        },
        'history.since': {
          ...base('history.since'),
          kind: 'history.since',
          params: { threadId: 'thread-1', since: { generation: 1, cursor: 2 } }
        },
        'receipt.lookup': {
          ...base('receipt.lookup'),
          kind: 'receipt.lookup',
          params: { commandId: 'cmd-1' }
        },
        'health.get': { ...base('health.get'), kind: 'health.get', params: {} },
        'host.shutdown': { ...base('host.shutdown'), kind: 'host.shutdown', params: {} },
        'command.submit': {
          ...base('command.submit'),
          kind: 'command.submit',
          params: sampleCommand()
        },
        'twmission.export': { ...base('twmission.export'), kind: 'twmission.export', params: {} },
        'thread.catalogue+background': {
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'catalogue-priority',
          kind: 'thread.catalogue',
          params: { method: 'summary', chatId: 'chat-1' },
          priority: 'background'
        }
      }
      expect(Object.keys(frames).sort()).toEqual(Object.keys(PRE_LEASE_CLIENT_GOLDENS).sort())
      for (const [label, frame] of Object.entries(frames)) {
        const encoded = encodeHostLocalTransportClientFrame(frame)
        expect(encoded.ok, label).toBe(true)
        if (!encoded.ok) continue
        expect(JSON.stringify(encoded.value), label).toBe(PRE_LEASE_CLIENT_GOLDENS[label])
      }
    })

    it('encodes every pre-lease host frame byte-identically to the HEAD goldens', () => {
      const receipt = sampleReceipt()
      const response = (
        id: string,
        result: Extract<HostLocalTransportResponse, { ok: true }>['result']
      ): HostLocalTransportHostFrame => ({
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result
      })
      const frames: Record<string, HostLocalTransportHostFrame> = {
        welcome: {
          type: 'welcome',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          welcome: sampleWelcome()
        },
        'response:snapshot.get': response('r-snap', {
          kind: 'snapshot.get',
          frame: sampleSnapshotFrame()
        }),
        'response:deltas.since': response('r-deltas', {
          kind: 'deltas.since',
          frame: sampleDeltasFrame()
        }),
        'response:thread.offers': response('r-offers', {
          kind: 'thread.offers',
          offers: sampleThreadOffers()
        }),
        'response:workspace.git.read': response('r-workspace-git', {
          kind: 'workspace.git.read',
          result: {
            scope: 'status',
            branch: 'main',
            head: 'a'.repeat(40),
            files: [],
            truncated: false
          }
        }),
        'response:receipt.lookup': response('r-receipt', { kind: 'receipt.lookup', receipt }),
        'response:health.get': response('r-health', {
          kind: 'health.get',
          frame: sampleHealthFrame()
        }),
        'response:host.shutdown:stopping': response('r-shutdown', {
          kind: 'host.shutdown',
          state: 'stopping'
        }),
        'response:host.shutdown:already_stopping': response('r-shutdown-again', {
          kind: 'host.shutdown',
          state: 'already_stopping'
        }),
        'response:command.submit': response('r-cmd', { kind: 'command.submit', receipt }),
        'response:provider.status': response('r-provider.status', {
          kind: 'provider.status',
          statuses: [{ providerId: 'codex', status: 'ready', label: 'Codex' }]
        }),
        'response:provider.offers': response('r-provider.offers', {
          kind: 'provider.offers',
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
                ceiling: 'workspace_write'
              }
            ]
          }
        }),
        'response:provider.auth.flows': response('r-provider.auth.flows', {
          kind: 'provider.auth.flows',
          flows: [{ flowId: 'browser', kind: 'browser', label: 'Browser', available: true }]
        }),
        'response:provider.auth.status': response('r-provider.auth.status', {
          kind: 'provider.auth.status',
          status: { providerId: 'codex', state: 'unauthenticated' }
        }),
        'response:thread.history': response('r-thread.history', {
          kind: 'thread.history',
          page: { threadId: 'thread-1', generation: 1, cursor: 3, entries: [] }
        }),
        'response:history.since': response('r-history.since', {
          kind: 'history.since',
          result: {
            kind: 'deltas',
            threadId: 'thread-1',
            generation: 1,
            fromCursor: 2,
            toCursor: 3,
            deltas: [
              {
                kind: 'append',
                entry: { entryId: 'message-1', role: 'assistant', createdAt: 1, text: 'Hello' }
              }
            ]
          }
        }),
        'response:thread.catalogue': response('catalogue-error', {
          kind: 'thread.catalogue',
          reply: { data: null, error: { code: 'source_changed' } }
        }),
        'response:twmission.export': response('r-tw', {
          kind: 'twmission.export',
          result: { bundle: { a: 1 } }
        }),
        'event:deltas': {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'deltas',
          sequence: 7,
          payload: sampleDeltasFrame()
        },
        'event:history': {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'history',
          sequence: 9,
          payload: {
            type: 'host.history',
            protocolVersion: 2,
            threadId: 'thread-1',
            result: {
              kind: 'deltas',
              threadId: 'thread-1',
              generation: 1,
              fromCursor: 2,
              toCursor: 3,
              deltas: []
            }
          }
        },
        'event:health': {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'health',
          sequence: 8,
          payload: sampleHealthFrame()
        },
        'event:host.closing': {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'host.closing',
          sequence: 9
        }
      }
      for (const code of HOST_LOCAL_TRANSPORT_ERROR_CODES) {
        frames[`error:${code}`] = {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: `err-${code}`,
          ok: false,
          error: { code }
        }
      }
      expect(Object.keys(frames).sort()).toEqual(Object.keys(PRE_LEASE_HOST_GOLDENS).sort())
      for (const [label, frame] of Object.entries(frames)) {
        const encoded = encodeHostLocalTransportHostFrame(frame)
        expect(encoded.ok, label).toBe(true)
        if (!encoded.ok || !('value' in encoded)) continue
        expect(JSON.stringify(encoded.value), label).toBe(PRE_LEASE_HOST_GOLDENS[label])
      }
    })
  })

  describe('thread catalogue request-local extensions', () => {
    it('preserves an additive background lane while leaving legacy foreground frames unchanged', () => {
      const base = {
        type: 'request' as const,
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: 'catalogue-priority',
        kind: 'thread.catalogue' as const,
        params: { method: 'summary' as const, chatId: 'chat-1' }
      }
      expect(decodeHostLocalTransportClientFrame({ ...base, priority: 'background' })).toEqual({
        ok: true,
        value: { ...base, priority: 'background' }
      })
      expect(decodeHostLocalTransportClientFrame(base)).toEqual({ ok: true, value: base })
      expect(decodeHostLocalTransportClientFrame({ ...base, priority: 'foreground' })).toEqual({
        ok: false,
        error: { code: 'invalid_payload' }
      })
    })

    it('accepts only body-free catalogue errors with a null legacy data fallback', () => {
      const response = (reply: unknown) =>
        decodeHostLocalTransportHostFrame({
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'catalogue-error',
          ok: true,
          result: { kind: 'thread.catalogue', reply }
        })
      expect(response({ data: null, error: { code: 'source_changed' } })).toMatchObject({
        ok: true,
        value: {
          result: { reply: { data: null, error: { code: 'source_changed' } } }
        }
      })
      expect(response({ data: { legacy: true } })).toMatchObject({ ok: true })
      for (const reply of [
        { data: 'sentinel', error: { code: 'source_changed' } },
        { data: null, error: { code: 'unknown' } },
        { data: null, error: { code: 'source_changed', detail: 'leak' } }
      ]) {
        expect(response(reply)).toEqual({ ok: false, error: { code: 'invalid_payload' } })
      }
    })
  })
})

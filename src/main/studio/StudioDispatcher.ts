/**
 * Binds the v1 Studio wire protocol to the durable revision store: a pure
 * request -> response mapping with no transport. Process lifecycle (spawning
 * the TaskWraithStudioCompanion app bundle, stdio plumbing, restart replay)
 * arrives in the companion-supervisor slice and must build on this seam.
 */
import {
  STUDIO_METHODS,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_SERVER_NAME,
  classifyStudioMessage,
  studioError,
  studioResult,
  type StudioEditOp,
  type StudioNotificationMessage,
  type StudioRequestMessage,
  type StudioResponseMessage
} from './StudioProtocol'
import type { StudioRevisionStore } from './StudioRevisionStore'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function handleRequest(
  store: StudioRevisionStore,
  request: StudioRequestMessage
): Promise<StudioResponseMessage> {
  switch (request.method) {
    case STUDIO_METHODS.hello: {
      const params = request.params
      if (!isRecord(params) || typeof params.protocolVersion !== 'number') {
        return studioError(request.id, 'invalid_params', 'hello requires a numeric protocolVersion')
      }
      if (params.protocolVersion !== STUDIO_PROTOCOL_VERSION) {
        return studioError(
          request.id,
          'unsupported_protocol_version',
          `protocol version ${params.protocolVersion} is not supported`,
          { supported: [STUDIO_PROTOCOL_VERSION] }
        )
      }
      return studioResult(request.id, {
        protocolVersion: STUDIO_PROTOCOL_VERSION,
        server: STUDIO_SERVER_NAME,
        revision: store.revision
      })
    }
    case STUDIO_METHODS.getDocument:
      return studioResult(request.id, { revision: store.revision, document: store.getDocument() })
    case STUDIO_METHODS.applyEdit: {
      const params = request.params
      if (!isRecord(params) || typeof params.baseRevision !== 'number' || !isRecord(params.op)) {
        return studioError(
          request.id,
          'invalid_params',
          'applyEdit requires { baseRevision: number, op: object }'
        )
      }
      const outcome = await store.applyEdit(
        params.baseRevision,
        params.op as unknown as StudioEditOp
      )
      if (outcome.ok) return studioResult(request.id, { revision: outcome.revision })
      return studioError(request.id, outcome.code, outcome.message, {
        currentRevision: outcome.currentRevision
      })
    }
    default:
      return studioError(request.id, 'method_not_found', `unknown method "${request.method}"`)
  }
}

/**
 * Handle one decoded NDJSON value. Returns the response to send, or null when
 * the message needs no reply (a notification, or a peer response echo).
 */
export async function handleStudioMessage(
  store: StudioRevisionStore,
  raw: unknown
): Promise<StudioResponseMessage | null> {
  const classified = classifyStudioMessage(raw)
  if (classified.kind === 'invalid') {
    return studioError(null, 'invalid_request', classified.reason)
  }
  if (classified.kind !== 'request') return null
  try {
    return await handleRequest(store, classified.message)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return studioError(classified.message.id, 'store_failure', detail)
  }
}

/** Event pushed to companions after each committed edit (transport arrives later). */
export function buildEditCommittedNotification(
  revision: number,
  op: StudioEditOp
): StudioNotificationMessage {
  return { jsonrpc: '2.0', method: STUDIO_METHODS.editCommitted, params: { revision, op } }
}

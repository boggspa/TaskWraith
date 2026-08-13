/**
 * Binds the v1 Studio wire protocol to the durable revision store: a pure
 * request -> response mapping with no transport. Process lifecycle (spawning
 * the TaskWraithStudioCompanion app bundle, stdio plumbing, restart replay)
 * arrives in the companion-supervisor slice and must build on this seam.
 */
import {
  STUDIO_METHODS,
  STUDIO_OPEN_MEDIA_SCHEMA_VERSION,
  STUDIO_PROPOSAL_SCHEMA_VERSION,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_SERVER_NAME,
  classifyStudioMessage,
  studioError,
  studioResult,
  type StudioDocumentOperation,
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
    case STUDIO_METHODS.openMedia: {
      const params = request.params
      if (
        !isRecord(params) ||
        params.schemaVersion !== STUDIO_OPEN_MEDIA_SCHEMA_VERSION ||
        typeof params.baseRevision !== 'number' ||
        typeof params.assetId !== 'string' ||
        typeof params.path !== 'string' ||
        params.mediaKind !== 'video'
      ) {
        return studioError(
          request.id,
          'invalid_params',
          `openMedia requires schemaVersion ${STUDIO_OPEN_MEDIA_SCHEMA_VERSION}, baseRevision, assetId, path and mediaKind=video`
        )
      }
      const outcome = await store.openMedia(params.baseRevision, {
        assetId: params.assetId,
        path: params.path,
        mediaKind: params.mediaKind
      })
      if (outcome.ok) {
        return studioResult(request.id, {
          schemaVersion: STUDIO_OPEN_MEDIA_SCHEMA_VERSION,
          revision: outcome.revision,
          asset: outcome.asset
        })
      }
      return studioError(request.id, outcome.code, outcome.message, {
        currentRevision: outcome.currentRevision
      })
    }
    case STUDIO_METHODS.proposeEdit: {
      const params = request.params
      if (
        !isRecord(params) ||
        params.schemaVersion !== STUDIO_PROPOSAL_SCHEMA_VERSION ||
        typeof params.baseRevision !== 'number' ||
        typeof params.proposalId !== 'string' ||
        !isRecord(params.op)
      ) {
        return studioError(
          request.id,
          'invalid_params',
          `proposeEdit requires schemaVersion ${STUDIO_PROPOSAL_SCHEMA_VERSION}, baseRevision, proposalId and op`
        )
      }
      const outcome = await store.proposeEdit(
        params.baseRevision,
        params.proposalId,
        params.op as unknown as StudioEditOp
      )
      if (outcome.ok) {
        return studioResult(request.id, {
          schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
          revision: outcome.revision,
          proposal: outcome.proposal
        })
      }
      return studioError(request.id, outcome.code, outcome.message, {
        currentRevision: outcome.currentRevision
      })
    }
    case STUDIO_METHODS.resolveProposal: {
      const params = request.params
      if (
        !isRecord(params) ||
        params.schemaVersion !== STUDIO_PROPOSAL_SCHEMA_VERSION ||
        typeof params.baseRevision !== 'number' ||
        typeof params.proposalId !== 'string' ||
        (params.decision !== 'accept' && params.decision !== 'reject')
      ) {
        return studioError(
          request.id,
          'invalid_params',
          `resolveProposal requires schemaVersion ${STUDIO_PROPOSAL_SCHEMA_VERSION}, baseRevision, proposalId and decision=accept|reject`
        )
      }
      const outcome = await store.resolveProposal(
        params.baseRevision,
        params.proposalId,
        params.decision
      )
      if (outcome.ok) {
        return studioResult(request.id, {
          schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
          revision: outcome.revision,
          proposalId: outcome.proposalId,
          decision: outcome.decision,
          ...(outcome.appliedOp === undefined ? {} : { appliedOp: outcome.appliedOp })
        })
      }
      return studioError(request.id, outcome.code, outcome.message, {
        currentRevision: outcome.currentRevision
      })
    }
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
  op: StudioDocumentOperation
): StudioNotificationMessage {
  return { jsonrpc: '2.0', method: STUDIO_METHODS.editCommitted, params: { revision, op } }
}

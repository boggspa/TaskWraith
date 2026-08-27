import type { ProviderId, RunQueueRequestSnapshot } from '../store/types'

export type PreparedSoloSteerPayload = Pick<
  RunQueueRequestSnapshot,
  | 'imageAttachments'
  | 'discordContextSelection'
  | 'projectReferenceContextSelection'
  | 'dmTargetParticipantId'
  | 'exactPickerParticipantId'
  | 'externalPathGrants'
>

export type QualifiedExactFullToolBatchSteerProvider =
  | 'claude'
  | 'kimi'
  | 'mistral'
  | 'grok'
  | 'ollama'

export type SoloSteerBoundaryAcceleration = 'exact-full-tool-batch' | 'natural-boundary'

export interface PreparedSoloSteerPayloadDecision {
  /** Payload eligibility only; the provider transport may still decline live delivery. */
  delivery: 'live' | 'durable-boundary'
  /** Human-readable explanation suitable for the durable queue status. */
  reason: string
  /** The fastest qualified fallback available for this provider. */
  boundaryAcceleration: SoloSteerBoundaryAcceleration
  /** Paths that may be forwarded to a live Codex turn/steer request. */
  liveImagePaths: string[]
}

export interface ClassifyPreparedSoloSteerPayloadInput {
  provider: ProviderId
  request: PreparedSoloSteerPayload | null | undefined
  /**
   * Exact main-resolved, chat-owned paths for `request.imageAttachments`.
   * Renderer-nominated paths must never be passed to this seam.
   */
  verifiedImagePaths?: readonly string[]
}

export function hasQualifiedExactFullToolBatchAccelerator(
  provider: ProviderId
): provider is QualifiedExactFullToolBatchSteerProvider {
  switch (provider) {
    case 'claude':
    case 'kimi':
    case 'mistral':
    case 'grok':
    case 'ollama':
      return true
    case 'gemini':
    case 'codex':
    case 'cursor':
    case 'antigravity':
    case 'pi':
    case 'muse':
      return false
    default:
      return assertNeverProvider(provider)
  }
}

/**
 * Classify the structured payload belonging to a main-prepared solo steer.
 *
 * The durable queue request remains the authority for every shape-changing
 * field. Text-only requests can try the provider's live transport. Codex and
 * the negotiated ACP transports may additionally carry image inputs, but only
 * after main has resolved one owned path for every prepared attachment. Directed
 * routing, context selections, project references, and external path grants
 * always cross a fresh durable run boundary because a text/image live frame
 * cannot preserve those semantics.
 */
export function classifyPreparedSoloSteerPayload(
  input: ClassifyPreparedSoloSteerPayloadInput
): PreparedSoloSteerPayloadDecision {
  const boundaryAcceleration = hasQualifiedExactFullToolBatchAccelerator(input.provider)
    ? 'exact-full-tool-batch'
    : 'natural-boundary'
  const request = input.request
  if (!request) {
    return durableBoundary(
      boundaryAcceleration,
      'Prepared steer request metadata is unavailable; preserve the durable queue boundary.'
    )
  }

  const structuredShapes: string[] = []
  if (request.discordContextSelection) structuredShapes.push('Discord context')
  if (request.projectReferenceContextSelection?.referenceIds.length) {
    structuredShapes.push('project references')
  }
  if (
    nonEmptyString(request.dmTargetParticipantId) ||
    nonEmptyString(request.exactPickerParticipantId)
  ) {
    structuredShapes.push('directed participant routing')
  }
  if (request.externalPathGrants?.length) structuredShapes.push('external path grants')

  if (structuredShapes.length > 0) {
    return durableBoundary(
      boundaryAcceleration,
      `This steer includes ${joinNaturalLanguage(structuredShapes)}, which requires durable boundary delivery.`
    )
  }

  const attachmentCount = request.imageAttachments?.length ?? 0
  const verifiedImagePaths = normalizedPaths(input.verifiedImagePaths)
  if (attachmentCount === 0) {
    if (verifiedImagePaths.length > 0) {
      return durableBoundary(
        boundaryAcceleration,
        'Verified image paths do not match the prepared steer attachment set; preserve the durable queue boundary.'
      )
    }
    return {
      delivery: 'live',
      reason: 'The prepared steer payload contains only live-deliverable text.',
      boundaryAcceleration,
      liveImagePaths: []
    }
  }

  if (!providerSupportsLiveImageSteer(input.provider)) {
    return durableBoundary(
      boundaryAcceleration,
      'Image attachments require durable boundary delivery because this provider transport has no verified live image-steer lane.'
    )
  }

  if (verifiedImagePaths.length !== attachmentCount) {
    return durableBoundary(
      boundaryAcceleration,
      'Live image steering requires one verified main-owned path for every prepared image attachment.'
    )
  }

  return {
    delivery: 'live',
    reason: `${input.provider} can deliver the prepared text and verified image paths through its negotiated live steering transport.`,
    boundaryAcceleration,
    liveImagePaths: verifiedImagePaths
  }
}

function providerSupportsLiveImageSteer(provider: ProviderId): boolean {
  return (
    provider === 'codex' || provider === 'kimi' || provider === 'mistral' || provider === 'grok'
  )
}

function durableBoundary(
  boundaryAcceleration: SoloSteerBoundaryAcceleration,
  reason: string
): PreparedSoloSteerPayloadDecision {
  return {
    delivery: 'durable-boundary',
    reason,
    boundaryAcceleration,
    liveImagePaths: []
  }
}

function normalizedPaths(paths: readonly string[] | undefined): string[] {
  return (paths || []).map((path) => path.trim()).filter(Boolean)
}

function nonEmptyString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function joinNaturalLanguage(values: readonly string[]): string {
  if (values.length <= 1) return values[0] || 'structured context'
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`
}

function assertNeverProvider(provider: never): never {
  throw new Error(`Unhandled steering payload provider: ${String(provider)}`)
}

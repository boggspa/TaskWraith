import type { HostProjectionDiscoveryProcessIdentity } from '../host-client/HostProjectionClient'
import {
  createHostPermissionConsentProof,
  type HostPermissionConsentProofRequest
} from '../host-runtime/HostPermissionConsent'
import type { HostCommand } from '../shared/hostProtocol'
import type { HostProviderOffersProjection } from '../shared/hostSetupProtocol'

export interface TuiFullAccessHostProcessBinding {
  readonly pid: number
  readonly startedAt: string
  readonly hostId: string
  readonly hostVersion: string
}

/**
 * Opaque, process-memory-only authority retained by the interactive TUI.
 * The bootstrap secret is never exposed after construction.
 */
export interface TuiFullAccessPresence {
  matches(identity: HostProjectionDiscoveryProcessIdentity | null): boolean
  authorizeConfigure(command: HostCommand): HostCommand
  dispose(): void
}

const FULL_ACCESS_UNAVAILABLE_DETAIL =
  'Start a fresh standalone Host from this TUI to confirm Full Access user presence.'

function validBinding(binding: TuiFullAccessHostProcessBinding): boolean {
  const parsed = new Date(binding.startedAt)
  return (
    Number.isSafeInteger(binding.pid) &&
    binding.pid > 0 &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === binding.startedAt &&
    binding.hostId.length > 0 &&
    binding.hostVersion.length > 0
  )
}

function proofRequest(command: HostCommand): HostPermissionConsentProofRequest {
  if (
    command.name !== 'thread.configure' ||
    command.arguments.postureId !== 'full_access' ||
    command.arguments.postureConsent !== true ||
    typeof command.target.threadId !== 'string' ||
    typeof command.arguments.providerId !== 'string' ||
    typeof command.arguments.modelId !== 'string' ||
    typeof command.arguments.offerRevision !== 'string' ||
    command.arguments.postureConsentProof !== undefined
  ) {
    throw new TypeError('Full Access proof requires one exact consented configure command.')
  }
  return {
    commandId: command.commandId,
    actor: { ...command.actor },
    threadId: command.target.threadId,
    providerId: command.arguments.providerId,
    modelId: command.arguments.modelId,
    postureId: 'full_access',
    offerRevision: command.arguments.offerRevision,
    issuedAt: command.issuedAt
  }
}

class OwnedTuiFullAccessPresence implements TuiFullAccessPresence {
  private secret: Buffer | null
  private readonly binding: TuiFullAccessHostProcessBinding

  constructor(secret: Buffer, binding: TuiFullAccessHostProcessBinding) {
    if (!Buffer.isBuffer(secret) || secret.byteLength !== 32 || !validBinding(binding)) {
      throw new TypeError('TUI Full Access presence input is invalid.')
    }
    this.secret = Buffer.from(secret)
    this.binding = { ...binding }
  }

  matches(identity: HostProjectionDiscoveryProcessIdentity | null): boolean {
    return Boolean(
      this.secret &&
      identity &&
      identity.pid === this.binding.pid &&
      identity.startedAt === this.binding.startedAt &&
      identity.hostId === this.binding.hostId &&
      identity.hostVersion === this.binding.hostVersion
    )
  }

  authorizeConfigure(command: HostCommand): HostCommand {
    const secret = this.secret
    if (!secret) throw new Error('TUI Full Access user presence is no longer active.')
    const request = proofRequest(command)
    return {
      ...command,
      actor: { ...command.actor },
      target: { ...command.target },
      arguments: {
        ...command.arguments,
        postureConsentProof: createHostPermissionConsentProof(secret, request)
      }
    }
  }

  dispose(): void {
    this.secret?.fill(0)
    this.secret = null
  }
}

/** Copies the caller-owned source once; the caller remains responsible for zeroing its source. */
export function createTuiFullAccessPresence(
  secret: Buffer,
  binding: TuiFullAccessHostProcessBinding
): TuiFullAccessPresence {
  return new OwnedTuiFullAccessPresence(secret, binding)
}

/**
 * Preserve the Host's exact dynamic offer and revision. This only narrows the
 * Full Access row when this TUI cannot prove a matching launch presence.
 */
export function projectTuiFullAccessPresence(
  offers: HostProviderOffersProjection,
  presenceAvailable: boolean
): HostProviderOffersProjection {
  if (presenceAvailable) return offers
  return {
    ...offers,
    models: offers.models.map((model) => ({
      ...model,
      reasoning: model.reasoning.map((reasoning) => ({ ...reasoning }))
    })),
    postures: offers.postures.map((posture) =>
      posture.postureId === 'full_access' && posture.available
        ? { ...posture, available: false, detail: FULL_ACCESS_UNAVAILABLE_DETAIL }
        : { ...posture }
    )
  }
}

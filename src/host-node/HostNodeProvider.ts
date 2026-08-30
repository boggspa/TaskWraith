/**
 * Generic contract for a provider adapter inside the pure-Node Host.
 *
 * A provider factory declares its identity, static catalog, and runtime
 * capabilities (approvals/questions). `create()` receives a transport-neutral
 * run port and an interaction resolver; the resulting instance exposes the
 * narrow surface the Host domain consumes.
 */

import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'
import type { HostProviderRunPort } from '../host-runtime/HostProviderRunPort'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'

export interface HostNodeProviderRunRequest {
  readonly runId: string
  readonly threadId: string
  readonly prompt: string
  readonly target: HostRunEventTarget
}

export interface HostNodeProviderRunResult {
  readonly runId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly sessionId?: string
  readonly exitCode?: number | null
}

/** Runtime instance returned by a provider factory. */
export interface HostNodeProviderInstance {
  readonly providerId: string
  /** Optional live offer refresh for providers whose runnable catalog is account-dependent. */
  getOffers?(): Promise<HostProviderOffersProjection>
  getStatus(): Promise<HostProviderStatusProjection>
  getAuthStatus(): Promise<HostProviderAuthStatusProjection>
  getAuthFlows(): Promise<readonly HostProviderAuthFlowProjection[]>
  beginAuth(operationId: string): Promise<void>
  cancelAuth(operationId: string): Promise<boolean>
  run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult>
  cancel(runId: string): boolean
  shutdown(): Promise<void>
}

export interface HostNodeProviderCreateInput {
  readonly runPort: HostProviderRunPort
  readonly interactions: HostNodeInteractionResolver
}

/**
 * Static factory for one provider adapter. It carries the catalog and
 * capability flags; the Host constructs instances after the profile run port
 * and interaction registry are available.
 */
export interface HostNodeProvider {
  readonly providerId: string
  /** Explicit marker for the one non-static provider whose adapter rechecks its consent/auth wall. */
  readonly conditionalAdmission?: 'antigravity-live-guarded'
  readonly displayProvider: string
  readonly shortCode: string
  readonly offers: HostProviderOffersProjection
  readonly supportsApprovals: boolean
  readonly supportsQuestions: boolean
  create(input: HostNodeProviderCreateInput): HostNodeProviderInstance
}

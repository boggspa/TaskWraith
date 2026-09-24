import {
  createEmptyHostSnapshot,
  type HostCommand,
  type HostAuthenticatedClientIdentity,
  type HostCursorPosition,
  type HostDeltasSinceResult,
  type HostHealthProjection,
  type HostSnapshot
} from '../shared/hostProtocol'

import {
  isExactHostActorIdentity,
  type HostAuthority,
  type HostAuthorityCallContext,
  type HostAuthorityReceiptLookup,
  type HostAuthorityReceiptResult,
  type HostAuthorityResult
} from './HostAuthority'

export const HOST_DIAGNOSTIC_CAPABILITIES = ['bootstrap', 'snapshot', 'health'] as const
export const HOST_DIAGNOSTIC_WARNING_CODE = 'diagnostic_mode'
export const HOST_DIAGNOSTIC_DETAIL =
  'Diagnostic Host: authenticated snapshot and health only; persistent state and commands are unavailable.'

export interface HostDiagnosticAuthorityOptions {
  readonly now?: () => number
}

/**
 * Read-only, in-memory Authority for the standalone diagnostic Host.
 *
 * It intentionally has no store, provider, run, approval, or command executor.
 * The projection is explicit degraded state, not fabricated live telemetry.
 */
export class HostDiagnosticAuthority implements HostAuthority {
  private readonly now: () => number

  constructor(options: HostDiagnosticAuthorityOptions = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  getPosition(): HostCursorPosition {
    return { generation: 0, cursor: 0 }
  }

  async snapshot(
    context: HostAuthorityCallContext,
    _cursor?: HostCursorPosition
  ): Promise<HostAuthorityResult<HostSnapshot>> {
    if (!this.isAuthenticatedContext(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: true, value: this.createSnapshot() }
  }

  async deltas(
    context: HostAuthorityCallContext,
    _since: HostCursorPosition
  ): Promise<HostAuthorityResult<HostDeltasSinceResult>> {
    if (!this.isAuthenticatedContext(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: false, error: 'host_unavailable' }
  }

  async command(
    context: HostAuthorityCallContext,
    _command: HostCommand
  ): Promise<HostAuthorityResult<never>> {
    if (!this.isAuthenticatedContext(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: false, error: 'host_unavailable' }
  }

  async receipt(
    context: HostAuthorityCallContext,
    _lookup: HostAuthorityReceiptLookup
  ): Promise<HostAuthorityReceiptResult> {
    if (!this.isAuthenticatedContext(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: false, error: 'host_unavailable' }
  }

  async health(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<HostHealthProjection>> {
    if (!this.isAuthenticatedContext(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: true, value: this.createHealth() }
  }

  async shutdown(context: HostAuthorityCallContext): Promise<HostAuthorityResult<never>> {
    if (!this.isAuthenticatedContext(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: false, error: 'host_unavailable' }
  }

  private isAuthenticatedContext(context: HostAuthorityCallContext): boolean {
    if (!context || !isExactHostActorIdentity(context.actor)) return false
    return this.clientMatchesActor(context.client, context.actor)
  }

  private clientMatchesActor(
    client: HostAuthenticatedClientIdentity,
    actor: HostAuthorityCallContext['actor']
  ): boolean {
    return (
      Boolean(client) &&
      typeof client.clientId === 'string' &&
      client.clientId.length > 0 &&
      client.clientId === actor.clientId &&
      client.clientClass === actor.clientClass &&
      typeof client.clientVersion === 'string' &&
      client.clientVersion.length > 0
    )
  }

  private createHealth(): HostHealthProjection {
    return {
      hostStatus: 'degraded',
      detail: HOST_DIAGNOSTIC_DETAIL,
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    }
  }

  private createSnapshot(): HostSnapshot {
    const at = this.now()
    const snapshot = createEmptyHostSnapshot({
      generation: 0,
      cursor: 0,
      freshness: 'live',
      generatedAt: new Date(at).toISOString()
    })
    snapshot.health = this.createHealth()
    snapshot.warnings = [
      {
        warningId: 'diagnostic-host-mode',
        severity: 'warning',
        code: HOST_DIAGNOSTIC_WARNING_CODE,
        message: HOST_DIAGNOSTIC_DETAIL,
        at
      }
    ]
    snapshot.recovery = {
      reopenStatus: 'degraded',
      detail: 'Diagnostic mode has no persistent recovery journal.'
    }
    return snapshot
  }
}

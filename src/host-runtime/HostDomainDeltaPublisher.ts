/**
 * Domain-effect → HostDeltaStore publisher (Host Arc Wave 2D-2 Lane F).
 *
 * Validates compact domain-effect DTOs, then appends through an injected
 * HostDeltaStore port. Domain effects are limited to upsert / remove /
 * tombstone — generation-reset is rejected (store owns generation fences).
 *
 * Batch semantics:
 * - Validate the full batch before any append.
 * - Preserve input order on success.
 * - Return position only from the sole store (never fabricate cursors).
 * - Surface mid-batch store rejections/errors as partial so callers cannot
 *   claim full success after a partial journal advance.
 *
 * Payload privacy reuses HostDeltaStore.prepareHostDeltaPayload: forbidden
 * structured keys never reach append; oversized safe payloads retain only
 * length + digest. No domain observer, command, receipt, or composition-root
 * wiring lives here.
 */

import {
  HOST_PROTOCOL_MAX_ID,
  type HostCursorPosition,
  type HostDeltaFamily
} from '../shared/hostProtocol'
import {
  HOST_DELTA_FORBIDDEN_PAYLOAD_CODE,
  prepareHostDeltaPayload,
  type HostDeltaAppendInput,
  type HostDeltaAppendResult,
  type HostDeltaPayloadPrivacyCode
} from './HostDeltaStore'

/** Domain effects never mint generation fences. */
export type HostDomainEffectKind = 'upsert' | 'remove' | 'tombstone'

/** Compact domain-effect DTO accepted by the publisher. */
export interface HostDomainEffectDto {
  kind: HostDomainEffectKind | string
  family: HostDeltaFamily | string
  entityId: string
  /** Required for upsert; forbidden for remove/tombstone. */
  payload?: unknown
  /** Optional ISO timestamp; store mints when omitted. */
  at?: string
}

/** Injected sole journal authority — typically HostDeltaStore. */
export interface HostDomainDeltaStorePort {
  append: (input: HostDeltaAppendInput) => HostDeltaAppendResult
  getPosition: () => HostCursorPosition
}

export interface HostDomainDeltaPublisherOptions {
  store: HostDomainDeltaStorePort
}

export type HostDomainDeltaValidationReason =
  | 'invalid_kind'
  | 'generation_reset_forbidden'
  | 'invalid_family'
  | 'invalid_entity_id'
  | 'payload_required'
  | 'payload_forbidden'
  | 'forbidden_payload'
  | 'invalid_at'

export interface HostDomainDeltaValidationFailure {
  index: number
  reason: HostDomainDeltaValidationReason
  detail: string
  code?: HostDeltaPayloadPrivacyCode
}

export type HostDomainDeltaPublishResult =
  | {
      kind: 'published'
      position: HostCursorPosition
      count: number
      results: HostDeltaAppendResult[]
    }
  | {
      kind: 'rejected'
      reason: 'validation_failed'
      failures: HostDomainDeltaValidationFailure[]
      /** Sole-store position before any append was attempted. */
      position: HostCursorPosition
    }
  | {
      kind: 'partial'
      /** Sole-store position after the last successful append (if any). */
      position: HostCursorPosition
      publishedCount: number
      results: HostDeltaAppendResult[]
      failedAtIndex: number
      failure:
        | { kind: 'append_rejected'; result: HostDeltaAppendResult }
        | { kind: 'store_error'; detail: string }
    }
  | {
      kind: 'store_error'
      detail: string
      /** Position when readable; null only if getPosition itself fails. */
      position: HostCursorPosition | null
    }

const DOMAIN_EFFECT_KINDS = new Set<string>(['upsert', 'remove', 'tombstone'])

const DOMAIN_EFFECT_FAMILIES = new Set<string>([
  'workspace',
  'thread',
  'run',
  'mission',
  'round',
  'participant',
  'provider',
  'routing',
  'question',
  'approval',
  'schedule',
  'usage',
  'artifact',
  'warning',
  'recovery',
  'health',
  'snapshot-meta'
])

interface PreparedDomainEffect {
  index: number
  input: HostDeltaAppendInput
}

/**
 * Validate one domain-effect DTO into a store append input.
 * Does not touch the journal.
 */
export function validateHostDomainEffect(
  effect: unknown,
  index = 0
):
  | { ok: true; prepared: PreparedDomainEffect }
  | { ok: false; failure: HostDomainDeltaValidationFailure } {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
    return {
      ok: false,
      failure: {
        index,
        reason: 'invalid_kind',
        detail: 'domain effect must be an object'
      }
    }
  }

  const raw = effect as Record<string, unknown>
  const kindRaw = raw.kind

  if (kindRaw === 'generation-reset') {
    return {
      ok: false,
      failure: {
        index,
        reason: 'generation_reset_forbidden',
        detail:
          'domain effects cannot publish generation-reset; HostDeltaStore owns generation fences'
      }
    }
  }

  if (typeof kindRaw !== 'string' || !DOMAIN_EFFECT_KINDS.has(kindRaw)) {
    return {
      ok: false,
      failure: {
        index,
        reason: 'invalid_kind',
        detail: `kind must be upsert|remove|tombstone (got ${String(kindRaw)})`
      }
    }
  }
  const kind = kindRaw as HostDomainEffectKind

  if (typeof raw.family !== 'string' || !DOMAIN_EFFECT_FAMILIES.has(raw.family)) {
    return {
      ok: false,
      failure: {
        index,
        reason: 'invalid_family',
        detail: `family must be an exact HostDeltaFamily (got ${String(raw.family)})`
      }
    }
  }
  const family = raw.family as HostDeltaFamily

  if (
    typeof raw.entityId !== 'string' ||
    raw.entityId.length === 0 ||
    raw.entityId.length > HOST_PROTOCOL_MAX_ID ||
    raw.entityId.trim().length === 0
  ) {
    return {
      ok: false,
      failure: {
        index,
        reason: 'invalid_entity_id',
        detail: `entityId must be a non-empty string ≤ ${HOST_PROTOCOL_MAX_ID} chars`
      }
    }
  }
  const entityId = raw.entityId

  if (raw.at !== undefined) {
    if (typeof raw.at !== 'string' || raw.at.trim().length === 0 || raw.at.length > 80) {
      return {
        ok: false,
        failure: {
          index,
          reason: 'invalid_at',
          detail: 'at must be a non-empty ISO-like string ≤ 80 chars when provided'
        }
      }
    }
  }

  if (kind === 'upsert') {
    if (raw.payload === undefined) {
      return {
        ok: false,
        failure: {
          index,
          reason: 'payload_required',
          detail: 'upsert requires a compact payload'
        }
      }
    }
    const prepared = prepareHostDeltaPayload(raw.payload)
    if (!prepared.ok) {
      return {
        ok: false,
        failure: {
          index,
          reason: 'forbidden_payload',
          detail: prepared.detail,
          code: prepared.code
        }
      }
    }
    const input: HostDeltaAppendInput = {
      kind: 'upsert',
      family,
      entityId,
      payload: prepared.payload
    }
    if (typeof raw.at === 'string') {
      input.at = raw.at
    }
    return { ok: true, prepared: { index, input } }
  }

  // remove / tombstone — payload must be absent
  if (raw.payload !== undefined) {
    return {
      ok: false,
      failure: {
        index,
        reason: 'payload_forbidden',
        detail: `${kind} must not carry a payload`
      }
    }
  }

  const input: HostDeltaAppendInput = {
    kind,
    family,
    entityId,
    ...(kind === 'tombstone' ? { tombstone: true as const } : {})
  }
  if (typeof raw.at === 'string') {
    input.at = raw.at
  }
  return { ok: true, prepared: { index, input } }
}

/**
 * Validate a full batch without appending.
 * Returns all failures so callers can fix the batch atomically.
 */
export function validateHostDomainEffectBatch(
  effects: readonly unknown[]
):
  | { ok: true; prepared: PreparedDomainEffect[] }
  | { ok: false; failures: HostDomainDeltaValidationFailure[] } {
  if (!Array.isArray(effects)) {
    return {
      ok: false,
      failures: [
        {
          index: -1,
          reason: 'invalid_kind',
          detail: 'effects must be an array'
        }
      ]
    }
  }

  const prepared: PreparedDomainEffect[] = []
  const failures: HostDomainDeltaValidationFailure[] = []

  for (let i = 0; i < effects.length; i += 1) {
    const result = validateHostDomainEffect(effects[i], i)
    if (result.ok) {
      prepared.push(result.prepared)
    } else {
      failures.push(result.failure)
    }
  }

  if (failures.length > 0) {
    return { ok: false, failures }
  }
  return { ok: true, prepared }
}

export class HostDomainDeltaPublisher {
  private readonly store: HostDomainDeltaStorePort

  constructor(options: HostDomainDeltaPublisherOptions) {
    if (!options?.store) {
      throw new Error('HostDomainDeltaPublisher requires an injected HostDeltaStore port')
    }
    if (
      typeof options.store.append !== 'function' ||
      typeof options.store.getPosition !== 'function'
    ) {
      throw new Error('HostDomainDeltaPublisher store must provide append and getPosition')
    }
    this.store = options.store
  }

  /** Read sole-store position without fabricating cursors. */
  getPosition(): HostCursorPosition {
    return this.store.getPosition()
  }

  /**
   * Publish a batch of domain effects through the sole HostDeltaStore journal.
   * Validates the full batch first; appends only when every DTO is valid.
   */
  publish(
    effects: readonly HostDomainEffectDto[] | readonly unknown[]
  ): HostDomainDeltaPublishResult {
    let prePosition: HostCursorPosition
    try {
      prePosition = this.store.getPosition()
    } catch (err) {
      return {
        kind: 'store_error',
        detail: `getPosition failed: ${err instanceof Error ? err.message : String(err)}`,
        position: null
      }
    }

    const validated = validateHostDomainEffectBatch(effects)
    if (!validated.ok) {
      return {
        kind: 'rejected',
        reason: 'validation_failed',
        failures: validated.failures,
        position: prePosition
      }
    }

    const results: HostDeltaAppendResult[] = []

    for (const item of validated.prepared) {
      let appendResult: HostDeltaAppendResult
      try {
        appendResult = this.store.append(item.input)
      } catch (err) {
        let position: HostCursorPosition
        try {
          position = this.store.getPosition()
        } catch {
          position = prePosition
        }
        return {
          kind: 'partial',
          position,
          publishedCount: results.length,
          results,
          failedAtIndex: item.index,
          failure: {
            kind: 'store_error',
            detail: err instanceof Error ? err.message : String(err)
          }
        }
      }

      if (appendResult.kind === 'rejected') {
        let position: HostCursorPosition
        try {
          position = this.store.getPosition()
        } catch {
          position = appendResult.position
        }
        return {
          kind: 'partial',
          position,
          publishedCount: results.length,
          results,
          failedAtIndex: item.index,
          failure: { kind: 'append_rejected', result: appendResult }
        }
      }

      // appended | duplicate — both advance journal authority honestly
      results.push(appendResult)
    }

    let position: HostCursorPosition
    try {
      position = this.store.getPosition()
    } catch (err) {
      // Appends may have landed; surface store_error with last known append position if any.
      const last = results[results.length - 1]
      return {
        kind: 'store_error',
        detail: `getPosition failed after append: ${err instanceof Error ? err.message : String(err)}`,
        position: last && 'position' in last ? last.position : prePosition
      }
    }

    return {
      kind: 'published',
      position,
      count: results.length,
      results
    }
  }
}

export { HOST_DELTA_FORBIDDEN_PAYLOAD_CODE }

import type { HumanCollaborationShare } from './HumanCollaborationStore'

export const PEOPLE_TO_CHANNEL_FINALIZATION_SCOPE_VERSION = 1
export const CHANNELS_WORKSPACE_BOOTSTRAP_CONTRACT_VERSION = 1

/**
 * P5 product contract. Workspace bootstrap creates no collaboration object:
 * Channels arise only through an explicit Channel action or migration.
 */
export const CHANNELS_WORKSPACE_BOOTSTRAP_CONTRACT = Object.freeze({
  schemaVersion: CHANNELS_WORKSPACE_BOOTSTRAP_CONTRACT_VERSION,
  authority: 'channels',
  channelCreation: 'explicit-action-or-migration',
  automaticPeopleShare: 'none',
  legacyRetention: 'sealed-p4-compatibility-only'
} as const)

/**
 * The terminal scope is captured from the one quiesced People generation and
 * encrypted with the finalization execution. New P5 captures always retain
 * nothing. The retained-id field remains in schema v1 solely so an exact
 * nonempty list already sealed by P4 can be recovered as compatibility state.
 */
export interface PeopleToChannelMigrationFinalizationScope {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_SCOPE_VERSION
  retireShareIds: string[]
  retainedWorkspaceBootstrapShareIds: string[]
}

export class PeopleToChannelMigrationFinalizationScopeError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationFinalizationScopeError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationFinalizationScopeError(message)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function shareId(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 512) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function canonicalArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(shareId) &&
    new Set(value).size === value.length &&
    value.every((id, index) => index === 0 || compareText(value[index - 1]!, id) < 0)
  )
}

/** Validates the encrypted checkpoint form without consulting mutable People state. */
export function validatePeopleToChannelMigrationFinalizationScope(
  value: unknown
): PeopleToChannelMigrationFinalizationScope {
  const raw = objectRecord(value)
  if (
    !raw ||
    Object.keys(raw).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(raw, 'schemaVersion') ||
    !Object.prototype.hasOwnProperty.call(raw, 'retireShareIds') ||
    !Object.prototype.hasOwnProperty.call(raw, 'retainedWorkspaceBootstrapShareIds') ||
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_FINALIZATION_SCOPE_VERSION ||
    !canonicalArray(raw.retireShareIds) ||
    !canonicalArray(raw.retainedWorkspaceBootstrapShareIds)
  ) {
    blocked('People migration finalization scope is invalid')
  }
  const retired = raw.retireShareIds
  const retained = raw.retainedWorkspaceBootstrapShareIds
  if (retired.some((id) => retained.includes(id))) {
    blocked('People migration finalization scope overlaps retired and retained shares')
  }
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_SCOPE_VERSION,
    retireShareIds: [...retired],
    retainedWorkspaceBootstrapShareIds: [...retained]
  }
}

export type PeopleToChannelWorkspaceBootstrapCompatibility =
  | { kind: 'none'; shareIds: [] }
  | { kind: 'sealed-p4-compatibility'; shareIds: string[] }

/**
 * Classifies only a validated encrypted checkpoint. A nonempty list is exact
 * compatibility state from P4; this projection cannot establish a producer.
 */
export function classifyPeopleToChannelWorkspaceBootstrapCompatibility(
  value: unknown
): PeopleToChannelWorkspaceBootstrapCompatibility {
  const scope = validatePeopleToChannelMigrationFinalizationScope(value)
  return scope.retainedWorkspaceBootstrapShareIds.length === 0
    ? { kind: 'none', shareIds: [] }
    : {
        kind: 'sealed-p4-compatibility',
        shareIds: [...scope.retainedWorkspaceBootstrapShareIds]
      }
}

/**
 * Partitions a new frozen source generation under the P5 product contract.
 * Every People share is retired; only validation of an already-sealed schema
 * may produce nonempty compatibility state.
 */
export function derivePeopleToChannelMigrationFinalizationScope(input: {
  shares: readonly Pick<HumanCollaborationShare, 'shareId'>[]
}): PeopleToChannelMigrationFinalizationScope {
  const raw = objectRecord(input)
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'shares') || !Array.isArray(raw.shares)) {
    blocked('People migration finalization scope is invalid')
  }
  if (Object.keys(raw).length !== 1) {
    blocked(
      'People migration finalization capture cannot declare a workspace-bootstrap People producer'
    )
  }
  const sourceShareIds: string[] = []
  for (const share of raw.shares) {
    const id = (share as Pick<HumanCollaborationShare, 'shareId'> | undefined)?.shareId
    if (!shareId(id)) {
      blocked('People migration finalization source share id is invalid')
    }
    sourceShareIds.push(id)
  }
  if (new Set(sourceShareIds).size !== sourceShareIds.length) {
    blocked('People migration finalization source share ids are duplicated')
  }
  return validatePeopleToChannelMigrationFinalizationScope({
    schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_SCOPE_VERSION,
    retireShareIds: sourceShareIds.sort(compareText),
    retainedWorkspaceBootstrapShareIds: []
  })
}

export function isPeopleToChannelMigrationFinalizationScopeError(
  error: unknown
): error is PeopleToChannelMigrationFinalizationScopeError {
  return (
    error instanceof PeopleToChannelMigrationFinalizationScopeError &&
    error.code === 'recovery_blocked'
  )
}

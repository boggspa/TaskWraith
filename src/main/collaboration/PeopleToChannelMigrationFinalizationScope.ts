import type { HumanCollaborationShare } from './HumanCollaborationStore'

export const PEOPLE_TO_CHANNEL_FINALIZATION_SCOPE_VERSION = 1

/**
 * The terminal scope is captured from the one quiesced People generation and
 * encrypted with the finalization execution. `retainedWorkspaceBootstrapShareIds`
 * is deliberately an explicit, P5-owned exception: every other legacy share
 * is retired, including disabled records whose old invite/session material
 * must no longer survive the cutover.
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

/**
 * Partitions the frozen source records once. A caller may name only shares
 * whose P5 workspace-bootstrap authority it owns; the result makes both the
 * exception and the retirement targets immutable before recovery is fenced.
 */
export function derivePeopleToChannelMigrationFinalizationScope(input: {
  shares: readonly Pick<HumanCollaborationShare, 'shareId'>[]
  retainedWorkspaceBootstrapShareIds?: readonly string[]
}): PeopleToChannelMigrationFinalizationScope {
  if (!input || !Array.isArray(input.shares)) {
    blocked('People migration finalization scope is invalid')
  }
  const sourceShareIds = input.shares.map((share) => share?.shareId)
  if (sourceShareIds.some((id) => !shareId(id))) {
    blocked('People migration finalization source share id is invalid')
  }
  const knownShareIds = new Set(sourceShareIds)
  if (knownShareIds.size !== sourceShareIds.length) {
    blocked('People migration finalization source share ids are duplicated')
  }
  const retained = [...(input.retainedWorkspaceBootstrapShareIds ?? [])]
  if (retained.some((id) => !shareId(id))) {
    blocked('People migration finalization retained share id is invalid')
  }
  const retainedIds = new Set(retained)
  if (retainedIds.size !== retained.length) {
    blocked('People migration finalization retained share ids are duplicated')
  }
  if ([...retainedIds].some((id) => !knownShareIds.has(id))) {
    blocked('People migration finalization retained share is absent from the frozen source')
  }
  return validatePeopleToChannelMigrationFinalizationScope({
    schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_SCOPE_VERSION,
    retireShareIds: sourceShareIds.filter((id) => !retainedIds.has(id)).sort(compareText),
    retainedWorkspaceBootstrapShareIds: retained.sort(compareText)
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

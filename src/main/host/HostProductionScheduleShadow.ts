/**
 * Host Arc Track3 Mixed Wave A — scheduled-task / workflow shadow → Host family.
 *
 * WHAT THIS IS. Desktop schedules live as ScheduledTask / WorkflowDefinition
 * rows keyed by a store-minted id. Host schedule cards on the wire use the
 * same id so clients can join. This adapter owns the allowlisted mapping into
 * HostScheduleProjection without importing electron, AppStore, or store types.
 *
 * BOUNDARIES:
 * - zero electron / AppStore / ScheduledTask / WorkflowDefinition value imports;
 * - constructs allowlisted HostScheduleProjection fields only;
 * - never forwards prompt / displayPrompt / template bodies onto the wire —
 *   title only, bounded;
 * - never invents scheduleId or threadId (bad ids are skipped / omitted).
 *
 * HONESTY:
 * - a throwing listSchedules propagates (fail closed, never a false empty);
 * - every listSchedules call re-reads (no cache of a moving set).
 */

import type { HostScheduleProjection } from '../../shared/hostProtocol'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_SCHEDULE_ID_MAX = 512
/** Title bound — matches hostProtocol HOST_PROTOCOL_MAX_SHORT. */
const HOST_SCHEDULE_TITLE_MAX = 200

/**
 * Thin scheduled-task / workflow row shape the composition root adapts from
 * AppStore (or any equivalent). Deliberately narrow so this module never
 * pulls store symbols — and never admits a prompt body field.
 */
export interface HostScheduleShadowEntry {
  readonly scheduleId: string
  readonly title: string
  readonly enabled: boolean
  /** Epoch ms of the next fire, when known. */
  readonly nextFireAt?: number
  readonly threadId?: string
}

/**
 * Optional schedules port for createHostProductionBootstrap /
 * createHostProductionSuppliers. Defined here so Wave A can land the
 * adapter without widening Suppliers in the same edit.
 */
export interface HostProductionScheduleListPort {
  listSchedules(): HostScheduleProjection[]
}

export interface HostProductionScheduleShadowDeps {
  listSchedules: () => readonly HostScheduleShadowEntry[]
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function boundText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function parseNextFireAtMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (!Number.isInteger(value) || value < 0) return undefined
  return value
}

/**
 * Map narrow schedule entries into allowlisted HostScheduleProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionScheduleShadow}.
 */
export function mapScheduleShadowsToHostSchedules(
  entries: readonly HostScheduleShadowEntry[]
): HostScheduleProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostScheduleProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.scheduleId)) continue
    if (entry.scheduleId.length > HOST_SCHEDULE_ID_MAX) continue

    if (typeof entry.enabled !== 'boolean') continue

    const titleRaw =
      typeof entry.title === 'string' && entry.title.trim().length > 0 ? entry.title.trim() : ''
    if (titleRaw.length === 0) continue

    // ALLOWLIST REBUILD: only these fields reach the wire — never prompt bodies.
    const row: HostScheduleProjection = {
      scheduleId: entry.scheduleId,
      title: boundText(titleRaw, HOST_SCHEDULE_TITLE_MAX),
      enabled: entry.enabled
    }

    const nextFireAt = parseNextFireAtMs(entry.nextFireAt)
    if (nextFireAt !== undefined) row.nextFireAt = nextFireAt

    if (isUsableId(entry.threadId) && entry.threadId.length <= HOST_SCHEDULE_ID_MAX) {
      row.threadId = entry.threadId
    }

    rows.push(row)
  }
  return rows
}

/**
 * Build the optional `schedules` port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export function createHostProductionScheduleShadow(
  deps: HostProductionScheduleShadowDeps
): HostProductionScheduleListPort {
  if (!deps || typeof deps.listSchedules !== 'function') {
    throw new Error('HostProductionScheduleShadow requires listSchedules to be a function')
  }
  return {
    listSchedules(): HostScheduleProjection[] {
      // Live read every call — no caching of a moving schedule set.
      // Throws propagate: fail closed, never paint a false empty.
      return mapScheduleShadowsToHostSchedules(deps.listSchedules())
    }
  }
}

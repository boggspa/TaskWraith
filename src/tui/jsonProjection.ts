import type { TwMissionManifest } from '../host-shared/twmission'
import type { HostSnapshot } from '../shared/hostProtocol'
import type { TaskWraithTuiState } from './state'

export type TaskWraithTuiJsonProjectionSource = 'host' | 'demo' | 'twmission-replay'

export interface TaskWraithTuiJsonProjection {
  readonly schemaVersion: 1
  readonly source: TaskWraithTuiJsonProjectionSource
  readonly hostVersion?: string
  readonly generation: number
  readonly cursor: number
  readonly freshness: HostSnapshot['freshness']
  readonly selectedThreadId?: string
  readonly manifest?: TwMissionManifest
  readonly snapshot: HostSnapshot
}

/**
 * Build the machine-readable TUI projection without reinterpreting Host state.
 * The complete bounded snapshot stays intact, including body-free question
 * receipt correlations, so JSON consumers observe the same generation/cursor
 * and identifiers as Desktop and paired iOS.
 */
export function buildTaskWraithTuiJsonProjection(
  state: Pick<TaskWraithTuiState, 'hostProjection' | 'hostVersion' | 'selectedThreadId'>,
  source: TaskWraithTuiJsonProjectionSource,
  manifest?: TwMissionManifest
): TaskWraithTuiJsonProjection {
  const snapshot = state.hostProjection
  if (!snapshot) throw new Error('No coherent Host projection is available for JSON output.')
  return {
    schemaVersion: 1,
    source,
    ...(state.hostVersion ? { hostVersion: state.hostVersion } : {}),
    generation: snapshot.generation,
    cursor: snapshot.cursor,
    freshness: snapshot.freshness,
    ...(state.selectedThreadId ? { selectedThreadId: state.selectedThreadId } : {}),
    ...(manifest ? { manifest } : {}),
    snapshot
  }
}

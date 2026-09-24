import type { PeopleMigrationDeletionScope } from './PeopleMigrationHelperLease'
import type { PeopleToChannelMigrationFinalizationProductionRunResult } from '../collaboration/PeopleToChannelMigrationFinalizationProductionRunner'

export const PEOPLE_MIGRATION_HELPER_ARG = '--taskwraith-people-migration-helper'
export const PEOPLE_MIGRATION_HELPER_RESULT_LIMIT = 192 * 1024 * 1024
export type PeopleMigrationResult = Omit<
  PeopleToChannelMigrationFinalizationProductionRunResult,
  'legacyWriteGate'
>

export interface PeopleMigrationHelperRequest {
  type: 'initialize'
  nonce: string
  parentPid: number
  profilePath: string
  appName: string
  runtimeInstanceId: string
  segmented: boolean
  defaultProvider?: string
  /** Resume the old migration before a scoped cold purge; never author a new deletion. */
  deletionScope?: PeopleMigrationDeletionScope
}

export function isPeopleMigrationHelper(argv: readonly string[] = process.argv): boolean {
  return argv.includes(PEOPLE_MIGRATION_HELPER_ARG)
}

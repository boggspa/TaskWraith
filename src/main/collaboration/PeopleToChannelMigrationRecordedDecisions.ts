import type { PeopleToChannelMigrationCutoverDecisions } from './PeopleToChannelMigrationRecoveryStore'

/**
 * Product choices explicitly supplied by the user for the P4 cutover. This is
 * not a fallback: recovery preparation still requires a caller to pass all
 * three values and persists them immutably with the migration intent.
 *
 * `all-general-chats` is additive to the planner's invariant that every active
 * People share migrates, including one attached to a non-General chat.
 */
export const RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS = Object.freeze({
  generalChatScope: 'all-general-chats',
  legacyProjectionHistory: 'import-then-reset',
  peopleRetirementTiming: 'after-p4-acceptance'
} as const satisfies PeopleToChannelMigrationCutoverDecisions)

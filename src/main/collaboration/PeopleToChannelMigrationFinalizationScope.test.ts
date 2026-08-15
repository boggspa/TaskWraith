import { describe, expect, it } from 'vitest'

import {
  CHANNELS_WORKSPACE_BOOTSTRAP_CONTRACT,
  PeopleToChannelMigrationFinalizationScopeError,
  classifyPeopleToChannelWorkspaceBootstrapCompatibility,
  derivePeopleToChannelMigrationFinalizationScope,
  validatePeopleToChannelMigrationFinalizationScope
} from './PeopleToChannelMigrationFinalizationScope'

describe('derivePeopleToChannelMigrationFinalizationScope', () => {
  it('records the Channel-native workspace-bootstrap product contract', () => {
    expect(CHANNELS_WORKSPACE_BOOTSTRAP_CONTRACT).toEqual({
      schemaVersion: 1,
      authority: 'channels',
      channelCreation: 'explicit-action-or-migration',
      automaticPeopleShare: 'none',
      legacyRetention: 'sealed-p4-compatibility-only'
    })
    expect(Object.isFrozen(CHANNELS_WORKSPACE_BOOTSTRAP_CONTRACT)).toBe(true)
  })

  it('freezes every People share for retirement without creating a new retention exception', () => {
    expect(
      derivePeopleToChannelMigrationFinalizationScope({
        shares: [
          { shareId: 'disabled_legacy' },
          { shareId: 'legacy_bootstrap' },
          { shareId: 'live' }
        ]
      })
    ).toEqual({
      schemaVersion: 1,
      retireShareIds: ['disabled_legacy', 'legacy_bootstrap', 'live'],
      retainedWorkspaceBootstrapShareIds: []
    })
  })

  it('does not leave an empty source generation unclassified', () => {
    expect(
      derivePeopleToChannelMigrationFinalizationScope({
        shares: []
      })
    ).toEqual({
      schemaVersion: 1,
      retireShareIds: [],
      retainedWorkspaceBootstrapShareIds: []
    })
  })

  it('rejects fresh retention declarations and malformed source ids', () => {
    const shares = [{ shareId: 'known' }]
    expect(() =>
      derivePeopleToChannelMigrationFinalizationScope({
        shares,
        retainedWorkspaceBootstrapShareIds: ['known']
      } as unknown as Parameters<typeof derivePeopleToChannelMigrationFinalizationScope>[0])
    ).toThrow(/cannot declare a workspace-bootstrap People producer/)
    expect(() =>
      derivePeopleToChannelMigrationFinalizationScope({
        shares: [{ shareId: ' bad' }]
      })
    ).toThrow(/source share id is invalid/)
  })

  it('accepts only a canonical, non-overlapping encrypted-checkpoint form', () => {
    expect(
      validatePeopleToChannelMigrationFinalizationScope({
        schemaVersion: 1,
        retireShareIds: ['ordinary'],
        retainedWorkspaceBootstrapShareIds: ['p5']
      })
    ).toEqual({
      schemaVersion: 1,
      retireShareIds: ['ordinary'],
      retainedWorkspaceBootstrapShareIds: ['p5']
    })
    expect(() =>
      validatePeopleToChannelMigrationFinalizationScope({
        schemaVersion: 1,
        retireShareIds: ['two', 'one'],
        retainedWorkspaceBootstrapShareIds: []
      })
    ).toThrow(PeopleToChannelMigrationFinalizationScopeError)
    expect(() =>
      validatePeopleToChannelMigrationFinalizationScope({
        schemaVersion: 1,
        retireShareIds: ['same'],
        retainedWorkspaceBootstrapShareIds: ['same']
      })
    ).toThrow(/overlaps/)
  })

  it('classifies nonempty ids only as exact sealed P4 compatibility state', () => {
    expect(
      classifyPeopleToChannelWorkspaceBootstrapCompatibility({
        schemaVersion: 1,
        retireShareIds: ['ordinary'],
        retainedWorkspaceBootstrapShareIds: ['legacy_bootstrap']
      })
    ).toEqual({
      kind: 'sealed-p4-compatibility',
      shareIds: ['legacy_bootstrap']
    })
    expect(
      classifyPeopleToChannelWorkspaceBootstrapCompatibility({
        schemaVersion: 1,
        retireShareIds: ['ordinary'],
        retainedWorkspaceBootstrapShareIds: []
      })
    ).toEqual({ kind: 'none', shareIds: [] })
    expect(() =>
      classifyPeopleToChannelWorkspaceBootstrapCompatibility({
        schemaVersion: 1,
        retireShareIds: [],
        retainedWorkspaceBootstrapShareIds: ['duplicate', 'duplicate']
      })
    ).toThrow(PeopleToChannelMigrationFinalizationScopeError)
  })
})

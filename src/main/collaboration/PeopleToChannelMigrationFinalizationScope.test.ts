import { describe, expect, it } from 'vitest'

import {
  PeopleToChannelMigrationFinalizationScopeError,
  derivePeopleToChannelMigrationFinalizationScope,
  validatePeopleToChannelMigrationFinalizationScope
} from './PeopleToChannelMigrationFinalizationScope'

describe('derivePeopleToChannelMigrationFinalizationScope', () => {
  it('freezes every ordinary People share for retirement while retaining only the P5 exception', () => {
    expect(
      derivePeopleToChannelMigrationFinalizationScope({
        shares: [{ shareId: 'disabled_legacy' }, { shareId: 'p5_bootstrap' }, { shareId: 'live' }],
        retainedWorkspaceBootstrapShareIds: ['p5_bootstrap']
      })
    ).toEqual({
      schemaVersion: 1,
      retireShareIds: ['disabled_legacy', 'live'],
      retainedWorkspaceBootstrapShareIds: ['p5_bootstrap']
    })
  })

  it('allows an empty P5 exception without leaving a source share unclassified', () => {
    expect(
      derivePeopleToChannelMigrationFinalizationScope({
        shares: [{ shareId: 'one' }, { shareId: 'two' }]
      })
    ).toEqual({
      schemaVersion: 1,
      retireShareIds: ['one', 'two'],
      retainedWorkspaceBootstrapShareIds: []
    })
  })

  it('rejects duplicate, unknown, and malformed retention declarations', () => {
    const shares = [{ shareId: 'known' }]
    expect(() =>
      derivePeopleToChannelMigrationFinalizationScope({
        shares,
        retainedWorkspaceBootstrapShareIds: ['known', 'known']
      })
    ).toThrow(PeopleToChannelMigrationFinalizationScopeError)
    expect(() =>
      derivePeopleToChannelMigrationFinalizationScope({
        shares,
        retainedWorkspaceBootstrapShareIds: ['absent']
      })
    ).toThrow(/absent from the frozen source/)
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
})

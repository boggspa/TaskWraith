import { describe, expect, it } from 'vitest'
import {
  applyCatalogueEdits,
  catalogueEditBase,
  mergeCatalogueDisplay
} from './threadCatalogueMerge'
import type { ChatListItem, ChatRecord } from '../main/store/types'

describe('bounded catalogue chrome', () => {
  const canonical = {
    appChatId: 'chat',
    title: 'Newer canonical title',
    provider: 'claude',
    pinned: false,
    messages: [{ id: 'm', content: 'all historical content' }],
    runs: [{ runId: 'r' }],
    activeGoal: {
      id: 'g',
      objective: 'complete objective',
      specification: { body: 'full specification' },
      runtimeLedger: { intervals: ['full ledger'] }
    },
    ensemble: { participants: [{ id: 'p', instructions: 'full seat instructions' }] },
    delegationContext: { delegationPrompt: 'full delegation context' },
    providerMetadata: { selectedModelType: 'model', signedPermissionGrant: { signature: 'grant' } }
  } as unknown as ChatRecord

  function row(): ChatListItem {
    const value = {
      ...canonical,
      title: 'Older displayed title',
      messages: [],
      runs: [],
      activeGoal: { id: 'g', objective: 'preview' },
      ensemble: { participants: [{ id: 'p' }] },
      providerMetadata: { selectedModelType: 'model' },
      summaryOnly: true,
      catalogueProjection: true,
      messageCount: 1,
      runCount: 1
    } as unknown as ChatListItem
    value.catalogueEditBase = catalogueEditBase(value)
    return value
  }

  it('applies a pin edit without rolling back a newer title or truncating canonical context', () => {
    const incoming = row()
    incoming.pinned = true
    const saved = applyCatalogueEdits(canonical, incoming)
    expect(saved).toEqual({ ...canonical, pinned: true })
    expect(saved.messages).toBe(canonical.messages)
    expect(saved.ensemble).toBe(canonical.ensemble)
  })

  it('merges a composer edit into canonical metadata without dropping its other fields', () => {
    const incoming = row()
    incoming.providerMetadata = { selectedModelType: 'chosen' }
    expect(applyCatalogueEdits(canonical, incoming).providerMetadata).toEqual({
      ...canonical.providerMetadata,
      selectedModelType: 'chosen'
    })
  })

  it('keeps full goals, rosters, grants and delegation context on a display refresh', () => {
    const merged = mergeCatalogueDisplay(canonical, row())
    expect(merged.activeGoal).toBe(canonical.activeGoal)
    expect(merged.ensemble).toBe(canonical.ensemble)
    expect(merged.delegationContext).toBe(canonical.delegationContext)
    expect(merged.providerMetadata).toEqual(canonical.providerMetadata)
    expect((merged as ChatListItem).catalogueProjection).toBeUndefined()
  })

  it('never stamps newer catalogue revision onto an older hydrated transcript', () => {
    const loaded = { ...canonical, persistenceRevision: 1 }
    const incoming = { ...row(), persistenceRevision: 2, messageCount: 2 }
    const merged = mergeCatalogueDisplay(loaded, incoming)
    expect(merged.persistenceRevision).toBe(1)
    expect(merged.messages).toBe(loaded.messages)
  })
})

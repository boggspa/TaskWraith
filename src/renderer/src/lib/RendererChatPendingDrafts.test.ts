import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { RendererChatPendingDrafts } from './RendererChatPendingDrafts'
import { mergeChatUpdatedForRender } from './chatUpdateRenderMerge'

// This isolates the ordinary broadcast after the complete persistence chain
// covered by RendererChatTranscriptPersistence.integration.test.ts.
// The canonical store is safe, but App currently has no retained conflict DTO.
describe('renderer recovery conflict draft retention', () => {
  it('retains a conflicting local title when the rejected whole-save broadcasts canonical', () => {
    const before: ChatRecord = {
      appChatId: 'chat-1',
      provider: 'mistral',
      scope: 'global',
      title: 'Old title',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      persistenceRevision: 3,
      messages: [
        { id: 'm1', role: 'user', content: 'Original', timestamp: '2026-09-08T10:00:00.000Z' }
      ],
      runs: [{ runId: 'run-1', status: 'running', startedAt: '2026-09-08T10:00:00.000Z' }]
    }
    const optimistic: ChatRecord = {
      ...before,
      messages: [
        ...before.messages,
        { id: 'm2', role: 'user', content: 'Pending', timestamp: '2026-09-08T12:00:00.000Z' }
      ]
    }
    const recovered: ChatRecord = {
      ...optimistic,
      title: 'Canonical rename',
      updatedAt: 2,
      persistenceRevision: 4,
      runs: [
        {
          ...before.runs[0],
          status: 'failed',
          endedAt: '2026-09-08T11:00:00.000Z',
          staleSettlementProvenance: {
            schemaVersion: 1,
            origin: 'stale-run-reconciler',
            runId: 'run-1',
            settledAt: '2026-09-08T11:00:00.000Z',
            previousStatus: 'running',
            authoredEndedAt: true,
            authoredExitCode: true
          }
        }
      ]
    }
    const drafts = new RendererChatPendingDrafts()
    drafts.trackTarget(optimistic)
    const recovery = drafts.advance(optimistic, recovered, {
      ...optimistic,
      title: 'My local draft'
    })
    if (!recovery) throw new Error('Unexpected stale recovery')
    expect(recovery.conflicts).toContain('title')
    const canonical = { ...recovered, updatedAt: 3, persistenceRevision: 5 }
    const acknowledged = drafts.advance(recovered, canonical, recovery.record)
    if (!acknowledged) throw new Error('Unexpected stale ACK')
    expect(acknowledged.record.persistenceRevision).toBe(3)
    expect(acknowledged.record.title).toBe('My local draft')

    // ChatService rejects revision 3 and returns canonical revision 5.
    // save-chat broadcasts that return even for rejection; App frame merging
    // receives it here. No draft/conflict state survives elsewhere today.
    const rendered = mergeChatUpdatedForRender(canonical, {
      liveChat: acknowledged.record,
      messagesChanged: true,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(rendered.runs[0].status).toBe('failed')
    const kept = drafts.apply(canonical, rendered, acknowledged.record)
    expect(kept.title).toBe('My local draft')
    expect(kept.persistenceRevision).toBe(3)
    expect(drafts.conflicts('chat-1')).toContain('title')
    expect(Object.keys(kept)).not.toContain('conflicts')
    expect(Object.keys(kept)).not.toContain('pendingDraft')

    const partial = {
      ...canonical,
      title: 'Summary rename',
      summaryOnly: true,
      runs: [],
      messages: []
    }
    expect(drafts.apply(partial, partial, kept).title).toBe('My local draft')
    expect(drafts.has('chat-1')).toBe(true)

    // A full canonical acknowledgement of the local value resolves the draft.
    const accepted = { ...canonical, title: 'My local draft', persistenceRevision: 6 }
    expect(drafts.apply(accepted, accepted, kept).persistenceRevision).toBe(6)
    expect(drafts.has('chat-1')).toBe(false)

    // Discard cancels draft retention for callbacks from an older local target.
    drafts.discard('chat-1')
    expect(drafts.advance(optimistic, recovered, kept)).toBeNull()
    expect(drafts.advance(recovered, canonical, kept)).toBeNull()
    expect(drafts.apply(canonical, canonical, kept)).toBe(canonical)
    drafts.trackTarget(kept)
    expect(drafts.advance(kept, accepted, kept)).not.toBeNull()
  })
})

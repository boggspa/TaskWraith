import { describe, expect, it } from 'vitest'
import type { ChatRecord, ContinuationProposalSnapshot } from '../../../main/store/types'
import { threadTitleSourceFingerprint } from '../../../shared/threadTitles'
import type { ComposerContinuationCheckpoint } from './composerContinuationCheckpoint'
import {
  applyLocalAiTitleProposal,
  buildComposerContinuationProposalRequest,
  buildContinuationTitleApplyRequest
} from './composerContinuationProposal'

const checkpoint: ComposerContinuationCheckpoint = {
  schemaVersion: 2,
  id: 'continuation-v2:abc12345',
  titleId: 'continuation-title-v1:def67890',
  phase: 'working',
  roundState: 'partial-success',
  hasUserRequest: true,
  hasSettledAssistant: true,
  titleNeedsProposal: true
}

describe('buildComposerContinuationProposalRequest', () => {
  it('sends only chat identity, invalidation key, and purpose', () => {
    expect(buildComposerContinuationProposalRequest('chat-1', checkpoint, 'draft')).toEqual({
      schemaVersion: 2,
      chatId: 'chat-1',
      contextVersion: `${checkpoint.id}:draft`,
      purpose: 'draft'
    })
  })

  it('uses the first-prompt title version instead of streaming draft context', () => {
    expect(buildComposerContinuationProposalRequest('chat-1', checkpoint, 'title')).toMatchObject({
      contextVersion: `${checkpoint.titleId}:title`,
      purpose: 'title'
    })
  })

  it('requires a settled turn for drafts and eligible provenance for titles', () => {
    expect(
      buildComposerContinuationProposalRequest(
        'chat-1',
        { ...checkpoint, hasSettledAssistant: false },
        'draft'
      )
    ).toBeNull()
    expect(
      buildComposerContinuationProposalRequest(
        'chat-1',
        { ...checkpoint, titleNeedsProposal: false },
        'title'
      )
    ).toBeNull()
  })
})

describe('applyLocalAiTitleProposal', () => {
  const sourceContent = 'Fix the resumed thread naming lifecycle'
  const chat: ChatRecord = {
    appChatId: 'chat-1',
    title: 'Fix the resumed thread naming lifecycle',
    threadTitle: {
      source: 'prompt-fallback',
      sourceMessageId: 'user-1',
      sourceFingerprint: threadTitleSourceFingerprint('user-1', sourceContent)
    },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: sourceContent,
        timestamp: '2026-08-30T00:00:00.000Z'
      }
    ],
    runs: []
  }
  const snapshot: ContinuationProposalSnapshot = {
    schemaVersion: 2,
    chatId: 'chat-1',
    contextVersion: 'continuation-v2:abc:title',
    generatedAt: '2026-08-30T00:01:00.000Z',
    status: 'ready',
    proposals: [],
    title: 'Resilient Thread Naming Lifecycle',
    titleSourceMessageId: 'user-1',
    titleSourceFingerprint: threadTitleSourceFingerprint('user-1', sourceContent),
    titleExpectedCurrent: chat.title,
    fingerprint: `sha256:${'a'.repeat(64)}`
  }

  it('applies only the unchanged title/source tuple', () => {
    expect(applyLocalAiTitleProposal(chat, snapshot)).toMatchObject({
      title: 'Resilient Thread Naming Lifecycle',
      threadTitle: { source: 'local-ai', sourceMessageId: 'user-1' }
    })
    expect(applyLocalAiTitleProposal({ ...chat, title: 'Manual rename' }, snapshot)).toBeNull()
    expect(
      applyLocalAiTitleProposal(
        {
          ...chat,
          messages: [{ ...chat.messages[0], content: 'Edited with the same id' }]
        },
        snapshot
      )
    ).toBeNull()
  })

  it('builds a narrow main-owned title apply request', () => {
    expect(buildContinuationTitleApplyRequest('chat-1', snapshot)).toEqual({
      schemaVersion: 1,
      chatId: 'chat-1',
      title: snapshot.title,
      sourceMessageId: snapshot.titleSourceMessageId,
      sourceFingerprint: snapshot.titleSourceFingerprint,
      evidenceFingerprint: snapshot.fingerprint,
      expectedTitle: snapshot.titleExpectedCurrent
    })
  })
})

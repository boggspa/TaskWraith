import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import { makeHumanCollaboratorComment } from './HumanCollaboratorMessages'
import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { buildHumanShareProjection } from './HumanShareProjection'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'codex',
    title: 'Build /Users/chris/secret/repo',
    workspaceId: 'workspace-1',
    workspacePath: '/Users/chris/secret/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

const share: HumanCollaborationShare = {
  shareId: 'share-1',
  chatId: 'chat-1',
  mode: 'comments',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  nextSequence: 2,
  participants: [
    {
      collaboratorId: 'collab-1',
      displayName: 'Alex',
      publicKeyId: 'alex-key',
      status: 'active',
      joinedAt: 1
    }
  ],
  invites: [],
  idempotency: {}
}

describe('buildHumanShareProjection', () => {
  it('projects one chat with collaborator comments and redacts owner-only details', () => {
    const projection = buildHumanShareProjection(
      chat({
        messages: [
          {
            id: 'host-1',
            role: 'user',
            content: 'Open /Users/chris/secret/repo/src/main.ts',
            timestamp: '2026-06-25T00:00:00.000Z'
          },
          {
            id: 'tool-1',
            role: 'tool',
            content: 'stdout includes /Users/chris/secret/repo/.env',
            timestamp: '2026-06-25T00:00:01.000Z',
            toolActivities: [
              {
                id: 'tool-a',
                toolName: 'shell',
                displayName: 'shell',
                status: 'success',
                category: 'shell',
                startedAt: '2026-06-25T00:00:01.000Z',
                outputPreview: 'secret'
              }
            ]
          },
          makeHumanCollaboratorComment({
            id: 'comment-1',
            content: 'Can you explain this part?',
            timestamp: '2026-06-25T00:00:02.000Z',
            shareId: 'share-1',
            collaboratorId: 'collab-1',
            collaboratorDisplayName: 'Alex',
            clientMessageId: 'client-1',
            sequence: 1
          })
        ],
        runs: [
          {
            runId: 'run-1',
            startedAt: '2026-06-25T00:00:00.000Z',
            provider: 'codex',
            requestedModel: 'expensive-model',
            stats: { cost: 99 }
          }
        ]
      }),
      share,
      { generatedAt: '2026-06-25T00:00:03.000Z' }
    )

    expect(projection).toMatchObject({
      schemaVersion: 1,
      shareId: 'share-1',
      chatId: 'chat-1',
      mode: 'comments'
    })
    expect(JSON.stringify(projection)).not.toContain('/Users/chris')
    expect(JSON.stringify(projection)).not.toContain('expensive-model')
    expect(JSON.stringify(projection)).not.toContain('run-1')
    expect(JSON.stringify(projection)).not.toContain('secret')
    expect(projection.rows).toEqual([
      expect.objectContaining({ role: 'host', preview: 'Open [workspace]/src/main.ts' }),
      expect.objectContaining({
        role: 'placeholder',
        preview: '[Tool activity hidden from collaborators]'
      }),
      expect.objectContaining({
        role: 'collaborator',
        speaker: 'Alex',
        sequence: 1,
        preview: 'Can you explain this part?'
      })
    ])
  })
})

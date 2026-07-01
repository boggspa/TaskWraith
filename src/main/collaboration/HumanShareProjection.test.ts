import os from 'os'
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

  it('collapses non-workspace absolute paths (Volumes/private/tmp) to [path]', () => {
    const projection = buildHumanShareProjection(
      chat({
        messages: [
          {
            id: 'a-1',
            role: 'assistant',
            content:
              'See /Volumes/ClientSSD/acquisition/financials.xlsx and /private/var/folders/zz/build and /tmp/scratch.log',
            timestamp: '2026-06-25T00:00:00.000Z'
          }
        ]
      }),
      share,
      { generatedAt: '2026-06-25T00:00:03.000Z' }
    )
    const blob = JSON.stringify(projection)
    expect(blob).not.toContain('ClientSSD')
    expect(blob).not.toContain('acquisition')
    expect(blob).not.toContain('var/folders')
    expect(blob).not.toContain('scratch.log')
    expect(projection.rows[0].preview).toBe('See [path] and [path] and [path]')
  })

  it('collapses the host home dir and its tail to [host-home]', () => {
    const home = os.homedir()
    const projection = buildHumanShareProjection(
      chat({
        workspacePath: undefined,
        messages: [
          {
            id: 'a-2',
            role: 'assistant',
            content: `wrote ${home}/other-client-codename/db.ts`,
            timestamp: '2026-06-25T00:00:00.000Z'
          }
        ]
      }),
      share,
      { generatedAt: '2026-06-25T00:00:03.000Z' }
    )
    expect(JSON.stringify(projection)).not.toContain('other-client-codename')
    expect(projection.rows[0].preview).toBe('wrote [host-home]')
  })

  it('byte-budget trims oldest rows so a long transcript fits the frame cap', () => {
    const big = 'x'.repeat(2000)
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `row${i}-${big}`,
      timestamp: '2026-06-25T00:00:00.000Z'
    }))
    const projection = buildHumanShareProjection(
      chat({ messages, workspacePath: undefined }),
      share,
      { maxBytes: 20_000, generatedAt: '2026-06-25T00:00:03.000Z' }
    )
    // Fits the budget (with a small slop for the trim granularity of one row).
    expect(Buffer.byteLength(JSON.stringify(projection), 'utf8')).toBeLessThanOrEqual(22_000)
    // It dropped the OLDEST rows but kept the most recent context.
    expect(projection.rows.length).toBeLessThan(60)
    expect(projection.rows[projection.rows.length - 1].preview).toContain('row59')
    expect(projection.totalRows).toBe(60)
  })

  it('scrubs credentials echoed into host/assistant content and the title', () => {
    const key = 'sk' + '-ABCDEF0123456789abcdef'
    const projection = buildHumanShareProjection(
      chat({
        title: `Debug ${key}`,
        workspacePath: undefined,
        messages: [
          {
            id: 'a-3',
            role: 'assistant',
            content: `the env has AWS_SECRET_ACCESS_KEY=abc/def+ghiJKL and key ${key}`,
            timestamp: '2026-06-25T00:00:00.000Z'
          }
        ]
      }),
      share,
      { generatedAt: '2026-06-25T00:00:03.000Z' }
    )
    const blob = JSON.stringify(projection)
    expect(blob).not.toContain(key)
    expect(blob).not.toContain('abc/def+ghiJKL')
    expect(projection.title).toBe('Debug sk-[redacted]')
    expect(projection.rows[0].preview).toBe(
      'the env has AWS_SECRET_ACCESS_KEY=[redacted] and key sk-[redacted]'
    )
  })

  it('P2b: exposes the contribution preset when rules are persisted', () => {
    const withRules = {
      ...share,
      contributionRules: {
        schemaVersion: 1 as const,
        preset: 'requestHostAction' as const,
        viewProjection: true,
        appendComment: true,
        requestHostAction: true,
        createHostDraft: 'host-click' as const,
        providerDispatch: 'never' as const,
        maxContributionBytes: 8000,
        rateLimitProfile: 'comments-v1' as const,
        auditLevel: 'summary' as const
      }
    }
    const projection = buildHumanShareProjection(chat(), withRules, { generatedAt: 'now' })
    expect(projection.contributionPreset).toBe('requestHostAction')
    // Legacy share without rules: field absent (older collaborator clients
    // parse the projection strictly by known fields).
    const legacy = buildHumanShareProjection(chat(), share, { generatedAt: 'now' })
    expect(legacy.contributionPreset).toBeUndefined()
  })
})


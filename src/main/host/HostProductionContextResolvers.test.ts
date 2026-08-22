import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionContextResolvers,
  type HostProductionResolverApproval,
  type HostProductionResolverChat,
  type HostProductionResolverQuestion
} from './HostProductionContextResolvers'

function chat(overrides: Partial<HostProductionResolverChat> = {}): HostProductionResolverChat {
  return {
    appChatId: 'thread-1',
    scope: 'workspace',
    workspaceId: 'workspace-1',
    provider: 'codex',
    archived: false,
    runs: [],
    ...overrides
  }
}

function open(
  input: {
    chats?: readonly HostProductionResolverChat[]
    approvals?: readonly HostProductionResolverApproval[]
    questions?: readonly HostProductionResolverQuestion[]
  } = {}
) {
  const chats = new Map((input.chats ?? [chat()]).map((row) => [row.appChatId, row]))
  const approvals = new Map(
    (input.approvals ?? []).map((row) => [row.approvalId ?? row.toolCallId, row])
  )
  const questions = new Map(
    (input.questions ?? []).map((row) => [row.questionId ?? row.promptId, row])
  )
  const getChat = vi.fn((threadId: string) => chats.get(threadId) ?? null)
  const getApproval = vi.fn((approvalId: string) => approvals.get(approvalId) ?? null)
  const getQuestion = vi.fn((questionId: string) => questions.get(questionId) ?? null)
  return {
    resolvers: createHostProductionContextResolvers({ getChat, getApproval, getQuestion }),
    getChat,
    getApproval,
    getQuestion
  }
}

describe('createHostProductionContextResolvers', () => {
  it('requires every live source instead of installing a partial resolver', () => {
    expect(() => createHostProductionContextResolvers(undefined as never)).toThrow(/dependencies/)
    expect(() =>
      createHostProductionContextResolvers({
        getChat: undefined as never,
        getApproval: () => null,
        getQuestion: () => null
      })
    ).toThrow(/getChat/)
    expect(() =>
      createHostProductionContextResolvers({
        getChat: () => null,
        getApproval: undefined as never,
        getQuestion: () => null
      })
    ).toThrow(/getApproval/)
    expect(() =>
      createHostProductionContextResolvers({
        getChat: () => null,
        getApproval: () => null,
        getQuestion: undefined as never
      })
    ).toThrow(/getQuestion/)
  })

  it('resolves a solo composer send from canonical chat and run state', async () => {
    const { resolvers } = open({
      chats: [
        chat({
          workflowMode: 'plan',
          providerMetadata: {
            approvalMode: 'on-request',
            claudeReasoningEffort: 'high',
            customModel: 'fallback-model'
          },
          requestedModel: 'requested-model',
          runs: [
            {
              runId: 'run-complete',
              provider: 'claude',
              startedAt: '2026-08-09T10:00:00.000Z',
              endedAt: '2026-08-09T10:01:00.000Z',
              status: 'completed',
              actualModel: 'claude-sonnet-4-7'
            }
          ]
        })
      ]
    })

    await expect(resolvers.resolveComposerSend('thread-1')).resolves.toEqual({
      ok: true,
      value: {
        mode: 'solo',
        workspaceId: 'workspace-1',
        provider: 'claude',
        approvalMode: 'on-request',
        workflowMode: 'plan',
        model: 'claude-sonnet-4-7',
        reasoningEffort: 'high'
      }
    })
  })

  it('reads Mistral default reasoning from metadata keys', async () => {
    const { resolvers } = open({
      chats: [
        chat({
          provider: 'mistral',
          requestedModel: 'mistral-medium-3.5',
          providerMetadata: {
            mistralReasoningEffort: 'high',
            piReasoningEffort: 'high'
          }
        })
      ]
    })

    await expect(resolvers.resolveComposerSend('thread-1')).resolves.toEqual({
      ok: true,
      value: {
        mode: 'solo',
        workspaceId: 'workspace-1',
        provider: 'mistral',
        model: 'mistral-medium-3.5',
        reasoningEffort: 'high'
      }
    })

    const offers = await resolvers.resolveThreadOffers('thread-1')
    expect(offers).toMatchObject({
      ok: true,
      value: {
        currentReasoningEffort: 'high',
        currentModel: 'mistral-medium-3.5'
      }
    })
  })

  it('reads Ollama reasoning from the shared provider metadata key', async () => {
    const { resolvers } = open({
      chats: [
        chat({
          provider: 'ollama',
          requestedModel: 'ornith-1.5:35b',
          providerMetadata: { ollamaReasoningEffort: 'off' }
        })
      ]
    })

    await expect(resolvers.resolveComposerSend('thread-1')).resolves.toMatchObject({
      ok: true,
      value: {
        provider: 'ollama',
        model: 'ornith-1.5:35b',
        reasoningEffort: 'off'
      }
    })
  })

  it('projects canonical offers and rejects any composer nomination outside them', async () => {
    const { resolvers } = open({
      chats: [
        chat({
          provider: 'codex',
          requestedModel: 'gpt-5.6-sol',
          providerMetadata: { codexReasoningEffort: 'high' }
        })
      ]
    })

    const offers = await resolvers.resolveThreadOffers('thread-1')
    expect(offers).toMatchObject({
      ok: true,
      value: {
        threadId: 'thread-1',
        currentModel: 'gpt-5.6-sol',
        currentReasoningEffort: 'high',
        source: 'curated'
      }
    })
    if (!offers.ok) return
    const alternative = offers.value.models.find(
      (model) => model.id !== 'gpt-5.6-sol' && !model.disabled
    )!
    const effort = alternative.reasoningEfforts.find((candidate) => !candidate.disabled)!

    await expect(
      resolvers.resolveComposerSend('thread-1', {
        model: alternative.id,
        reasoningEffort: effort.id
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { model: alternative.id, reasoningEffort: effort.id }
    })
    await expect(
      resolvers.resolveComposerSend('thread-1', { model: 'claude-opus-5' })
    ).resolves.toEqual({
      ok: false,
      error: 'That model is not offered for this thread.'
    })
    await expect(
      resolvers.resolveComposerSend('thread-1', {
        model: alternative.id,
        reasoningEffort: 'invented-effort'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'That reasoning effort is not offered for the selected model.'
    })
  })

  it('resolves an Ensemble composer send and only carries a live round id', async () => {
    const live = open({
      chats: [
        chat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            participants: [],
            activeRound: { roundId: 'round-live', status: 'running' }
          }
        })
      ]
    })
    await expect(live.resolvers.resolveComposerSend('thread-1')).resolves.toEqual({
      ok: true,
      value: { mode: 'ensemble', workspaceId: 'workspace-1', roundId: 'round-live' }
    })

    const settled = open({
      chats: [
        chat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            participants: [],
            activeRound: { roundId: 'round-old', status: 'completed' }
          }
        })
      ]
    })
    await expect(settled.resolvers.resolveComposerSend('thread-1')).resolves.toEqual({
      ok: true,
      value: { mode: 'ensemble', workspaceId: 'workspace-1' }
    })
  })

  it('fails composer resolution for missing, archived, or incompletely scoped chats', async () => {
    const missing = open({ chats: [] })
    await expect(missing.resolvers.resolveComposerSend('missing')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not found/i)
    })

    const archived = open({ chats: [chat({ archived: true })] })
    await expect(archived.resolvers.resolveComposerSend('thread-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/archived/i)
    })

    const noWorkspace = open({
      chats: [chat({ scope: 'workspace', workspaceId: undefined })]
    })
    await expect(noWorkspace.resolvers.resolveComposerSend('thread-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/workspace/i)
    })

    const noProvider = open({ chats: [chat({ provider: undefined })] })
    await expect(noProvider.resolvers.resolveComposerSend('thread-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/provider/i)
    })
  })

  it('maps global chats onto the canonical Bridge global workspace id', async () => {
    const { resolvers } = open({
      chats: [chat({ scope: 'global', workspaceId: undefined })]
    })
    await expect(resolvers.resolveComposerSend('thread-1')).resolves.toMatchObject({
      ok: true,
      value: { workspaceId: 'global' }
    })
  })

  it('selects live Ensemble, solo, and idle run-cancel contexts honestly', async () => {
    const ensemble = open({
      chats: [
        chat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            participants: [],
            activeRound: { roundId: 'round-2', status: 'running' }
          }
        })
      ]
    })
    await expect(ensemble.resolvers.resolveRunCancel('thread-1')).resolves.toEqual({
      ok: true,
      value: { mode: 'ensemble', workspaceId: 'workspace-1', roundId: 'round-2' }
    })

    const solo = open({
      chats: [
        chat({
          provider: 'claude',
          runs: [
            {
              runId: 'run-live',
              provider: 'codex',
              startedAt: '2026-08-09T10:00:00.000Z',
              status: 'running'
            },
            {
              runId: 'run-later-but-done',
              provider: 'kimi',
              startedAt: '2026-08-09T11:00:00.000Z',
              endedAt: '2026-08-09T11:01:00.000Z',
              status: 'completed'
            }
          ]
        })
      ]
    })
    await expect(solo.resolvers.resolveRunCancel('thread-1')).resolves.toEqual({
      ok: true,
      value: {
        mode: 'solo',
        workspaceId: 'workspace-1',
        provider: 'codex',
        runId: 'run-live'
      }
    })

    const idle = open({ chats: [chat()] })
    await expect(idle.resolvers.resolveRunCancel('thread-1')).resolves.toEqual({
      ok: true,
      value: { mode: 'none', message: 'No active run to cancel.' }
    })
  })

  it('resolves approval scope directly or through its canonical thread', async () => {
    const direct = open({
      approvals: [
        {
          approvalId: 'approval-1',
          toolCallId: 'approval-1',
          workspaceId: 'workspace-direct',
          threadId: 'thread-direct'
        }
      ]
    })
    await expect(direct.resolvers.resolveApprovalDecide('approval-1')).resolves.toEqual({
      ok: true,
      value: {
        workspaceId: 'workspace-direct',
        threadId: 'thread-direct',
        toolCallId: 'approval-1'
      }
    })

    const fallback = open({
      approvals: [{ approvalId: 'approval-2', toolCallId: 'approval-2', threadId: 'thread-1' }]
    })
    await expect(fallback.resolvers.resolveApprovalDecide('approval-2')).resolves.toEqual({
      ok: true,
      value: {
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        toolCallId: 'approval-2'
      }
    })
  })

  it('fails approval resolution for missing, mismatched, or unscoped records', async () => {
    const missing = open()
    await expect(missing.resolvers.resolveApprovalDecide('missing')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not found/i)
    })

    const mismatch = open({
      approvals: [{ approvalId: 'approval-1', toolCallId: 'other', threadId: 'thread-1' }]
    })
    await expect(mismatch.resolvers.resolveApprovalDecide('approval-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/alias/i)
    })

    const unscoped = open({
      approvals: [{ approvalId: 'approval-3', toolCallId: 'approval-3' }]
    })
    await expect(unscoped.resolvers.resolveApprovalDecide('approval-3')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/thread/i)
    })
  })

  it('resolves question scope, prompt alias, and optional run id', async () => {
    const direct = open({
      questions: [
        {
          questionId: 'question-1',
          promptId: 'question-1',
          workspaceId: 'workspace-direct',
          threadId: 'thread-direct',
          runId: 'run-9'
        }
      ]
    })
    await expect(direct.resolvers.resolveQuestionAnswer('question-1')).resolves.toEqual({
      ok: true,
      value: {
        workspaceId: 'workspace-direct',
        threadId: 'thread-direct',
        promptId: 'question-1',
        runId: 'run-9'
      }
    })

    const fallback = open({
      questions: [{ questionId: 'question-2', promptId: 'question-2', threadId: 'thread-1' }]
    })
    await expect(fallback.resolvers.resolveQuestionAnswer('question-2')).resolves.toEqual({
      ok: true,
      value: {
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        promptId: 'question-2'
      }
    })
  })

  it('fails question resolution for missing, mismatched, or unscoped records', async () => {
    const missing = open()
    await expect(missing.resolvers.resolveQuestionAnswer('missing')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not found/i)
    })

    const mismatch = open({
      questions: [{ questionId: 'question-1', promptId: 'other', threadId: 'thread-1' }]
    })
    await expect(mismatch.resolvers.resolveQuestionAnswer('question-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/alias/i)
    })

    const unscoped = open({
      questions: [{ questionId: 'question-3', promptId: 'question-3' }]
    })
    await expect(unscoped.resolvers.resolveQuestionAnswer('question-3')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/thread/i)
    })
  })

  it('builds the full ordered roster with exactly one seat flag changed', async () => {
    const { resolvers } = open({
      chats: [
        chat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            participants: [
              { id: 'seat-b', provider: 'claude', enabled: true, order: 2 },
              { id: 'seat-a', provider: 'codex', enabled: true, order: 1 },
              { id: 'seat-c', provider: 'kimi', enabled: false, order: 3 }
            ]
          }
        })
      ]
    })

    await expect(resolvers.resolveEnsembleSeatToggle('thread-1', 'seat-c', true)).resolves.toEqual({
      ok: true,
      value: {
        workspaceId: 'workspace-1',
        participants: [
          { id: 'seat-a', provider: 'codex', enabled: true },
          { id: 'seat-b', provider: 'claude', enabled: true },
          { id: 'seat-c', provider: 'kimi', enabled: true }
        ]
      }
    })
  })

  it('refuses unknown seats and disabling the last enabled seat', async () => {
    const { resolvers } = open({
      chats: [
        chat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            participants: [
              { id: 'seat-a', provider: 'codex', enabled: true, order: 1 },
              { id: 'seat-b', provider: 'claude', enabled: false, order: 2 }
            ]
          }
        })
      ]
    })

    await expect(
      resolvers.resolveEnsembleSeatToggle('thread-1', 'missing', true)
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/no longer exists/i) })
    await expect(
      resolvers.resolveEnsembleSeatToggle('thread-1', 'seat-a', false)
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/one participant/i) })
  })

  it('verifies thread existence before mapping thread.select to appChatId', async () => {
    const { resolvers } = open({ chats: [chat({ appChatId: 'thread-canonical' })] })
    await expect(resolvers.resolveThreadSelect('thread-canonical')).resolves.toEqual({
      ok: true,
      value: { appChatId: 'thread-canonical' }
    })
    await expect(resolvers.resolveThreadSelect('missing')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not found/i)
    })
  })

  it('re-reads moving sources on every resolution instead of caching authority', async () => {
    const getChat = vi
      .fn()
      .mockReturnValueOnce(chat({ provider: 'codex' }))
      .mockReturnValueOnce(chat({ provider: 'claude' }))
    const resolvers = createHostProductionContextResolvers({
      getChat,
      getApproval: () => null,
      getQuestion: () => null
    })

    await expect(resolvers.resolveComposerSend('thread-1')).resolves.toMatchObject({
      ok: true,
      value: { provider: 'codex' }
    })
    await expect(resolvers.resolveComposerSend('thread-1')).resolves.toMatchObject({
      ok: true,
      value: { provider: 'claude' }
    })
    expect(getChat).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'

interface HarnessOptions {
  bossLast?: boolean
  provider?: EnsembleParticipant['provider']
  synthesizerParticipantId?: string
}

function makeHarness(options: HarnessOptions = {}) {
  const boss: EnsembleParticipant = {
    id: 'boss',
    provider: options.provider ?? 'codex',
    enabled: true,
    role: 'Boss',
    instructions: 'Coordinate the panel.',
    order: options.bossLast ? 3 : 1,
    permissionPresetId: 'workspace_write'
  }
  const worker: EnsembleParticipant = {
    id: 'worker',
    provider: options.provider ?? 'claude',
    enabled: true,
    role: 'Worker',
    instructions: 'Implement the next slice.',
    order: options.bossLast ? 1 : 2,
    permissionPresetId: 'workspace_write'
  }
  const reviewer: EnsembleParticipant = {
    id: 'reviewer',
    provider: options.provider ?? 'grok',
    enabled: true,
    role: 'Reviewer',
    instructions: 'Review the result.',
    order: options.bossLast ? 2 : 3,
    permissionPresetId: 'read_only'
  }
  let chat: ChatRecord = {
    appChatId: 'serial-fallback',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Serial fallback routing',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 3,
      participants: [boss, worker, reviewer],
      bossmanParticipantId: 'boss',
      captainParticipantIds: [],
      orchestrationMode: 'continuous',
      maxContinuationHops: 12,
      fanoutPolicy: 'off',
      ...(options.synthesizerParticipantId
        ? { synthesizerParticipantId: options.synthesizerParticipantId }
        : {})
    }
  }
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: () =>
      ({
        storeLocalChatHistory: true,
        storeRawEvents: true,
        ensembleModeEnabled: true,
        chatContextTurns: 8
      }) as AppSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId! }
    }),
    cancelRun: vi.fn(async () => true),
    createRunId: (provider) => `${provider}-serial-${++counter}`,
    now: () => 1_000 + counter,
    nowIso: () => new Date(1_000 + counter).toISOString()
  })

  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator,
    participantIds: () =>
      dispatched.map((payload) => payload.ensembleRun?.participantId || 'unknown'),
    async start() {
      orchestrator.startRound({
        chatId: chat.appChatId,
        prompt: 'Continue through the panel until the work is complete.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(dispatched).toHaveLength(1))
    },
    complete(index: number, text = 'Completed my part without a routing directive.') {
      const run = dispatched[index]
      orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: chat.appChatId },
        { type: 'content', text }
      )
      orchestrator.handleProviderOutput(
        run.provider,
        { appRunId: run.appRunId, appChatId: chat.appChatId },
        { type: 'result', status: 'success' }
      )
    }
  }
}

const harnesses: ReturnType<typeof makeHarness>[] = []
afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map((harness) => harness.orchestrator.cancelRound(harness.chat.appChatId))
  )
})

function harness(options: HarnessOptions = {}) {
  const next = makeHarness(options)
  harnesses.push(next)
  return next
}

describe('Ensemble serial fallback routing', () => {
  it.each([undefined, 'mistral'] as const)(
    'advances a quiet self-tagging Boss to the next serial seat with provider %s',
    async (provider) => {
      const h = harness({ provider })
      await h.start()
      expect(h.participantIds()).toEqual(['boss'])
      if (provider === 'mistral') {
        // Degraded tool availability cannot make the serial scheduler depend on
        // a control call that this seat cannot issue.
        h.orchestrator.handleProviderOutput(
          provider,
          { appRunId: h.dispatched[0].appRunId, appChatId: h.chat.appChatId },
          {
            type: 'provider_warning',
            provider,
            severity: 'warning',
            title: 'Mistral MCP bridge unavailable',
            message: 'TaskWraith MCP tools are unavailable for this fixture.'
          }
        )
      }

      h.complete(0, '@Boss has no explicit handoff to add; continuing with the panel.')
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(2))

      expect({
        participantIds: h.participantIds(),
        continuationHops: h.chat.ensemble?.activeRound?.continuationHops
      }).toEqual({
        participantIds: ['boss', 'worker'],
        continuationHops: 0
      })
    }
  )

  it.each([undefined, 'boss', 'reviewer'])(
    'keeps later serial passes without directives despite configured synthesizer %s',
    async (synthesizerParticipantId) => {
      // Put Boss last to isolate the pass-drain decision from the first test's
      // pending-seat authority checkpoint. Every completion below is plain
      // content + result: no yield, mention, fan-out, assignment, or control call.
      const h = harness({ bossLast: true, synthesizerParticipantId })
      await h.start()
      h.complete(0)
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(2))
      h.complete(1)
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(3))
      h.complete(2)
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(4))

      const afterFirstDrain = {
        participantIds: h.participantIds(),
        continuationHops: h.chat.ensemble?.activeRound?.continuationHops,
        continuationPass: h.chat.ensemble?.activeRound?.continuationPass
      }

      h.complete(3)
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(5))
      h.complete(4)
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(6))

      expect({
        afterFirstDrain,
        participantIds: h.participantIds(),
        continuationHops: h.chat.ensemble?.activeRound?.continuationHops,
        continuationPass: h.chat.ensemble?.activeRound?.continuationPass
      }).toEqual({
        afterFirstDrain: {
          participantIds: ['worker', 'reviewer', 'boss', 'worker'],
          continuationHops: 3,
          continuationPass: 2
        },
        participantIds: ['worker', 'reviewer', 'boss', 'worker', 'reviewer', 'boss'],
        continuationHops: 3,
        continuationPass: 2
      })
    }
  )
})

import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/*
 * The fan-out lane brief wrapper, exercised through the real dispatch path.
 *
 * What this wrapper says decides whether a lane does the work or bounces it:
 * the 2026-08 burn audit found lanes handing briefs back as "not my role",
 * each bounce costing a full provider turn to re-litigate a routing decision
 * the dispatcher had already made. The wrapper must therefore say the brief is
 * the lane's own work for this turn — while keeping the peer-authored brief
 * BELOW user/system instructions and inside the seat's signed permissions,
 * which are the actual security boundaries. Role was never one.
 */

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model: `${provider}-model`,
    permissionPresetId: 'workspace_write'
  }
}

function makeChat(participants: EnsembleParticipant[], bossId?: string): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Lane brief wording',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      fanoutPolicy: 'read_only',
      participants,
      ...(bossId ? { bossmanParticipantId: bossId } : {})
    }
  } as unknown as ChatRecord
}

function makeHarness(participants: EnsembleParticipant[], bossId?: string) {
  let chat = makeChat(participants, bossId)
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
        storeRawEvents: false,
        ensembleModeEnabled: true,
        chatContextTurns: 8
      }) as unknown as AppSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun: vi.fn(async () => true),
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => counter,
    nowIso: () => `2026-08-18T00:00:0${counter}.000Z`
  } as unknown as ConstructorParameters<typeof EnsembleOrchestrator>[0])
  return { dispatched, orchestrator }
}

describe('fan-out lane brief wrapper', () => {
  it(
    'tells the lane the brief is its own work, not a role question',
    { timeout: 30_000 },
    async () => {
      const harness = makeHarness([
        participant('lead', 'codex', 'Lead', 1),
        participant('reviewer', 'claude', 'Reviewer', 2)
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead delegates a slice.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      const wave = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Reviewer'],
        prompt: 'Check the migration for missed call sites.'
      })
      expect(wave.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      const lanePrompt = harness.dispatched[1].prompt
      // The brief itself, and its authority ceiling, both survive.
      expect(lanePrompt).toContain('Check the migration for missed call sites.')
      expect(lanePrompt).toContain('lower authority than user/system instructions')
      // The routed-work doctrine: do it, or say what blocks you.
      expect(lanePrompt).toContain('routed to this seat deliberately')
      expect(lanePrompt).toContain('outside your usual role')
      expect(lanePrompt).toMatch(/permissions and the active goal/i)
      // The old wording licensed the bounce; it must be gone.
      expect(lanePrompt).not.toContain('Follow your own role, permissions, and active goal first')
    }
  )
})

describe('self-targeted fan-out refusal', () => {
  it(
    'says WHY a self-target is invalid instead of feigning an unknown name',
    { timeout: 30_000 },
    async () => {
      // The generic "did not resolve to an enabled participant" reads like a
      // typo, so the caller retries spelling variants of its own name. The
      // structural block on self-targeting is fine — the message lied about
      // the reason.
      const harness = makeHarness(
        [participant('lead', 'codex', 'Lead', 1), participant('reviewer', 'claude', 'Reviewer', 2)],
        'lead'
      )
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead tries to verify its own work.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      const fanout = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Lead'],
        prompt: 'Verify my earlier migration claim.'
      })
      expect(fanout.ok).toBe(false)
      expect(fanout.error).toBe('invalid_target')
      expect(fanout.message).toContain('is this seat itself')
      expect(fanout.message).toContain('different seat')

      const fanoutAll = await harness.orchestrator.fanoutAllForRun(boss, {
        targets: ['Lead'],
        prompt: 'Verify my earlier migration claim.'
      })
      expect(fanoutAll.ok).toBe(false)
      expect(fanoutAll.error).toBe('invalid_target')
      expect(fanoutAll.message).toContain('is this seat itself')
    }
  )
})

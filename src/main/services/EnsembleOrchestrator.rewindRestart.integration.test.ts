/**
 * A round restarted by an edit and resend, through the real orchestrator and
 * the real store with barrier durability switched on.
 *
 * The edit's own save rewrites the user's row and cuts what followed at the
 * user's asking: it takes the user's tickets, a message and a destructive
 * change, on one urgent barrier, and is reported to the renderer once that
 * is paid. The round it restarts does not echo the prompt, so the round's
 * save holds no moment: it takes no ticket and raises no barrier, and its
 * seats go without waiting for one. Nothing reads that round from the disk
 * before they act: they are handed the prompt, and no Host start claim rides
 * a restart from the renderer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRunPayload } from '../run/AgentRunTypes'
import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore
} from '../store/hostOwnedErasure.testutil'
import type { ChatMessage, EnsembleParticipant } from '../store/types'

const WAIT = { timeout: 10_000 }
const CHAT = 'rewind-restart'
const AT = '2026-10-05T00:00:00.000Z'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await disposeHostOwnedStores()
  vi.unstubAllEnvs()
})

function seat(id: string, order: number): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: true,
    role: id,
    instructions: `${id}.`,
    order,
    model: 'codex-model',
    permissionPresetId: 'read_only'
  }
}

function row(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: AT }
}

describe('a round restarted by an edit and resend', () => {
  it("takes no ticket and raises no barrier, after the edit's own save took the user's", async () => {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const seed = chatRecord(CHAT, 1, {
      chatKind: 'ensemble',
      messages: [row('user-1', 'user', 'Look at the tests'), row('reply-1', 'assistant', 'Done')],
      ensemble: {
        enabled: true,
        maxParticipants: 1,
        maxContinuationHops: 0,
        participants: [seat('seat-a', 1)]
      }
    })
    const { AppStore } = await importHostOwnedStore([seed])
    AppStore.updateSettings({ storeLocalChatHistory: true })
    // Loaded after the store, so they bind to the store this test configured.
    const { EnsembleOrchestrator } = await import('./EnsembleOrchestrator')
    const gates = await import('../run/DurableMomentGate')
    const dispatched: AgentRunPayload[] = []
    let sequence = 0
    const orchestrator = new EnsembleOrchestrator({
      getChat: (chatId) => AppStore.getChat(chatId),
      saveChat: (chat, options) => {
        AppStore.saveChat(chat, options)
      },
      persistChatBarrier: (chatId) => AppStore.awaitChatRecordDispatchDurable(chatId),
      getSettings: () => AppStore.getSettings(),
      dispatch: async (payload, _event, observer) => {
        dispatched.push(payload)
        observer?.onAdapterInvoked?.({
          provider: payload.provider,
          appRunId: payload.appRunId || ''
        })
        return { dispatched: true, appRunId: payload.appRunId || '' }
      },
      cancelRun: async () => true,
      createRunId: (provider) => `${provider}-rewind-run-${++sequence}`,
      now: () => Date.now(),
      nowIso: () => new Date().toISOString()
    })
    cleanups.push(() => orchestrator.cancelRound(CHAT, 'rewind restart test cleanup'))
    const perf = () => AppStore.getThreadBarrierDurabilityPerf()

    // The edit: the user's row rewritten, and what followed cut at their asking.
    const before = AppStore.getChat(CHAT)!
    AppStore.saveChat(
      { ...before, messages: [{ ...before.messages[0], content: 'Look at the tests again' }] },
      { removalAskedByUser: true }
    )
    expect(perf().tickets?.moments).toMatchObject({
      user_message: { noted: 1 },
      destructive: { noted: 1 }
    })
    expect(perf().debt?.barriers).toMatchObject({ raised: 1, urgent: 1 })
    // As the edit's handler does before it reports the edit accepted.
    await gates.awaitUserMoment(CHAT)
    const raised = perf().debt!.barriers.raised

    expect(
      orchestrator.startRound({
        chatId: CHAT,
        prompt: 'Look at the tests again',
        event: { sender: {} as Electron.WebContents },
        mode: 'steer',
        rewind: { suppressPromptEcho: true }
      }).status
    ).toBe('started')
    await vi.waitFor(() => expect(dispatched.length).toBeGreaterThan(0), WAIT)

    const restarted = AppStore.getChat(CHAT)!
    expect(restarted.ensemble?.activeRound?.status).toBe('running')
    // The prompt is the row the edit rewrote: no second copy, so no moment.
    expect(restarted.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(perf().tickets?.moments).toMatchObject({
      user_message: { noted: 1 },
      destructive: { noted: 1 }
    })
    expect(perf().debt?.barriers.raised).toBe(raised)
  })
})

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerEnsembleSkipHandlers,
  registerEnsembleWakeHandlers,
  type EnsembleSkipWakeHandlerDeps
} from './ensembleSkipWakeHandlers'
import type { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'
import type { EnsembleWakeupRecord } from '../store/types'

type OrchestratorStub = Pick<
  EnsembleOrchestrator,
  | 'skipActiveParticipant'
  | 'skipReadFanout'
  | 'skipFanoutLane'
  | 'handleWakeupFired'
  | 'cancelWakeupById'
>

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

const EVENT = { sender: { id: 1 } }

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function pendingWakeup(overrides: Partial<EnsembleWakeupRecord> = {}): EnsembleWakeupRecord {
  return {
    wakeupId: 'wakeup-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'participant-1',
    provider: 'gemini',
    scheduledAt: '2026-09-01T00:00:00.000Z',
    wakeAt: '2026-09-01T01:00:00.000Z',
    status: 'pending',
    ...overrides
  }
}

interface Harness {
  deps: EnsembleSkipWakeHandlerDeps
  orchestrator: {
    skipActiveParticipant: Mock<OrchestratorStub['skipActiveParticipant']>
    skipReadFanout: Mock<OrchestratorStub['skipReadFanout']>
    skipFanoutLane: Mock<OrchestratorStub['skipFanoutLane']>
    handleWakeupFired: Mock<OrchestratorStub['handleWakeupFired']>
    cancelWakeupById: Mock<OrchestratorStub['cancelWakeupById']>
  } | null
  setOrchestrator: (next: Harness['orchestrator']) => void
  timerCancel: Mock<(wakeupId: string) => boolean>
  persistedById: Map<string, EnsembleWakeupRecord>
  saved: EnsembleWakeupRecord[]
  scopeCalls: Array<{ chatId: string }>
  isMain: boolean
}

function harness(overrides: Partial<EnsembleSkipWakeHandlerDeps> = {}): Harness {
  const persistedById = new Map<string, EnsembleWakeupRecord>()
  const saved: EnsembleWakeupRecord[] = []
  const scopeCalls: Array<{ chatId: string }> = []
  let orchestrator: Harness['orchestrator'] = {
    skipActiveParticipant: vi.fn<OrchestratorStub['skipActiveParticipant']>(async () => true),
    skipReadFanout: vi.fn<OrchestratorStub['skipReadFanout']>(async () => true),
    skipFanoutLane: vi.fn<OrchestratorStub['skipFanoutLane']>(async () => true),
    handleWakeupFired: vi.fn<OrchestratorStub['handleWakeupFired']>(() => true),
    cancelWakeupById: vi.fn<OrchestratorStub['cancelWakeupById']>(() => null)
  }
  const timerCancel = vi.fn<(wakeupId: string) => boolean>(() => true)
  const h: Harness = {
    deps: {
      getEnsembleOrchestrator: () => orchestrator,
      getWakeupTimerService: () => ({ cancel: timerCancel }),
      findPersistedEnsembleWakeup: (wakeupId) => persistedById.get(wakeupId) ?? null,
      savePersistedEnsembleWakeup: (wakeup) => {
        saved.push(wakeup)
      },
      requireNonEmptyString: (value, label) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
        return value
      },
      assertSenderChatScope: (_event, chatId) => {
        scopeCalls.push({ chatId })
      },
      isMainRendererSender: () => h.isMain,
      ...overrides
    },
    orchestrator,
    setOrchestrator: (next) => {
      orchestrator = next
      h.orchestrator = next
    },
    timerCancel,
    persistedById,
    saved,
    scopeCalls,
    isMain: true
  }
  return h
}

beforeEach(() => {
  mockedHandle.mockClear()
})

describe('registerEnsembleSkipHandlers', () => {
  it('registers exactly the three skip channels', () => {
    registerEnsembleSkipHandlers(harness().deps)
    const channels = mockedHandle.mock.calls.map(([name]) => name).sort()
    expect(channels).toEqual([
      'skip-ensemble-fanout-lane',
      'skip-ensemble-participant',
      'skip-ensemble-read-fanout'
    ])
  })

  it('skips the active participant after validating scope', async () => {
    const h = harness()
    registerEnsembleSkipHandlers(h.deps)
    const result = await handlerFor('skip-ensemble-participant')(EVENT, 'chat-1')
    expect(result).toBe(true)
    expect(h.scopeCalls).toEqual([{ chatId: 'chat-1' }])
    expect(h.orchestrator?.skipActiveParticipant).toHaveBeenCalledWith('chat-1')
  })

  it('skips read fan-out after validating scope', async () => {
    const h = harness()
    registerEnsembleSkipHandlers(h.deps)
    const result = await handlerFor('skip-ensemble-read-fanout')(EVENT, 'chat-1')
    expect(result).toBe(true)
    expect(h.scopeCalls).toEqual([{ chatId: 'chat-1' }])
    expect(h.orchestrator?.skipReadFanout).toHaveBeenCalledWith('chat-1')
  })

  it('requires the lane id before touching the orchestrator', async () => {
    const h = harness()
    registerEnsembleSkipHandlers(h.deps)
    await expect(handlerFor('skip-ensemble-fanout-lane')(EVENT, 'chat-1', '')).rejects.toThrow(
      'Fan-out lane id is required'
    )
    expect(h.orchestrator?.skipFanoutLane).not.toHaveBeenCalled()
    const result = await handlerFor('skip-ensemble-fanout-lane')(EVENT, 'chat-1', 'lane-1')
    expect(result).toBe(true)
    expect(h.orchestrator?.skipFanoutLane).toHaveBeenCalledWith('chat-1', 'lane-1')
  })

  it('returns undefined when no orchestrator is initialized', async () => {
    const h = harness()
    h.setOrchestrator(null)
    registerEnsembleSkipHandlers(h.deps)
    const result = await handlerFor('skip-ensemble-participant')(EVENT, 'chat-1')
    expect(result).toBeUndefined()
    expect(h.scopeCalls).toEqual([{ chatId: 'chat-1' }])
  })

  it('reads the orchestrator at invocation time, not registration time', async () => {
    const h = harness()
    h.setOrchestrator(null)
    registerEnsembleSkipHandlers(h.deps)
    const before = await handlerFor('skip-ensemble-read-fanout')(EVENT, 'chat-1')
    expect(before).toBeUndefined()
    const live = harness().orchestrator
    expect(live).not.toBeNull()
    h.setOrchestrator(live)
    const after = await handlerFor('skip-ensemble-read-fanout')(EVENT, 'chat-1')
    expect(after).toBe(true)
    expect(live?.skipReadFanout).toHaveBeenCalledWith('chat-1')
  })
})

describe('registerEnsembleWakeHandlers', () => {
  it('registers exactly the two wake channels', () => {
    registerEnsembleWakeHandlers(harness().deps)
    const channels = mockedHandle.mock.calls.map(([name]) => name).sort()
    expect(channels).toEqual([
      'cancel-ensemble-participant-wakeup',
      'wake-ensemble-participant-now'
    ])
  })

  it('wakes via the orchestrator path after cancelling the timer', async () => {
    const h = harness()
    h.persistedById.set('wakeup-1', pendingWakeup())
    registerEnsembleWakeHandlers(h.deps)
    const result = await handlerFor('wake-ensemble-participant-now')(EVENT, 'wakeup-1')
    expect(result).toBe(true)
    expect(h.scopeCalls).toEqual([{ chatId: 'chat-1' }])
    expect(h.timerCancel).toHaveBeenCalledWith('wakeup-1')
    expect(h.orchestrator?.handleWakeupFired).toHaveBeenCalledWith('wakeup-1')
  })

  it('coerces a missing orchestrator wake to false', async () => {
    const h = harness()
    h.persistedById.set('wakeup-1', pendingWakeup())
    h.setOrchestrator(null)
    registerEnsembleWakeHandlers(h.deps)
    const result = await handlerFor('wake-ensemble-participant-now')(EVENT, 'wakeup-1')
    expect(result).toBe(false)
    expect(h.timerCancel).toHaveBeenCalledWith('wakeup-1')
  })

  it('rejects an unresolvable wakeup from a secondary renderer', async () => {
    const h = harness()
    h.isMain = false
    registerEnsembleWakeHandlers(h.deps)
    await expect(handlerFor('wake-ensemble-participant-now')(EVENT, 'missing')).rejects.toThrow(
      'Renderer cannot resolve wakeup chat authority.'
    )
    expect(h.orchestrator?.handleWakeupFired).not.toHaveBeenCalled()
  })

  it('lets the main renderer wake without a persisted record', async () => {
    const h = harness()
    registerEnsembleWakeHandlers(h.deps)
    const result = await handlerFor('wake-ensemble-participant-now')(EVENT, 'missing')
    expect(result).toBe(true)
    expect(h.scopeCalls).toEqual([])
    expect(h.timerCancel).toHaveBeenCalledWith('missing')
  })

  it('returns the runtime cancel record when the orchestrator matches', async () => {
    const h = harness()
    const stored = pendingWakeup()
    h.persistedById.set('wakeup-1', stored)
    const cancelledRecord = { ...stored, status: 'cancelled' as const }
    h.orchestrator?.cancelWakeupById.mockReturnValue(cancelledRecord)
    registerEnsembleWakeHandlers(h.deps)
    const result = await handlerFor('cancel-ensemble-participant-wakeup')(EVENT, 'wakeup-1')
    expect(result).toEqual({ ok: true, cancelled: cancelledRecord })
    expect(h.scopeCalls).toEqual([{ chatId: 'chat-1' }])
    expect(h.saved).toEqual([])
  })

  it('falls back to a persisted-record cancel when the runtime is gone', async () => {
    const h = harness()
    h.persistedById.set('wakeup-1', pendingWakeup())
    registerEnsembleWakeHandlers(h.deps)
    const result = await handlerFor('cancel-ensemble-participant-wakeup')(EVENT, 'wakeup-1')
    expect(result).toEqual({
      ok: true,
      cancelled: expect.objectContaining({
        wakeupId: 'wakeup-1',
        status: 'cancelled',
        cancelledAt: expect.any(String),
        message: 'cancelled by user'
      })
    })
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]?.status).toBe('cancelled')
    expect(h.timerCancel).toHaveBeenCalledWith('wakeup-1')
  })

  it('reports no match when nothing pending remains', async () => {
    const h = harness()
    registerEnsembleWakeHandlers(h.deps)
    const result = await handlerFor('cancel-ensemble-participant-wakeup')(EVENT, 'missing')
    expect(result).toEqual({ ok: false, error: 'No pending wakeup matches.' })
    expect(h.saved).toEqual([])
  })

  it('rejects an unresolvable cancel from a secondary renderer', async () => {
    const h = harness()
    h.isMain = false
    registerEnsembleWakeHandlers(h.deps)
    await expect(
      handlerFor('cancel-ensemble-participant-wakeup')(EVENT, 'missing')
    ).rejects.toThrow('Renderer cannot resolve wakeup chat authority.')
    expect(h.timerCancel).not.toHaveBeenCalled()
  })
})

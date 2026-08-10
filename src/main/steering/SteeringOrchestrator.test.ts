import { describe, expect, it, vi } from 'vitest'

import { RunManager, type LiveSteerTransport } from '../RunManager'
import { MidRunSteeringRegistry, type MidRunSteeringEntry } from '../run/MidRunSteering'
import type { ProviderId } from '../store/types'
import {
  cancelPendingSteer,
  routeSteerDelivery,
  type SteeringOrchestratorDeps
} from './SteeringOrchestrator'

interface Fixture {
  runManager: RunManager
  registry: MidRunSteeringRegistry
  entry: MidRunSteeringEntry
  deps: SteeringOrchestratorDeps
}

function makeFixture(overrides: Partial<SteeringOrchestratorDeps> = {}): Fixture {
  const runManager = new RunManager()
  const registry = new MidRunSteeringRegistry()
  const entry = registry.register({
    chatId: 'chat-1',
    messageId: 'msg-1',
    text: 'steer this',
    source: 'liveSteer',
    authorKind: 'host',
    createdAtIso: new Date().toISOString()
  })
  const deps: SteeringOrchestratorDeps = {
    runManager,
    registry,
    midTurnSteeringEnabled: true,
    piLiveSteerEnabled: false,
    ...overrides
  }
  return { runManager, registry, entry, deps }
}

function startRun(runManager: RunManager, provider: ProviderId, runId = 'run-1'): void {
  runManager.create({ runId, provider, appChatId: 'chat-1', status: 'running' })
}

function steerTransport(overrides: Partial<LiveSteerTransport> = {}): LiveSteerTransport {
  return {
    sendSteer: vi.fn(() => true),
    cancel: vi.fn(),
    ...overrides
  }
}

describe('routeSteerDelivery', () => {
  it('falls back to boundary when there is no matching active session', () => {
    const { deps, entry } = makeFixture()
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'kimi'
    })
    expect(result.status).toBe('boundary')
  })

  it('falls back to boundary when the unified gate is off', () => {
    const { runManager, deps, entry } = makeFixture({ midTurnSteeringEnabled: false })
    startRun(runManager, 'kimi')
    runManager.registerLiveSteerTransport('run-1', steerTransport())
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'kimi'
    })
    expect(result.status).toBe('boundary')
  })

  it('never live-delivers external-authored text', () => {
    const { runManager, registry, deps } = makeFixture()
    startRun(runManager, 'kimi')
    runManager.registerLiveSteerTransport('run-1', steerTransport())
    const externalEntry = registry.register({
      chatId: 'chat-1',
      messageId: 'msg-ext',
      text: 'external words',
      source: 'liveSteer',
      authorKind: 'externalCollaborator',
      createdAtIso: new Date().toISOString()
    })
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry: externalEntry,
      provider: 'kimi'
    })
    expect(result.status).toBe('boundary')
  })

  it('acp-interrupt: sends through the registered live transport (kimi)', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'kimi')
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'kimi'
    })
    expect(result.status).toBe('injected')
    expect(result.strategy).toBe('acp-interrupt')
    expect(transport.sendSteer).toHaveBeenCalledWith('steer this')
  })

  it('acp-interrupt: a refusing transport falls back to boundary', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'mistral')
    runManager.registerLiveSteerTransport('run-1', steerTransport({ sendSteer: () => false }))
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'mistral'
    })
    expect(result.status).toBe('boundary')
  })

  it('acp-interrupt: without a transport it arms the interrupt flag', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'grok')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'grok'
    })
    expect(result.status).toBe('interrupting')
    expect(runManager.getInterruptState('run-1').interruptRequestedAt).toBeTypeOf('number')
  })

  it('cooperative-cancel-resume: mid-tool arms kill-after-tool-result, never an immediate kill', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'claude')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'claude',
      midTool: true
    })
    expect(result.status).toBe('interrupting')
    expect(runManager.getInterruptState('run-1').killAfterToolResult).toBe(true)
    expect(runManager.get('run-1')?.status).toBe('running')
  })

  it('cooperative-cancel-resume: outside a tool it requests the interrupt directly', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'codex')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'codex',
      midTool: false
    })
    expect(result.status).toBe('interrupting')
    expect(runManager.getInterruptState('run-1').interruptRequestedAt).toBeTypeOf('number')
    expect(runManager.getInterruptState('run-1').killAfterToolResult).toBeUndefined()
  })

  it('broker-injection: auto-creates the transport and stores pending steer text', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'cursor')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'cursor'
    })
    expect(result.status).toBe('broker-pending')
    expect(runManager.get('run-1')?.pendingSteerText).toBe('steer this')
  })

  it('pi-live-frame: requires its own opt-in gate even when the unified gate is on', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'pi')
    runManager.registerLiveSteerTransport('run-1', steerTransport())
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'pi'
    })
    expect(result.status).toBe('boundary')
  })

  it('pi-live-frame: sends through the transport when both gates are open', () => {
    const { runManager, deps, entry } = makeFixture({ piLiveSteerEnabled: true })
    startRun(runManager, 'pi')
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'pi'
    })
    expect(result.status).toBe('injected')
    expect(transport.sendSteer).toHaveBeenCalledWith('steer this')
  })
})

describe('cancelPendingSteer', () => {
  it('reports no-pending cleanly', () => {
    const { runManager, deps } = makeFixture()
    startRun(runManager, 'kimi')
    expect(cancelPendingSteer(deps, 'run-1')).toEqual({ cancelled: false, hadPending: false })
  })

  it('cancels the live transport and unregisters it without touching the run', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'kimi')
    // Register a transport so cancelPendingSteer can exercise its cancel+unregister
    // path. Use cooperative-cancel-resume which always arms interruptRequestedAt
    // regardless of transport presence, so cancelPendingSteer sees pending state.
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)
    routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'claude' // cooperative-cancel-resume — arms interruptRequestedAt
    })
    expect(runManager.getInterruptState('run-1').interruptRequestedAt).toBeTypeOf('number')

    const result = cancelPendingSteer(deps, 'run-1')
    expect(result).toEqual({ cancelled: true, hadPending: true })
    expect(transport.cancel).toHaveBeenCalled()
    expect(runManager.get('run-1')?.liveSteerTransport).toBeUndefined()
    // The run itself is untouched: it keeps running to its natural boundary.
    expect(runManager.get('run-1')?.status).toBe('running')
  })
})

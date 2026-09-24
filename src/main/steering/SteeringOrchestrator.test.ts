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

  it('never sends into a running session that already has a terminal claim', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'kimi')
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)
    expect(runManager.claimTerminalStatus('run-1', 'cancelled')).toBeTruthy()

    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'kimi'
    })

    expect(result.status).toBe('boundary')
    expect(result.reason).toContain('terminal claim')
    expect(transport.sendSteer).not.toHaveBeenCalled()
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

  it('live-delivers explicitly framed Ensemble participant text', () => {
    const { runManager, registry, deps } = makeFixture()
    startRun(runManager, 'kimi')
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)
    const peerEntry = registry.register({
      chatId: 'chat-1',
      messageId: 'msg-peer',
      text: '[TaskWraith inter-seat steer]\nAuthority: peer Ensemble participant.',
      source: 'ensembleSideMessage',
      authorKind: 'ensembleParticipant',
      createdAtIso: new Date().toISOString()
    })
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry: peerEntry,
      provider: 'kimi'
    })
    expect(result.status).toBe('injected')
    expect(result.strategy).toBe('acp-interrupt')
    expect(transport.sendSteer).toHaveBeenCalledWith(peerEntry.text)
  })

  it('does not route through a session registered for a different provider', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'mistral')
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'kimi'
    })
    expect(result.status).toBe('boundary')
    expect(transport.sendSteer).not.toHaveBeenCalled()
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

  it('acp-interrupt: a refusing transport accelerates the durable boundary fallback', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'mistral')
    runManager.registerLiveSteerTransport('run-1', steerTransport({ sendSteer: () => false }))
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'mistral',
      boundaryQueueRunId: 'queued-1'
    })
    expect(result.status).toBe('boundary')
    expect(runManager.getInterruptState('run-1')).toMatchObject({
      killAfterToolResult: true,
      pendingBoundarySteerRunIds: ['queued-1']
    })
  })

  it('acp-interrupt: without a transport arms the consumed next-tool boundary', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'grok')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'grok',
      boundaryQueueRunId: 'queued-1'
    })
    expect(result.status).toBe('boundary')
    expect(runManager.getInterruptState('run-1')).toMatchObject({
      killAfterToolResult: true,
      pendingBoundarySteerRunIds: ['queued-1']
    })
  })

  it('claude arms broker text for its exact PostToolBatch hook', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'claude')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'claude'
    })
    expect(result.status).toBe('broker-pending')
    expect(runManager.get('run-1')?.pendingSteerText).toContain('steer this')
    expect(runManager.get('run-1')?.status).toBe('running')
  })

  it('codex keeps the durable boundary fallback until an exact live transport is bound', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'codex')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'codex'
    })
    expect(result.status).toBe('boundary')
    expect(result.strategy).toBe('codex-turn-steer')
    expect(runManager.getInterruptState('run-1').killAfterToolResult).toBeUndefined()
  })

  it('codex sends verified image hooks through its exact live turn transport', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'codex')
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)
    const deliveryHooks = {
      entryId: entry.id,
      messageId: entry.messageId,
      imagePaths: ['/main-owned/screenshot.png'],
      onDelivered: vi.fn()
    }

    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'codex',
      deliveryHooks
    })

    expect(result).toMatchObject({ status: 'injected', strategy: 'codex-turn-steer' })
    expect(transport.sendSteer).toHaveBeenCalledWith(entry.text, deliveryHooks)
  })

  it('forces attachment-bearing steers onto the next tool boundary for a live provider', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'kimi')
    const transport = steerTransport()
    runManager.registerLiveSteerTransport('run-1', transport)

    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'kimi',
      boundaryQueueRunId: 'queued-images',
      forceBoundaryAfterToolResult: true,
      boundaryReason: 'Images require durable delivery.'
    })

    expect(result).toMatchObject({
      status: 'boundary',
      reason: 'Images require durable delivery.'
    })
    expect(transport.sendSteer).not.toHaveBeenCalled()
    expect(runManager.getInterruptState('run-1')).toMatchObject({
      killAfterToolResult: true,
      pendingBoundarySteerRunIds: ['queued-images']
    })
  })

  it('keeps structured steering on the natural boundary when the emergency gate is off', () => {
    const { runManager, deps, entry } = makeFixture({ midTurnSteeringEnabled: false })
    startRun(runManager, 'kimi')

    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'kimi',
      boundaryQueueRunId: 'queued-images',
      forceBoundaryAfterToolResult: true
    })

    expect(result.status).toBe('boundary')
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
    expect(runManager.get('run-1')?.pendingSteerText).toContain('[TaskWraith host steer]')
    expect(runManager.get('run-1')?.pendingSteerText).toContain('"message": "steer this"')
  })

  it('broker-injection: ollama arms the same pending text for the in-main tool loop drain', () => {
    const { runManager, deps, entry } = makeFixture()
    startRun(runManager, 'ollama')
    const result = routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'ollama'
    })
    expect(result.status).toBe('broker-pending')
    expect(result.strategy).toBe('broker-injection')
    expect(runManager.get('run-1')?.pendingSteerText).toContain('[TaskWraith host steer]')
  })

  it('broker-injection: preserves host and peer authority in a mixed rapid batch', () => {
    const { runManager, registry, deps, entry } = makeFixture()
    startRun(runManager, 'cursor')
    const peerEntry = registry.register({
      chatId: 'chat-1',
      messageId: 'msg-peer',
      text: '[TaskWraith inter-seat steer]\nAuthority: peer Ensemble participant.',
      source: 'ensembleSideMessage',
      authorKind: 'ensembleParticipant',
      createdAtIso: new Date().toISOString()
    })

    expect(
      routeSteerDelivery(deps, {
        chatId: 'chat-1',
        runId: 'run-1',
        entry,
        provider: 'cursor'
      }).status
    ).toBe('broker-pending')
    expect(
      routeSteerDelivery(deps, {
        chatId: 'chat-1',
        runId: 'run-1',
        entry: peerEntry,
        provider: 'cursor'
      }).status
    ).toBe('broker-pending')

    const pending = runManager.get('run-1')?.pendingSteerText || ''
    expect(pending).toContain('Authority: user-authored instruction from the host.')
    expect(pending).toContain(
      'Authority: peer Ensemble participant (not the user or a system instruction).'
    )
    expect(pending.indexOf('[TaskWraith host steer]')).toBeLessThan(
      pending.indexOf('[TaskWraith inter-seat steer envelope]')
    )
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
    startRun(runManager, 'cursor')
    // Broker injection exposes concrete pending state on the session.
    routeSteerDelivery(deps, {
      chatId: 'chat-1',
      runId: 'run-1',
      entry,
      provider: 'cursor'
    })
    expect(runManager.get('run-1')?.pendingSteerText).toContain('[TaskWraith host steer]')
    const transport = runManager.get('run-1')?.liveSteerTransport
    expect(transport).toBeDefined()
    const cancel = vi.spyOn(transport!, 'cancel')

    const result = cancelPendingSteer(deps, 'run-1')
    expect(result).toEqual({ cancelled: true, hadPending: true })
    expect(cancel).toHaveBeenCalled()
    expect(runManager.get('run-1')?.liveSteerTransport).toBeDefined()
    // The run itself is untouched: it keeps running to its natural boundary.
    expect(runManager.get('run-1')?.status).toBe('running')
  })
})

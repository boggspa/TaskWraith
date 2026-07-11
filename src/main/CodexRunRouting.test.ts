import { describe, expect, it } from 'vitest'
import {
  decideCodexEnsembleFence,
  resolveCodexExplicitThreadRoute,
  shouldRestartCodexAppServerForMcpConfig,
  shouldRouteCodexRunSession
} from './CodexRunRouting'

describe('CodexRunRouting', () => {
  it('routes only live, incomplete ensemble sessions', () => {
    expect(
      shouldRouteCodexRunSession({ ensemble: true, status: 'running', stateCompleted: false })
    ).toBe(true)
    expect(
      shouldRouteCodexRunSession({ ensemble: true, status: 'completed', stateCompleted: true })
    ).toBe(false)
    expect(
      shouldRouteCodexRunSession({ ensemble: true, status: 'cancelled', stateCompleted: false })
    ).toBe(false)
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'does not route a %s ensemble session',
    (status) => {
      expect(
        shouldRouteCodexRunSession({ ensemble: true, status, stateCompleted: false })
      ).toBe(false)
    }
  )

  it('does not route an already-completed state even if its session still looks active', () => {
    expect(
      shouldRouteCodexRunSession({ ensemble: true, status: 'running', stateCompleted: true })
    ).toBe(false)
  })

  it('preserves the existing solo native-goal routing contract', () => {
    expect(
      shouldRouteCodexRunSession({
        ensemble: false,
        status: 'completed',
        stateCompleted: true,
        allowTerminalNativeGoal: true
      })
    ).toBe(true)
  })

  it('does not route an ordinary cancelled solo run', () => {
    expect(
      shouldRouteCodexRunSession({
        ensemble: false,
        status: 'cancelled',
        stateCompleted: false
      })
    ).toBe(false)
  })

  it('restarts a stale Codex app-server only when its transport is idle', () => {
    expect(
      shouldRestartCodexAppServerForMcpConfig({
        stale: true,
        startupLeaseCount: 0,
        activeStates: []
      })
    ).toBe(true)
    expect(
      shouldRestartCodexAppServerForMcpConfig({
        stale: true,
        startupLeaseCount: 1,
        activeStates: []
      })
    ).toBe(false)
    expect(
      shouldRestartCodexAppServerForMcpConfig({
        stale: true,
        startupLeaseCount: 0,
        activeStates: [{ threadId: 'thread-1', completed: false }]
      })
    ).toBe(false)
  })

  it('does not let exec fallback state pin the shared Codex app-server', () => {
    expect(
      shouldRestartCodexAppServerForMcpConfig({
        stale: true,
        startupLeaseCount: 0,
        activeStates: [undefined]
      })
    ).toBe(true)
    expect(
      shouldRestartCodexAppServerForMcpConfig({
        stale: true,
        startupLeaseCount: 0,
        activeStates: [{ threadId: 'thread-1', completed: true }]
      })
    ).toBe(true)
    expect(
      shouldRestartCodexAppServerForMcpConfig({
        stale: false,
        startupLeaseCount: 0,
        activeStates: []
      })
    ).toBe(false)
  })

  it('never falls an unknown or terminal explicit thread through to another active run', () => {
    expect(
      resolveCodexExplicitThreadRoute({
        hasExplicitThreadId: true,
        exactSessionRoutable: false,
        registeredChildOwner: false
      })
    ).toBe('none')
  })

  it('routes a registered child thread only to its actual multi-agent owner', () => {
    expect(
      resolveCodexExplicitThreadRoute({
        hasExplicitThreadId: true,
        exactSessionRoutable: false,
        registeredChildOwner: true
      })
    ).toBe('child_owner')
  })

  it('interrupts an orphan turn on a TaskWraith-steered thread', () => {
    expect(
      decideCodexEnsembleFence({
        taskWraithSteeredThread: true,
        sessionStatus: 'completed',
        sessionIsEnsemble: true,
        method: 'turn/started',
        turnId: 'orphan-turn'
      })
    ).toEqual({ action: 'interrupt', turnId: 'orphan-turn' })
  })

  it('also fences a reused ensemble thread before a new session is registered', () => {
    expect(
      decideCodexEnsembleFence({
        taskWraithSteeredThread: true,
        sessionIsEnsemble: false,
        method: 'thread/goal/updated'
      })
    ).toEqual({ action: 'clear_native_goal' })
  })

  it('interrupts the no-session resume window for a remembered ensemble thread', () => {
    expect(
      decideCodexEnsembleFence({
        taskWraithSteeredThread: true,
        sessionIsEnsemble: false,
        method: 'turn/started',
        turnId: 'resume-race-turn'
      })
    ).toEqual({ action: 'interrupt', turnId: 'resume-race-turn' })
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'interrupts a %s ensemble session that starts another turn',
    (sessionStatus) => {
      expect(
        decideCodexEnsembleFence({
          taskWraithSteeredThread: false,
          sessionStatus,
          sessionIsEnsemble: true,
          method: 'turn/started',
          turnId: 'late-turn'
        })
      ).toEqual({ action: 'interrupt', turnId: 'late-turn' })
    }
  )

  it('drops ordinary post-terminal ensemble items', () => {
    expect(
      decideCodexEnsembleFence({
        taskWraithSteeredThread: false,
        sessionStatus: 'completed',
        sessionIsEnsemble: true,
        method: 'item/started'
      })
    ).toEqual({ action: 'drop' })
  })

  it('does not fence the explicit TaskWraith turn while its session is active', () => {
    expect(
      decideCodexEnsembleFence({
        taskWraithSteeredThread: true,
        sessionStatus: 'running',
        sessionIsEnsemble: true,
        method: 'turn/started',
        turnId: 'expected-turn'
      })
    ).toEqual({ action: 'route' })
  })
})

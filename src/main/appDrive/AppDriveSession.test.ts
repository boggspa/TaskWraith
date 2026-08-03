import { describe, expect, it } from 'vitest'

import {
  APP_DRIVE_SESSION_LIFECYCLES,
  AppDriveSession,
  AppDriveSessionError,
  type AppDriveSessionBinding
} from './AppDriveSession'

function createSession(nowValue = 10_000): {
  session: AppDriveSession
  now: { value: number }
} {
  const now = { value: nowValue }
  let id = 0
  const session = new AppDriveSession({
    now: () => now.value,
    createSessionId: () => `session-${++id}`
  })
  return { session, now }
}

function binding(overrides: Partial<AppDriveSessionBinding> = {}): AppDriveSessionBinding {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    provider: 'codex',
    launchAttemptId: 'attempt-a',
    approvedAt: 9_000,
    allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
    expiresAt: 20_000,
    stepBudget: 20,
    stepsUsed: 0,
    target: {
      applicationName: 'Fixture App',
      windowTitle: 'Main',
      bundleID: 'com.example.fixture'
    },
    ...overrides
  }
}

function expectCode(
  action: () => unknown,
  code: AppDriveSessionError['code']
): AppDriveSessionError {
  try {
    action()
    throw new Error(`Expected AppDriveSessionError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(AppDriveSessionError)
    expect((error as AppDriveSessionError).code).toBe(code)
    return error as AppDriveSessionError
  }
}

describe('AppDriveSession', () => {
  it('starts idle with no authority minting and refuses actions', () => {
    const { session } = createSession()
    const status = session.status()

    expect(status.lifecycle).toBe('idle')
    expect(status.mode).toBeNull()
    expect(status.modeLabel).toBeNull()
    expect(status.permissionLabel).toBeNull()
    expect(status.canAdmitActions).toBe(false)
    expect(status.controls).toEqual({
      canPause: false,
      canResume: false,
      canTakeOver: false,
      canStop: false
    })
    expect(session.canAdmitActions()).toBe(false)
    expectCode(() => session.assertCanAdmitActions(), 'no-active-session')
  })

  it('binds an existing control projection as Foreground Drive View & Control without broadening verbs', () => {
    const { session } = createSession()
    const result = session.bind(binding())

    expect(result.replaced).toBeNull()
    expect(result.session).toMatchObject({
      sessionId: 'session-1',
      mode: 'foreground',
      permissionLabel: 'view-and-control',
      lifecycle: 'active',
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex',
      launchAttemptId: 'attempt-a',
      stepBudget: 20,
      stepsUsed: 0,
      stepsRemaining: 20
    })
    expect(Object.isFrozen(result.session)).toBe(true)
    expect(Object.isFrozen(result.session.allowedVerbs)).toBe(true)

    const status = session.status()
    expect(status.modeLabel).toBe('Foreground Drive')
    expect(status.permissionLabel).toBe('View & Control')
    expect(status.canAdmitActions).toBe(true)
    expect(status.target).toEqual({
      applicationName: 'Fixture App',
      windowTitle: 'Main',
      bundleID: 'com.example.fixture'
    })
    expect(status.controls).toEqual({
      canPause: true,
      canResume: false,
      canTakeOver: true,
      canStop: true
    })
    // Renderer projection never invents secret authority tokens.
    expect(status).not.toHaveProperty('windowHandleId')
    expect(status).not.toHaveProperty('consentEpoch')
    expect(status).not.toHaveProperty('instanceEpoch')
    expect(status).not.toHaveProperty('selectedPid')

    session.assertCanAdmitActions('click')
  })

  it('refuses new actions while paused and restores admission only on resume', () => {
    const { session, now } = createSession()
    session.bind(binding())

    const paused = session.pause()
    expect(paused.lifecycle).toBe('paused')
    expect(paused.pausedAt).toBe(now.value)
    expect(session.canAdmitActions()).toBe(false)
    expectCode(() => session.assertCanAdmitActions('fill'), 'session-paused')

    const status = session.status()
    expect(status.lifecycle).toBe('paused')
    expect(status.canAdmitActions).toBe(false)
    expect(status.controls).toEqual({
      canPause: false,
      canResume: true,
      canTakeOver: true,
      canStop: true
    })

    now.value = 11_000
    const resumed = session.resume()
    expect(resumed.lifecycle).toBe('active')
    expect(resumed.pausedAt).toBeNull()
    expect(session.canAdmitActions()).toBe(true)
    session.assertCanAdmitActions('observe')
  })

  it('refuses new actions during takeover until explicit resume', () => {
    const { session, now } = createSession()
    session.bind(binding())

    const takeover = session.takeOver()
    expect(takeover.lifecycle).toBe('takeover')
    expect(takeover.takeoverAt).toBe(now.value)
    expect(session.canAdmitActions()).toBe(false)
    expectCode(() => session.assertCanAdmitActions('click'), 'session-takeover')

    expect(session.status().controls).toEqual({
      canPause: false,
      canResume: true,
      canTakeOver: false,
      canStop: true
    })

    // Pause while already in takeover is an invalid transition.
    expectCode(() => session.pause(), 'invalid-transition')

    now.value = 12_000
    const resumed = session.resume()
    expect(resumed.lifecycle).toBe('active')
    expect(resumed.takeoverAt).toBeNull()
    expect(session.canAdmitActions()).toBe(true)
  })

  it('allows takeover from paused and still refuses actions until resume', () => {
    const { session, now } = createSession()
    session.bind(binding())
    session.pause()
    now.value = 10_500

    const takeover = session.takeOver()
    expect(takeover.lifecycle).toBe('takeover')
    expect(takeover.pausedAt).toBe(10_000)
    expect(takeover.takeoverAt).toBe(10_500)
    expectCode(() => session.assertCanAdmitActions(), 'session-takeover')
  })

  it('stop terminates admission and clearStopped returns idle', () => {
    const { session, now } = createSession()
    session.bind(binding())

    const stopped = session.stop('user-stop')
    expect(stopped?.lifecycle).toBe('stopped')
    expect(stopped?.stopReason).toBe('user-stop')
    expect(stopped?.stoppedAt).toBe(now.value)
    expect(session.canAdmitActions()).toBe(false)
    expectCode(() => session.assertCanAdmitActions(), 'session-stopped')
    expectCode(() => session.pause(), 'session-stopped')

    const terminalStatus = session.status()
    expect(terminalStatus.lifecycle).toBe('stopped')
    expect(terminalStatus.modeLabel).toBe('Foreground Drive')
    expect(terminalStatus.canAdmitActions).toBe(false)
    expect(terminalStatus.controls.canStop).toBe(false)

    session.clearStopped()
    expect(session.status().lifecycle).toBe('idle')
    expect(session.getSnapshot()).toBeNull()
  })

  it('mirrors lease budget without changing identity or minting authority', () => {
    const { session } = createSession()
    session.bind(binding())

    const mirrored = session.mirrorControlBudget({
      chatId: 'chat-a',
      runId: 'run-a',
      launchAttemptId: 'attempt-a',
      expiresAt: 19_000,
      stepBudget: 20,
      stepsUsed: 3
    })

    expect(mirrored.stepsUsed).toBe(3)
    expect(mirrored.stepsRemaining).toBe(17)
    expect(mirrored.expiresAt).toBe(19_000)
    expect(mirrored.chatId).toBe('chat-a')
    expect(session.status().stepsRemaining).toBe(17)

    const exhausted = session.mirrorControlBudget({
      chatId: 'chat-a',
      runId: 'run-a',
      launchAttemptId: 'attempt-a',
      expiresAt: 19_000,
      stepBudget: 20,
      stepsUsed: 20
    })
    expect(exhausted.stepsRemaining).toBe(0)
    expect(session.status().canAdmitActions).toBe(false)
    expect(session.evaluateAdmission('click')).toMatchObject({
      admitted: false,
      code: 'step-budget-exhausted'
    })
    expectCode(() => session.assertCanAdmitActions('click'), 'step-budget-exhausted')

    expectCode(
      () =>
        session.mirrorControlBudget({
          chatId: 'chat-other',
          runId: 'run-a',
          launchAttemptId: 'attempt-a',
          expiresAt: 19_000,
          stepBudget: 20,
          stepsUsed: 4
        }),
      'binding-mismatch'
    )
  })

  it('expires the binding and refuses further actions without re-granting authority', () => {
    const { session, now } = createSession()
    session.bind(binding({ expiresAt: 10_500 }))

    now.value = 10_500
    expect(session.canAdmitActions()).toBe(false)
    expectCode(() => session.assertCanAdmitActions('click'), 'session-expired')

    const status = session.status()
    expect(status.lifecycle).toBe('stopped')
    expect(status.stopReason).toBe('expired')
    expect(status.canAdmitActions).toBe(false)
  })

  it('replace-bind stops the previous live session without persisting authority', () => {
    const { session } = createSession()
    session.bind(binding())
    const second = session.bind(
      binding({
        runId: 'run-b',
        launchAttemptId: 'attempt-b',
        stepsUsed: 1
      })
    )

    expect(second.replaced?.lifecycle).toBe('stopped')
    expect(second.replaced?.stopReason).toBe('replaced')
    expect(second.session.runId).toBe('run-b')
    expect(second.session.sessionId).toBe('session-2')
    expect(session.status().runId).toBe('run-b')
    expect(session.canAdmitActions()).toBe(true)
  })

  it('exposes the canonical idle|active|paused|takeover|stopped lifecycle set', () => {
    expect([...APP_DRIVE_SESSION_LIFECYCLES]).toEqual([
      'idle',
      'active',
      'paused',
      'takeover',
      'stopped'
    ])
  })

  it('returns a fail-closed evaluateAdmission result for the CanvasWindowDriver gate', () => {
    const { session, now } = createSession()

    const idle = session.evaluateAdmission()
    expect(idle).toMatchObject({
      admitted: false,
      lifecycle: 'idle',
      code: 'no-active-session',
      chromeOnly: true,
      requiresCoordinatorAuthority: true
    })

    session.bind(binding())
    const active = session.evaluateAdmission('click')
    expect(active).toMatchObject({
      admitted: true,
      lifecycle: 'active',
      code: null,
      chromeOnly: true,
      requiresCoordinatorAuthority: true,
      sessionId: 'session-1'
    })
    expect(Object.isFrozen(active)).toBe(true)

    session.pause()
    expect(session.evaluateAdmission('fill')).toMatchObject({
      admitted: false,
      lifecycle: 'paused',
      code: 'session-paused',
      chromeOnly: true
    })

    session.resume()
    session.takeOver()
    expect(session.evaluateAdmission()).toMatchObject({
      admitted: false,
      code: 'session-takeover',
      lifecycle: 'takeover'
    })

    session.resume()
    // stop is chrome-only: admission refuses, but this module never claims
    // coordinator lease revoke — integrators must call coordinator revoke.
    const stopped = session.stop('user-stop')
    expect(stopped?.lifecycle).toBe('stopped')
    expect(session.evaluateAdmission()).toMatchObject({
      admitted: false,
      code: 'session-stopped',
      stopReason: 'user-stop',
      chromeOnly: true,
      requiresCoordinatorAuthority: true
    })

    session.clearStopped()
    session.bind(binding({ expiresAt: 10_500 }))
    now.value = 10_500
    const expired = session.evaluateAdmission('click')
    expect(expired).toMatchObject({
      admitted: false,
      lifecycle: 'stopped',
      code: 'session-expired',
      stopReason: 'expired'
    })
    expectCode(() => session.assertCanAdmitActions('click'), 'session-expired')
  })

  it('rejects invalid bindings and unknown verbs instead of inventing defaults', () => {
    const { session } = createSession()

    expectCode(() => session.bind(binding({ chatId: '  ' })), 'invalid-input')
    expectCode(() => session.bind(binding({ expiresAt: 9_000 })), 'invalid-input')
    expectCode(() => session.bind(binding({ allowedVerbs: [] })), 'invalid-input')
    expectCode(
      () => session.bind(binding({ allowedVerbs: ['click', 'warp' as 'click'] })),
      'invalid-input'
    )

    session.bind(binding({ allowedVerbs: ['observe', 'inspect'] }))
    expectCode(() => session.assertCanAdmitActions('click'), 'invalid-input')
  })
})

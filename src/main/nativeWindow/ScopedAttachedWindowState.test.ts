import { describe, expect, it } from 'vitest'

import {
  ScopedAttachedWindowState,
  ScopedAttachedWindowStateError,
  type ScopedAttachedWindowCompleteInput,
  type ScopedAttachedWindowMeta,
  type ScopedAttachedWindowPick,
  type ScopedAttachedWindowStateErrorCode,
  type ScopedAttachedWindowStateOptions
} from './ScopedAttachedWindowState'

function createState(options: Partial<ScopedAttachedWindowStateOptions> = {}): {
  state: ScopedAttachedWindowState
  issued: string[]
} {
  let nextID = 0
  const issued: string[] = []
  const state = new ScopedAttachedWindowState({
    createScopeID:
      options.createScopeID ??
      (() => {
        const id = `scope-${++nextID}`
        issued.push(id)
        return id
      }),
    now: options.now ?? (() => '2026-07-28T03:00:00.000Z')
  })
  return { state, issued }
}

function windowMeta(overrides: Partial<ScopedAttachedWindowMeta> = {}): ScopedAttachedWindowMeta {
  const pid = overrides.pid ?? 501
  return {
    windowID: 42,
    title: 'User-picked document',
    bundleID: 'com.example.editor',
    applicationName: 'Example Editor',
    pid,
    identityQuality: 'exact',
    processIdentity: {
      pid,
      launchTimeMicros: 1_774_843_200_000_000,
      source: 'nsRunningApplication'
    },
    processStartedAt: 'nsRunningApplication:1774843200000000',
    bounds: {
      x: 10,
      y: 20,
      width: 800,
      height: 600
    },
    ...overrides
  }
}

function completion(
  pick: ScopedAttachedWindowPick,
  overrides: Partial<ScopedAttachedWindowCompleteInput> = {}
): ScopedAttachedWindowCompleteInput {
  return {
    ...pick,
    handleID: 'handle-1',
    generation: 1,
    windowMeta: windowMeta(),
    ...overrides
  }
}

function expectCode(
  action: () => unknown,
  code: ScopedAttachedWindowStateErrorCode
): ScopedAttachedWindowStateError {
  try {
    action()
    throw new Error(`Expected ScopedAttachedWindowStateError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(ScopedAttachedWindowStateError)
    expect((error as ScopedAttachedWindowStateError).code).toBe(code)
    return error as ScopedAttachedWindowStateError
  }
}

describe('ScopedAttachedWindowState', () => {
  it('mints immutable, opaque picker scopes with strictly monotonic consent epochs', () => {
    const { state } = createState()

    const first = state.beginPick('chat-a')
    expect(first).toEqual({ scopeID: 'scope-1', chatID: 'chat-a', consentEpoch: 0 })
    expect(Object.isFrozen(first)).toBe(true)
    expectCode(() => state.beginPick('chat-b'), 'pending-picker-exists')

    expect(state.cancelPick({ scopeID: first.scopeID, chatID: 'chat-b', consentEpoch: 0 })).toBe(
      false
    )
    expect(state.status().pickerPending).toBe(true)
    expect(state.cancelPick(first)).toBe(true)

    const second = state.beginPick('chat-b')
    expect(second.consentEpoch).toBe(1)
    expect(state.cancelPick(second)).toBe(true)
    const third = state.beginPick('chat-c')
    expect(third.consentEpoch).toBe(2)
  })

  it('keeps the exact picker pending when completion is stale or malformed', () => {
    const { state } = createState()
    const pending = state.beginPick('chat-a')

    expectCode(
      () =>
        state.completePick(
          completion({ ...pending, scopeID: 'stale-scope' }, { handleID: 'stale-handle' })
        ),
      'pending-picker-mismatch'
    )
    expectCode(() => state.completePick(completion(pending, { generation: 0 })), 'invalid-input')
    expectCode(() => state.completePick(completion(pending, { handleID: '  ' })), 'invalid-input')
    expectCode(
      () =>
        state.completePick(
          completion(pending, {
            windowMeta: windowMeta({
              processIdentity: {
                pid: 999,
                launchTimeMicros: 1_774_843_200_000_000,
                source: 'procBSDInfo'
              }
            })
          })
        ),
      'invalid-input'
    )
    expectCode(
      () =>
        state.completePick(
          completion(pending, {
            windowMeta: windowMeta({ processStartedAt: 'procBSDInfo:1774843200000000' })
          })
        ),
      'invalid-input'
    )

    expect(state.status()).toEqual({ pickerPending: true, active: null })
    expect(state.completePick(completion(pending)).active.scopeID).toBe(pending.scopeID)
  })

  it('atomically replaces the old attachment and rejects a stale completion', () => {
    const { state } = createState()
    const firstPick = state.beginPick('chat-a')
    const first = state.completePick(completion(firstPick)).active
    const secondPick = state.beginPick('chat-b')

    expect(state.getForChat('chat-a')).toBe(first)
    expectCode(
      () =>
        state.completePick(
          completion(firstPick, {
            handleID: 'replayed-handle',
            generation: 2
          })
        ),
      'pending-picker-mismatch'
    )

    const replacement = state.completePick(
      completion(secondPick, {
        handleID: 'handle-2',
        generation: 2,
        windowMeta: windowMeta({ windowID: 84, title: 'Second window' })
      })
    )
    expect(replacement.replaced).toBe(first)
    expect(replacement.active).toMatchObject({
      handleID: 'handle-2',
      scopeID: secondPick.scopeID,
      consentEpoch: 1,
      generation: 2
    })
    expect(state.getForChat('chat-a')).toBeNull()
    expect(state.getForChat('chat-b')).toBe(replacement.active)
  })

  it('fails closed for missing and cross-chat executor identity', () => {
    const { state } = createState()
    const pick = state.beginPick('chat-a')
    const active = state.completePick(completion(pick)).active

    expect(state.getForChat(undefined)).toBeNull()
    expect(state.getForChat(null)).toBeNull()
    expect(state.getForChat(' chat-a')).toBeNull()
    expect(state.getForChat('chat-b')).toBeNull()
    expect(state.getForChat('chat-a')).toBe(active)

    expectCode(() => state.requireForExecutor(undefined), 'missing-app-chat-id')
    expectCode(() => state.requireForExecutor('chat-b'), 'chat-mismatch')
    expect(state.requireForExecutor('chat-a')).toBe(active)
  })

  it('accepts arbitrary best-effort user-picked windows for observation', () => {
    const { state } = createState()
    const pick = state.beginPick('chat-observer')
    const active = state.completePick(
      completion(pick, {
        windowMeta: windowMeta({
          title: '',
          bundleID: '',
          applicationName: '',
          identityQuality: 'bestEffort'
        })
      })
    ).active

    expect(active.windowMeta.identityQuality).toBe('bestEffort')
    expect(active).not.toHaveProperty('runId')
    expect(active).not.toHaveProperty('launchAttemptId')
    expect(active).not.toHaveProperty('allowedVerbs')
  })

  it('updates streaming only for the exact active scope and generation', () => {
    const { state } = createState()
    const pick = state.beginPick('chat-a')
    const active = state.completePick(completion(pick, { generation: 7 })).active
    const streaming = {
      fps: 2,
      bufferSeconds: 30,
      frameCount: 12,
      startedAt: '2026-07-28T03:01:00.000Z'
    }

    expect(
      state.updateStreaming({
        scopeID: 'stale-scope',
        generation: 7,
        streaming
      })
    ).toBeNull()
    expect(
      state.updateStreaming({
        scopeID: active.scopeID,
        generation: 6,
        streaming
      })
    ).toBeNull()
    expect(state.getForChat('chat-a')?.streaming).toBeUndefined()

    const updated = state.updateStreaming({
      scopeID: active.scopeID,
      generation: active.generation,
      streaming
    })
    streaming.frameCount = 99
    expect(updated?.streaming?.frameCount).toBe(12)
    expect(Object.isFrozen(updated?.streaming)).toBe(true)
    expect(state.status().active?.streaming?.frameCount).toBe(12)

    const cleared = state.updateStreaming({
      scopeID: active.scopeID,
      generation: active.generation,
      streaming: null
    })
    expect(cleared?.streaming).toBeUndefined()
  })

  it('makes stale detach harmless and requires exact chat, scope, and generation', () => {
    const { state } = createState()
    const pick = state.beginPick('chat-a')
    const active = state.completePick(completion(pick, { generation: 4 })).active

    expect(state.detach({ chatID: 'chat-b', scopeID: active.scopeID, generation: 4 })).toBeNull()
    expect(state.detach({ chatID: 'chat-a', scopeID: 'scope-stale', generation: 4 })).toBeNull()
    expect(state.detach({ chatID: 'chat-a', scopeID: active.scopeID, generation: 3 })).toBeNull()
    expect(state.requireForExecutor('chat-a')).toBe(active)

    expect(
      state.detach({
        chatID: active.chatID,
        scopeID: active.scopeID,
        generation: active.generation
      })
    ).toBe(active)
    expect(
      state.detach({
        chatID: active.chatID,
        scopeID: active.scopeID,
        generation: active.generation
      })
    ).toBeNull()
  })

  it('projects renderer status without main-only authority or process receipts', () => {
    const { state } = createState()
    const pick = state.beginPick('chat-a')
    const completeInput = completion(pick, { generation: 3 })
    const completed = state.completePick(completeInput)
    const active = completed.active
    const mutableInputMeta = completeInput.windowMeta as { title: string }
    mutableInputMeta.title = 'mutated after completion'
    const status = state.status()

    expect(Object.isFrozen(completed)).toBe(true)
    expect(Object.isFrozen(active)).toBe(true)
    expect(Object.isFrozen(active.windowMeta)).toBe(true)
    expect(Object.isFrozen(active.windowMeta.processIdentity)).toBe(true)
    expect(status).toMatchObject({
      pickerPending: false,
      active: {
        chatID: 'chat-a',
        generation: 3,
        attachedAt: '2026-07-28T03:00:00.000Z',
        windowMeta: {
          title: 'User-picked document',
          bundleID: 'com.example.editor',
          applicationName: 'Example Editor',
          identityQuality: 'exact'
        }
      }
    })
    expect(status.active).not.toHaveProperty('scopeID')
    expect(status.active).not.toHaveProperty('consentEpoch')
    expect(status.active).not.toHaveProperty('handleID')
    expect(status.active?.windowMeta).not.toHaveProperty('windowID')
    expect(status.active?.windowMeta).not.toHaveProperty('pid')
    expect(status.active?.windowMeta).not.toHaveProperty('processIdentity')
    expect(status.active?.windowMeta).not.toHaveProperty('processStartedAt')
    expect(status.active?.windowMeta).not.toHaveProperty('pgid')
    expect(status.active?.windowMeta).not.toHaveProperty('bounds')
    expect(Object.isFrozen(status)).toBe(true)
    expect(Object.isFrozen(status.active)).toBe(true)
    expect(Object.isFrozen(status.active?.windowMeta)).toBe(true)

    expect(state.clearActive()).toBe(active)
    expect(state.clearActive()).toBeNull()
    expect(state.status()).toEqual({ pickerPending: false, active: null })
    expectCode(() => state.requireForExecutor('chat-a'), 'no-active-attachment')
  })

  it('rejects reused generated scope IDs without consuming another consent epoch', () => {
    const ids = ['fixed-scope', 'fixed-scope', 'next-scope']
    const { state } = createState({ createScopeID: () => ids.shift() ?? 'unexpected-scope' })
    const first = state.beginPick('chat-a')
    expect(first.consentEpoch).toBe(0)
    expect(state.cancelPick(first)).toBe(true)

    expectCode(() => state.beginPick('chat-a'), 'scope-id-collision')
    expect(state.status()).toEqual({ pickerPending: false, active: null })
    expect(state.beginPick('chat-a')).toEqual({
      scopeID: 'next-scope',
      chatID: 'chat-a',
      consentEpoch: 1
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  CHAT_KIND_SWITCH_LEASE_MS,
  ChatKindSwitchGate,
  type ChatKindSwitchAdmission,
  type ChatKindSwitchRefusal,
  type ChatKindSwitchRequest
} from './chatKindSwitchGate'

function gateAt(clock: { now: number }): ChatKindSwitchGate {
  return new ChatKindSwitchGate(() => clock.now)
}

function turnOn(overrides: Partial<ChatKindSwitchRequest> = {}): ChatKindSwitchRequest {
  return {
    chatId: 'chat-1',
    currentKind: 'single',
    enabled: true,
    ensembleModeEnabled: true,
    chatIsRunning: false,
    ...overrides
  }
}

/** Assert a refusal and narrow to it, so no test can pass by being admitted. */
function refusalOf(admission: ChatKindSwitchAdmission): ChatKindSwitchRefusal {
  if (admission.admitted) throw new Error('expected a refusal, but the switch was admitted')
  return admission.refusal
}

function tokenOf(admission: ChatKindSwitchAdmission): number {
  if (!admission.admitted) {
    throw new Error(`expected an admission, but it was refused: ${admission.refusal.reason}`)
  }
  return admission.token
}

describe('ChatKindSwitchGate', () => {
  it('admits an idle solo thread asking for Ensemble', () => {
    const gate = gateAt({ now: 0 })
    expect(tokenOf(gate.admit(turnOn()))).toBe(1)
  })

  it('explains a linked child, which used to be a bare return', () => {
    const gate = gateAt({ now: 0 })
    const refusal = refusalOf(gate.admit(turnOn({ parentChatId: 'parent-1' })))
    expect(refusal.reason).toBe('linked-child')
    expect(refusal.message).toBe(
      'Side chats and sub-threads follow their parent thread. Switch Ensemble on the parent instead.'
    )
  })

  it('explains Ensemble Mode being switched off', () => {
    const gate = gateAt({ now: 0 })
    const refusal = refusalOf(gate.admit(turnOn({ ensembleModeEnabled: false })))
    expect(refusal.reason).toBe('mode-disabled')
    expect(refusal.message).toBe('Ensemble Mode is switched off in Settings.')
  })

  it('explains a thread that is mid-turn', () => {
    const gate = gateAt({ now: 0 })
    const refusal = refusalOf(gate.admit(turnOn({ chatIsRunning: true })))
    expect(refusal.reason).toBe('chat-running')
    expect(refusal.message).toBe('Finish the current turn first to change chat mode.')
  })

  // The one refusal that must stay quiet: the thread is already in the mode the
  // user asked for, so a notice would report a non-event.
  it('says nothing when the thread is already in the requested mode', () => {
    const gate = gateAt({ now: 0 })
    const refusal = refusalOf(gate.admit(turnOn({ currentKind: 'ensemble' })))
    expect(refusal.reason).toBe('already-in-mode')
    expect(refusal.message).toBeNull()
  })

  // Ensemble Mode being switched off must never strand a thread that already is
  // an Ensemble: the gate only blocks turning it ON.
  it('lets an Ensemble collapse to solo while Ensemble Mode is off', () => {
    const gate = gateAt({ now: 0 })
    expect(
      tokenOf(
        gate.admit(turnOn({ currentKind: 'ensemble', enabled: false, ensembleModeEnabled: false }))
      )
    ).toBe(1)
  })

  it('refuses a second switch while the first is still in flight', () => {
    const gate = gateAt({ now: 0 })
    tokenOf(gate.admit(turnOn()))
    const refusal = refusalOf(gate.admit(turnOn()))
    expect(refusal.reason).toBe('switch-in-flight')
    expect(refusal.message).toBe(
      'A mode change is still working on this thread. Try again in a moment.'
    )
  })

  it('releases the lease its own call settled', () => {
    const gate = gateAt({ now: 0 })
    gate.settle(tokenOf(gate.admit(turnOn())))
    expect(gate.held()).toBe(false)
    expect(tokenOf(gate.admit(turnOn()))).toBe(2)
  })

  // The wedge this exists for: `ipcRenderer.invoke` has no timeout, so a
  // `set-chat-kind` that never answers never reaches the caller's `finally`.
  // Without expiry every later click is refused for the life of the window.
  it('expires a lease whose call never answered', () => {
    const clock = { now: 0 }
    const gate = gateAt(clock)
    tokenOf(gate.admit(turnOn()))
    clock.now += CHAT_KIND_SWITCH_LEASE_MS - 1
    expect(refusalOf(gate.admit(turnOn())).reason).toBe('switch-in-flight')
    clock.now += 1
    expect(tokenOf(gate.admit(turnOn()))).toBe(2)
  })

  // The lost call can still land, long after its lease decayed and a later
  // switch took the gate. Its settle must not release the newer claim.
  it('ignores a settle from a lease a later switch superseded', () => {
    const clock = { now: 0 }
    const gate = gateAt(clock)
    const stale = tokenOf(gate.admit(turnOn()))
    clock.now += CHAT_KIND_SWITCH_LEASE_MS
    tokenOf(gate.admit(turnOn()))
    gate.settle(stale)
    expect(gate.held()).toBe(true)
  })

  // A thread that can never switch should say so rather than queue behind
  // whatever is in flight, so the structural answers are decided first.
  it('answers a structural refusal even while a switch is in flight', () => {
    const gate = gateAt({ now: 0 })
    tokenOf(gate.admit(turnOn()))
    expect(refusalOf(gate.admit(turnOn({ parentChatId: 'parent-1' }))).reason).toBe('linked-child')
  })

  it('spends no lease on a refused switch', () => {
    const gate = gateAt({ now: 0 })
    refusalOf(gate.admit(turnOn({ chatIsRunning: true })))
    expect(gate.held()).toBe(false)
    expect(tokenOf(gate.admit(turnOn()))).toBe(1)
  })

  it('refuses a request carrying no chat, without inventing a message', () => {
    const gate = gateAt({ now: 0 })
    const refusal = refusalOf(gate.admit(turnOn({ chatId: null })))
    expect(refusal.reason).toBe('no-chat')
    expect(refusal.message).toBeNull()
  })
})

/**
 * Admission for the solo/Ensemble mode switch behind the composer's Ensemble
 * toggle.
 *
 * Reported 2026-09-11, after `f608f709d` had already answered three causes of
 * the same complaint: the toggle is clicked, the thread stays solo, and nothing
 * says why. Two faults remained, and both are the same shape — a refusal with
 * no words.
 *
 * THE REFUSALS WERE SILENT. `handleToggleEnsembleForChat` opened with four bare
 * `return`s. Three of them are real answers to "why did nothing happen?" — a
 * linked child follows its parent, Ensemble Mode is off in Settings, the thread
 * is mid-turn — and the user was told none of them. The fourth (the chat is
 * already in the requested mode) genuinely has nothing to say, and saying
 * something would be noise; it is the one refusal that stays quiet, and it is
 * modelled explicitly rather than by omission so the difference is testable.
 *
 * Note the linked-child case had a second edge: the button HIDES itself for a
 * side chat or sub-thread (`currentChatIsLinkedChild`), but the handler bailed
 * on `parentChatId` alone. Any other parent relation therefore rendered a live,
 * undimmed control that did nothing at all. It now answers.
 *
 * THE IN-FLIGHT GUARD COULD NOT EXPIRE. The old guard was a bare
 * `useRef(false)` set before `window.api.setChatKind` and cleared in a
 * `finally`. `ipcRenderer.invoke` has no timeout, so a call that never settles
 * never reaches that `finally` — and every later click for the life of the
 * window is refused by a flag nothing can clear. A reload was the only exit,
 * and since the refusal was silent there was nothing to suggest one.
 *
 * The lease below is the same bounded-claim shape the renderer already uses for
 * composer-selection and chat-kind write claims: a claim is honoured only while
 * it is young, so a hung call costs one lease rather than the session. Settling
 * a token that a later admission already superseded is a no-op, so the slow
 * call landing after its own lease decayed cannot release someone else's claim.
 */
import type { ChatKind } from '../../../main/store/types'

/**
 * How long an unsettled switch keeps the control. Deliberately longer than the
 * main-side verification window it waits on — `set-chat-kind` can spend a 5s
 * persist barrier plus a 5s durable re-read before it answers, so a shorter
 * lease here would admit a second switch while the first was still legitimately
 * working. Past this the call is not "in progress", it is lost.
 */
export const CHAT_KIND_SWITCH_LEASE_MS = 30_000

export type ChatKindSwitchRefusalReason =
  | 'no-chat'
  | 'linked-child'
  | 'mode-disabled'
  | 'already-in-mode'
  | 'chat-running'
  | 'switch-in-flight'

export interface ChatKindSwitchRefusal {
  reason: ChatKindSwitchRefusalReason
  /**
   * What to tell the user, or null when the refusal is not worth a word. Kept
   * on the refusal rather than resolved by the caller so a new reason cannot be
   * added without deciding whether it is explicable.
   */
  message: string | null
}

export type ChatKindSwitchAdmission =
  | { admitted: true; token: number }
  | { admitted: false; refusal: ChatKindSwitchRefusal }

export interface ChatKindSwitchRequest {
  chatId: string | null | undefined
  parentChatId?: string | null
  currentKind: ChatKind | undefined
  /** The mode the user asked for: true = Ensemble. */
  enabled: boolean
  ensembleModeEnabled: boolean
  chatIsRunning: boolean
}

const REFUSAL_MESSAGES: Record<ChatKindSwitchRefusalReason, string | null> = {
  'no-chat': null,
  'already-in-mode': null,
  'linked-child':
    'Side chats and sub-threads follow their parent thread. Switch Ensemble on the parent instead.',
  'mode-disabled': 'Ensemble Mode is switched off in Settings.',
  'chat-running': 'Finish the current turn first to change chat mode.',
  'switch-in-flight': 'A mode change is still working on this thread. Try again in a moment.'
}

const refuse = (reason: ChatKindSwitchRefusalReason): ChatKindSwitchAdmission => ({
  admitted: false,
  refusal: { reason, message: REFUSAL_MESSAGES[reason] }
})

export class ChatKindSwitchGate {
  private lease: { token: number; grantedAt: number } | null = null
  private nextToken = 1

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Decide a requested switch. The order matters: the cheap structural answers
   * come first so a thread that can never switch says so even while something
   * else is in flight, and the lease is only spent once the switch is otherwise
   * admissible.
   */
  admit(request: ChatKindSwitchRequest): ChatKindSwitchAdmission {
    if (!request.chatId) return refuse('no-chat')
    if (request.parentChatId) return refuse('linked-child')
    if (!request.ensembleModeEnabled && request.enabled) return refuse('mode-disabled')
    if ((request.currentKind === 'ensemble') === request.enabled) return refuse('already-in-mode')
    if (request.chatIsRunning) return refuse('chat-running')
    if (this.held()) return refuse('switch-in-flight')
    const token = this.nextToken++
    this.lease = { token, grantedAt: this.now() }
    return { admitted: true, token }
  }

  /** Release a lease. A token a later admission already superseded is ignored. */
  settle(token: number): void {
    if (this.lease?.token === token) this.lease = null
  }

  /** Is a live (young) lease outstanding? Exposed for tests and diagnostics. */
  held(): boolean {
    if (!this.lease) return false
    if (this.now() - this.lease.grantedAt >= CHAT_KIND_SWITCH_LEASE_MS) {
      this.lease = null
      return false
    }
    return true
  }
}

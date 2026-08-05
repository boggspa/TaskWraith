/**
 * What clicking "Start Full Access" must do, as a pure decision.
 *
 * This exists because of a real regression class rather than for tidiness. On
 * builds before `cf22ca118` the confirm sheet called `trustedSessionSet` and
 * stopped there: the grant landed in main-process memory, but the seat kept its
 * prompting permission preset and the approval that opened the sheet stayed
 * pending. To a user that is indistinguishable from the button doing nothing —
 * they click it and keep being asked for permission.
 *
 * The two halves are genuinely separate mechanisms and BOTH are required:
 *
 *  - the GRANT unlocks elevated capability (external writes, signing/keychain,
 *    paths outside the workspace), consulted live per approval request;
 *  - the SEAT PRESET (`full_access`) is what changes `effectivePermissions`, and
 *    therefore what stops the routine prompts.
 *
 * A grant without an elevation is the bug. This planner cannot express that
 * state: every outcome that grants also elevates, and the accompanying tests
 * assert it, so the two can never drift apart again.
 *
 * Pure and shape-narrow so it is testable without a DOM — the renderer has no
 * jsdom environment, which is why the original closure inside `Composer.tsx`
 * had no coverage at all.
 */

export interface TrustedSessionElevationInput {
  /** Non-empty when lane mutation is refused (e.g. a popped-out chat). */
  disabledReason?: string | null
  /** The chat the sheet was opened for; without it nothing can be elevated. */
  chatId?: string | null
  /** The approval that opened the sheet, when it was opened from a prompt. */
  approvalId?: string | null
  /**
   * The participant that approval belongs to. Only meaningful when the pending
   * approval still matches `approvalId` — the caller resolves that, because a
   * stale approval must not elevate a seat the user is no longer looking at.
   */
  approvalParticipantId?: string | null
  isEnsembleChat: boolean
  /** Roster participant ids, used to reject an id that no longer exists. */
  participantIds?: readonly string[]
  /** The composer's currently selected participant, if any. */
  selectedParticipantId?: string | null
}

/**
 * The seat that receives `full_access`.
 *
 * `via` is not decoration: the two participant routes write through different
 * helpers in the composer. A seat named by an approval is patched by id
 * (`patchEnsembleParticipantById`), while the composer's own selection is
 * written through `updateSelectedParticipant`, which rebinds the picker to that
 * chip. Collapsing them would silently change which write path runs.
 */
export type TrustedSessionElevationTarget =
  | { scope: 'participant'; participantId: string; via: 'approval' | 'selection' }
  | { scope: 'solo' }

export type TrustedSessionElevationPlan =
  | { kind: 'blocked'; reason: string }
  | { kind: 'no-target' }
  | {
      kind: 'elevate'
      target: TrustedSessionElevationTarget
      /** Passed to `trustedSessionSet`; null for the solo lane. */
      grantParticipantId: string | null
      /**
       * The approval to accept once elevation lands. Null when the sheet was
       * opened from the picker rather than from a prompt.
       */
      acceptApprovalId: string | null
    }

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Decide what a confirmed "Start Full Access" should change.
 *
 * The approval's OWN participant wins over the composer's selection. Accepting
 * a prompt raised by seat B while seat A happens to be selected must elevate B
 * — elevating A would both fail to silence B's prompts and quietly raise the
 * authority of a seat the user never agreed to raise.
 */
export function planTrustedSessionElevation(
  input: TrustedSessionElevationInput
): TrustedSessionElevationPlan {
  const blocked = trimmed(input.disabledReason)
  if (blocked) return { kind: 'blocked', reason: blocked }
  if (!trimmed(input.chatId)) return { kind: 'no-target' }

  const acceptApprovalId = trimmed(input.approvalId) || null
  const known = new Set((input.participantIds || []).map(trimmed).filter(Boolean))

  // An approval's participant is only usable if it is still on the roster; a
  // seat removed mid-prompt falls through to the selection rather than
  // elevating an id that no longer resolves.
  const fromApproval = trimmed(input.approvalParticipantId)
  const approvalTarget = fromApproval && known.has(fromApproval) ? fromApproval : ''

  const fromSelection = input.isEnsembleChat ? trimmed(input.selectedParticipantId) : ''
  const selectionTarget = fromSelection && known.has(fromSelection) ? fromSelection : ''

  if (approvalTarget) {
    return {
      kind: 'elevate',
      target: { scope: 'participant', participantId: approvalTarget, via: 'approval' },
      grantParticipantId: approvalTarget,
      acceptApprovalId
    }
  }
  if (selectionTarget) {
    return {
      kind: 'elevate',
      target: { scope: 'participant', participantId: selectionTarget, via: 'selection' },
      grantParticipantId: selectionTarget,
      acceptApprovalId
    }
  }

  return {
    kind: 'elevate',
    target: { scope: 'solo' },
    grantParticipantId: null,
    acceptApprovalId
  }
}

/** True when this plan grants elevated authority to some seat. */
export function planElevatesASeat(plan: TrustedSessionElevationPlan): boolean {
  return plan.kind === 'elevate'
}

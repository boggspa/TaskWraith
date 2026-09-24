/**
 * Claims over a chat's MODE while the renderer's `setChatKind` call is still
 * outstanding.
 *
 * Reported 2026-09-11 as "not allowing me to enable Ensemble": the toggle is
 * clicked, the thread stays solo, and nothing says why. Two independent faults
 * produced that, and this module answers the second.
 *
 * `set-chat-kind` is main-authoritative, so unlike a roster edit there is no
 * optimistic record to defend — the renderer applies main's own answer. What it
 * cannot defend against is a delivery main BUILT before the switch and flushed
 * after it. `preserveNewerLocalChatKind` existed for exactly that and could only
 * compare wall clocks, which is the wrong question here for the same reason the
 * roster helper already learned: main re-stamps `chat.updatedAt` on every
 * unrelated write, so any of them landing inside the switch's window out-stamps
 * it while still carrying the PREVIOUS mode.
 *
 * Losing that comparison is worse for the mode than for the roster, because the
 * mode helper runs FIRST in `mergeChatUpdatedForRender`. When it stands down,
 * the delivered record's missing `ensemble` block survives into the merge, and
 * the roster helper then returns immediately on its own `!deliveredEnsemble`
 * guard — so the roster claim cannot rescue a reverted Ensemble-on either.
 *
 * WHY ITS OWN REGISTER rather than sharing the roster one: these settle
 * independently. A roster save answering would otherwise release the mode's
 * protection while `setChatKind` is still in flight, which is the revert this
 * fixes. Token/TTL mechanics are inherited deliberately; see
 * `composerSelectionWriteClaims.ts` for why a claim is a token and why the
 * lease is bounded.
 */
import { ComposerSelectionWriteClaims } from './composerSelectionWriteClaims'

export { COMPOSER_SELECTION_CLAIM_TTL_MS as ENSEMBLE_CHAT_KIND_CLAIM_TTL_MS } from './composerSelectionWriteClaims'

export class EnsembleChatKindWriteClaims extends ComposerSelectionWriteClaims {}

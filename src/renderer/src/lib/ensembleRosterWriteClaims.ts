/**
 * Claims over a chat's Ensemble roster and panel configuration while the
 * renderer's optimistic commit is still outstanding.
 *
 * Same lane, same failure, same remedy as `composerSelectionWriteClaims.ts` —
 * reported 2026-09-11 as "I click remove, the seat disappears and immediately
 * reappears", and in the same session as "it just denied me ADDING a
 * participant too" and "it resets the Turns/Hops/Handoffs".
 *
 * The chip strip commits a roster edit optimistically: `buildPersistedChat`
 * stamps `ensemble.updatedAt`, the record goes straight into the live chat map,
 * and `saveChat` follows asynchronously. `preserveNewerLocalEnsembleRoster`
 * exists to stop a delivery built inside that window from reverting the edit,
 * but it could only compare wall clocks — and the wall clock answers the wrong
 * question. `saveChat` stamps `updatedAt = Date.now()` on every unrelated
 * write, so any of them landing inside the window out-stamps the edit while
 * still carrying the PREVIOUS roster. The guard stood down, the stale delivery
 * won, and the seat came back.
 *
 * A claim states the difference the stamp cannot: while one is held, main has
 * not been told about this edit yet, so a delivery's disagreement is ignorance
 * rather than intent and the live roster wins outright.
 *
 * WHY ITS OWN REGISTER, rather than sharing the composer-selection one: these
 * are two different writes with two different answers. A selection patch and a
 * roster save are in flight independently, and a shared register would let the
 * selection patch's answer settle the roster's protection (or the reverse) —
 * releasing a claim whose write has not landed is exactly the revert this
 * fixes. The token/TTL mechanics are identical and deliberately inherited
 * rather than restated; see that module for why a claim is a token and why the
 * lease is bounded.
 */
import { ComposerSelectionWriteClaims } from './composerSelectionWriteClaims'

export { COMPOSER_SELECTION_CLAIM_TTL_MS as ENSEMBLE_ROSTER_CLAIM_TTL_MS } from './composerSelectionWriteClaims'

export class EnsembleRosterWriteClaims extends ComposerSelectionWriteClaims {}

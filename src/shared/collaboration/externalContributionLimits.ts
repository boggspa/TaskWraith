/**
 * Limits on external-contribution text that BOTH processes need to agree on.
 *
 * These live in `shared` rather than beside the queue store for a structural
 * reason, not a stylistic one: the renderer enforces them at the input and main
 * enforces them at the store, and a renderer importing a main-process module to
 * learn a number is the exact cross-process edge `guard:architecture` forbids.
 * Two copies of the number would be worse — the input would silently disagree
 * with the truncation.
 */

/**
 * Host-authored decline note, bounded because it is the one string that travels
 * OUTWARD to an external. The store truncates at this length; the renderer caps
 * its input at the same number, so a host never types text that is silently cut
 * off on the way out.
 */
export const MAX_HOST_REASON_CHARS = 500

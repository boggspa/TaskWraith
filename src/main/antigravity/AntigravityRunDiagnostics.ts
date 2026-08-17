export const ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON =
  'AntiGravity produced no assistant output because official agy headless mode auto-denied a native tool permission (read_file, write_file, command, or unsandboxed). TaskWraith preserved the signed run posture without bypassing provider permissions; configure the matching agy allow rule or provide the needed context in the prompt.'

/**
 * Why TaskWraith installed no agy permission lease for a run, keyed by appRunId.
 *
 * The message above tells the operator to configure an agy allow rule, which is
 * the right advice ONLY when the lease was installed and agy still refused.
 * When TaskWraith skipped the lease, `read_file` was never granted in the first
 * place — the cause is on our side, and pointing at agy's config sends the
 * operator to the wrong file. This records the real cause so the message can
 * say it.
 *
 * Diagnostic only. Nothing here authorizes anything or changes a lease.
 */
const antigravityLeaseSkipCauses = new Map<string, string>()

/** Record why the lease was skipped. Call at the point of the skip. */
export function noteAntigravityLeaseSkipped(appRunId: string, cause: string): void {
  const id = appRunId.trim()
  if (!id || !cause.trim()) return
  antigravityLeaseSkipCauses.set(id, cause.trim())
}

/** Drop a recorded cause once its run is finished, so the map cannot grow without bound. */
export function clearAntigravityLeaseSkip(appRunId: string): void {
  antigravityLeaseSkipCauses.delete(appRunId.trim())
}

/**
 * The headless auto-deny message, naming the real cause when we know it.
 *
 * Falls back to the plain message when the lease WAS installed and agy refused
 * anyway — in that case the agy-allow-rule advice is genuinely correct.
 */
export function antigravityHeadlessPermissionReason(appRunId?: string): string {
  const cause = appRunId ? antigravityLeaseSkipCauses.get(appRunId.trim()) : undefined
  if (!cause) return ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON
  return `AntiGravity produced no assistant output because official agy headless mode auto-denied a native tool permission (read_file, write_file, command, or unsandboxed). TaskWraith installed NO permission lease for this run (${cause}), so the native tools were never granted — this is a TaskWraith-side cause, not an agy allow-rule gap. Check that limb before editing agy's settings.`
}

/**
 * Official agy reports this condition on stderr after a native permission
 * prompt cannot be answered in print/headless mode. Keep the matcher narrow so
 * an unrelated empty result does not become a provider failure.
 */
export function isAntigravityHeadlessPermissionNoOutput(text: unknown): boolean {
  if (typeof text !== 'string') return false
  return (
    /no output produced/i.test(text) &&
    /(?:read_file|write_file|command|unsandboxed)/i.test(text) &&
    /permission/i.test(text) &&
    /headless mode/i.test(text) &&
    /auto-denied/i.test(text)
  )
}

export const ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON =
  'AntiGravity produced no assistant output because official agy headless mode auto-denied a native tool permission (read_file, write_file, command, or unsandboxed). TaskWraith preserved the signed run posture without bypassing provider permissions; configure the matching agy allow rule or provide the needed context in the prompt.'

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

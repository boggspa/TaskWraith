export const ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON =
  'AntiGravity produced no assistant output because official agy headless mode auto-denied a native read permission (read_file). Allow that native read in agy settings or provide the needed context in the prompt; TaskWraith did not bypass provider permissions.'

/**
 * Official agy reports this condition on stderr after a native permission
 * prompt cannot be answered in print/headless mode. Keep the matcher narrow so
 * an unrelated empty result does not become a provider failure.
 */
export function isAntigravityHeadlessPermissionNoOutput(text: unknown): boolean {
  if (typeof text !== 'string') return false
  return (
    /no output produced/i.test(text) &&
    /read_file/i.test(text) &&
    /permission/i.test(text) &&
    /headless mode/i.test(text) &&
    /auto-denied/i.test(text)
  )
}

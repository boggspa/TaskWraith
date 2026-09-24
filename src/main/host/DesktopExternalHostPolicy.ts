/**
 * Desktop talks to the standalone Node Host by default.
 * Opt out with TASKWRAITH_DESKTOP_EXTERNAL_HOST=0 to keep the in-process Host.
 */
export function isDesktopExternalHostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TASKWRAITH_DESKTOP_EXTERNAL_HOST !== '0'
}

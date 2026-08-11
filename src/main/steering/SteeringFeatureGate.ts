/**
 * Live steering is production-on. An explicit false value is retained as an
 * emergency kill switch; unset and recognized true values enable it.
 */
export function midTurnSteerEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env.TASKWRAITH_MID_TURN_STEER?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

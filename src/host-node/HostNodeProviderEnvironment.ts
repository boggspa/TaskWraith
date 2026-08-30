/**
 * Provider-child environment projection.
 *
 * Full Access bootstrap/proof/Host-auth material is never intentionally stored
 * in env, but this deny wall prevents a future composition seam or caller
 * injection from turning it into provider-readable authority. Ordinary provider
 * credentials and TaskWraith run/lock identity remain unchanged.
 */
const HOST_AUTHORITY_ENV =
  /^TASKWRAITH_(?:FULL_ACCESS(?:_|$)|PERMISSION_CONSENT(?:_|$)|HOST_(?:AUTH_)?TOKEN$|HOST_SESSION_TOKEN$|LOCAL_TRANSPORT_TOKEN$)/i

export function hostNodeProviderEnvironment(
  base: NodeJS.ProcessEnv,
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (!HOST_AUTHORITY_ENV.test(key)) projected[key] = value
  }
  for (const [key, value] of Object.entries(additions)) {
    if (!HOST_AUTHORITY_ENV.test(key)) projected[key] = value
  }
  return projected
}

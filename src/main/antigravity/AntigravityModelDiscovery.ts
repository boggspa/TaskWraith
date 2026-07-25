// Authenticated model discovery for the user-installed official `agy` CLI.
//
// This stays separate from runtime launches: it performs the documented
// `agy models` command only after recorded opt-in, forwards only the S2
// credential-sanitized environment, and never reads OAuth/keyring material.

import { spawn } from 'child_process'
import type { AppSettings } from '../store/types'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  probeAgyModels,
  resolveAgyCliBinary,
  type AgyModel,
  type AgyModelProbeDependencies,
  type AgyProcessCaptureResult
} from './AntigravityCli'
import { antigravityAgyStaticModels } from './AntigravityAgyStaticModels'

const MAX_CAPTURED_OUTPUT = 80_000

export interface AuthenticatedAgyModelDiscoveryDependencies {
  resolveBinary?: AgyModelProbeDependencies['resolveBinary']
  capture?: AgyModelProbeDependencies['capture']
  inheritedEnv?: AgyModelProbeDependencies['env']
  timeoutMs?: number
}

/**
 * Captures only a resolved official `agy` process with the environment already
 * constructed by `probeAgyModels`. Do not replace this with the generic CLI
 * capture helper: that helper creates its own provider environment and would
 * defeat the AntiGravity credential-selector stripping boundary.
 */
export function captureAgyModelDiscoveryOutput(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number }
): Promise<AgyProcessCaptureResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command, [...args], { env: options.env, shell: false })
    const finish = (result: AgyProcessCaptureResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish({ stdout, stderr, code: null, timedOut: true, error: 'agy models timed out.' })
    }, options.timeoutMs)
    timeout.unref?.()
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_CAPTURED_OUTPUT) stdout = stdout.slice(-MAX_CAPTURED_OUTPUT)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_CAPTURED_OUTPUT) stderr = stderr.slice(-MAX_CAPTURED_OUTPUT)
    })
    child.on('error', (error) =>
      finish({ stdout, stderr, code: null, timedOut: false, error: error.message })
    )
    child.on('close', (code) => finish({ stdout, stderr, code, timedOut: false }))
  })
}

/**
 * The configured-provider cache may expose AntiGravity only after explicit risk
 * consent AND a resolved user-installed binary. Those two are hard gates: with
 * either missing this returns nothing, so the ban-risk lane stays invisible.
 *
 * Beyond that pair, a live authenticated `agy models` is preferred but no longer
 * REQUIRED. It used to be, and the consequence was that any probe failure — not
 * logged in, non-zero exit, timeout, or a parse yielding nothing — returned `[]`
 * with the error swallowed, which tripped the `models.length > 0` admission in
 * `isAuthenticatedAntigravityConfiguredProvider` and made the whole provider
 * vanish from every surface with no message anywhere. A consented install with
 * the official binary present now falls back to `antigravityAgyStaticModels()`
 * so the lane stays selectable and fails loudly at dispatch instead.
 *
 * Live discovery always wins when it returns anything.
 */
export async function discoverAuthenticatedAgyModels(
  settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'> | null | undefined,
  deps: AuthenticatedAgyModelDiscoveryDependencies = {}
): Promise<AgyModel[]> {
  if (!isAntigravityOptInEnabled(settings)) return []

  // Resolved once and reused, so the probe cannot observe a different binary
  // than the presence gate did.
  let resolvedBinary: Awaited<ReturnType<typeof resolveAgyCliBinary>>
  try {
    resolvedBinary = await (deps.resolveBinary ?? resolveAgyCliBinary)()
  } catch {
    return []
  }
  if (!resolvedBinary.binaryPath) return []

  try {
    const result = await probeAgyModels({
      resolveBinary: async () => resolvedBinary,
      capture: deps.capture ?? captureAgyModelDiscoveryOutput,
      env: deps.inheritedEnv,
      timeoutMs: deps.timeoutMs
    })
    if (!result.error && result.models.length > 0) return result.models
  } catch {
    // Fall through to the static floor rather than hiding the provider.
  }
  return antigravityAgyStaticModels()
}

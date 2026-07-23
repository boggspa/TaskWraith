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
 * The configured-provider cache may expose AntiGravity only after all four
 * conditions hold: explicit risk consent, a resolved user-installed binary,
 * successful official `agy models` exit, and at least one validated model.
 */
export async function discoverAuthenticatedAgyModels(
  settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'> | null | undefined,
  deps: AuthenticatedAgyModelDiscoveryDependencies = {}
): Promise<AgyModel[]> {
  if (!isAntigravityOptInEnabled(settings)) return []
  try {
    const result = await probeAgyModels({
      resolveBinary: deps.resolveBinary ?? resolveAgyCliBinary,
      capture: deps.capture ?? captureAgyModelDiscoveryOutput,
      env: deps.inheritedEnv,
      timeoutMs: deps.timeoutMs
    })
    return !result.error && result.binary.binaryPath && result.models.length > 0 ? result.models : []
  } catch {
    return []
  }
}

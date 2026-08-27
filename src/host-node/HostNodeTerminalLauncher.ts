/**
 * Node-safe terminal launcher for provider user-owned login flows.
 *
 * Generalized from the Muse-exact launcher to catalogued exact login argv per
 * provider. Adapted from src/main/providers/ProviderManualSetupFlowCatalog.ts
 * (flow rows at 48-66) and src/main/providers/ProviderTerminalSetupController.ts
 * (begin/cancel at 62-80). Desktop reuse is a named follow-up.
 *
 * This module opens a user-visible terminal for a provider's interactive login.
 * It waits until that child process closes so callers can probe credentials
 * afterwards. Spawn, close, and a zero exit code never mean authenticated —
 * Host adapters must call getAuthStatus / credential probes for that evidence.
 * Pi is intentionally absent: it is env-key-only and has no terminal login.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { isAbsolute, parse, resolve } from 'node:path'

import type { HostNodeMuseTerminalLauncher } from './HostNodeMuseAuthHandoff'

export interface HostNodeTerminalLauncherOptions {
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess
}

/**
 * Process-close receipt for a manual login. There is no authenticated field on
 * purpose: a closed login binary is not credential evidence.
 */
export interface HostNodeTerminalLoginHandoff {
  readonly providerId: string
  readonly closed: true
  readonly exitCode: number | null
}

/**
 * Provider-facing login port. Tests may resolve void; the real launcher returns
 * a closed handoff that must never be read as authentication.
 */
export interface HostNodeProviderTerminalLauncher {
  launchForProvider(
    providerId: string,
    input: { readonly argv: readonly string[] }
  ): void | Promise<void | HostNodeTerminalLoginHandoff>
}

/** Exact login argv suffix per provider with a catalogued manual flow. */
const LOGIN_ARGV: Readonly<Record<string, readonly string[]>> = {
  codex: ['login'],
  claude: ['auth', 'login'],
  kimi: ['login'],
  cursor: ['login'],
  ollama: ['login'],
  mistral: ['login'],
  muse: ['login'],
  grok: ['login']
}

function canonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    isAbsolute(value) &&
    resolve(value) === value &&
    value !== parse(value).root &&
    // eslint-disable-next-line no-control-regex -- process paths must never carry terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function validateLoginArgv(providerId: string, argv: unknown): readonly string[] {
  if (!Array.isArray(argv)) throw new Error('Terminal launcher requires an exact login command.')
  const suffix = LOGIN_ARGV[providerId]
  if (!suffix) throw new Error(`Provider ${providerId} has no catalogued login flow.`)
  if (argv.length !== 1 + suffix.length || !canonicalAbsolutePath(argv[0])) {
    throw new Error('Terminal launcher requires an exact login command.')
  }
  for (let i = 0; i < suffix.length; i += 1) {
    if (argv[i + 1] !== suffix[i])
      throw new Error('Terminal launcher requires an exact login command.')
  }
  return [argv[0], ...suffix]
}

/**
 * Open an interactive provider login in the Host process's existing terminal.
 * Resolves only after the child closes. That close is not authentication.
 */
export class HostNodeTerminalLauncher implements HostNodeMuseTerminalLauncher {
  private readonly pendingBinaries = new Set<string>()

  constructor(private readonly options: HostNodeTerminalLauncherOptions = {}) {
    if (options.spawn !== undefined && typeof options.spawn !== 'function') {
      throw new Error('Terminal launcher spawn port is invalid.')
    }
  }

  async launch(input: { readonly argv: readonly [string, 'login'] }): Promise<void> {
    // Backward-compatible Muse path: exact [binary, 'login'].
    await this.launchForProvider('muse', input)
  }

  /** Catalogued login launch for any provider with a manual login flow. */
  async launchForProvider(
    providerId: string,
    input: { readonly argv: readonly string[] }
  ): Promise<HostNodeTerminalLoginHandoff> {
    const argv = validateLoginArgv(providerId, input.argv)
    const binary = argv[0]
    if (this.pendingBinaries.has(binary)) {
      throw new Error(`${providerId} login terminal handoff is already pending.`)
    }
    this.pendingBinaries.add(binary)

    let child: ChildProcess
    try {
      child = (this.options.spawn ?? nodeSpawn)(binary, argv.slice(1), {
        shell: false,
        stdio: 'inherit'
      })
    } catch {
      this.pendingBinaries.delete(binary)
      throw new Error(`${providerId} login terminal handoff could not start.`)
    }
    if (!child || typeof child.once !== 'function') {
      this.pendingBinaries.delete(binary)
      throw new Error(`${providerId} login terminal handoff could not start.`)
    }

    const exitCode = await new Promise<number | null>((resolveHandoff, rejectHandoff) => {
      let spawned = false
      let settled = false
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        this.pendingBinaries.delete(binary)
        rejectHandoff(new Error(message))
      }
      child.once('spawn', () => {
        spawned = true
      })
      child.once('error', () => {
        if (!spawned) fail(`${providerId} login terminal handoff failed.`)
      })
      child.once('close', (code) => {
        if (settled) return
        if (!spawned) {
          fail(`${providerId} login terminal handoff failed.`)
          return
        }
        settled = true
        this.pendingBinaries.delete(binary)
        resolveHandoff(typeof code === 'number' ? code : null)
      })
    })

    return { providerId, closed: true, exitCode }
  }
}

export function createHostNodeTerminalLauncher(
  options: HostNodeTerminalLauncherOptions = {}
): HostNodeTerminalLauncher {
  return new HostNodeTerminalLauncher(options)
}

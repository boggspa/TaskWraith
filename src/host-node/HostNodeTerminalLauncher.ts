/**
 * Node-safe terminal launcher for provider user-owned login flows.
 *
 * Generalized from the Muse-exact launcher to catalogued exact login argv per
 * provider. Adapted from src/main/providers/ProviderManualSetupFlowCatalog.ts
 * (flow rows at 48-66) and src/main/providers/ProviderTerminalSetupController.ts
 * (begin/cancel at 62-80). Desktop reuse is a named follow-up.
 *
 * This module opens a user-visible terminal for a provider's interactive login.
 * It proves only that the child was handed off to the terminal; it never waits
 * for, observes, or claims the user's authentication result.
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

/** Exact login argv suffix per provider. */
const LOGIN_ARGV: Readonly<Record<string, readonly string[]>> = {
  codex: ['login'],
  claude: ['auth', 'login'],
  kimi: ['login'],
  cursor: ['login'],
  ollama: ['login'],
  mistral: ['login'],
  muse: ['login']
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
 * This proves only that the child was handed off to the terminal; it never
 * waits for, observes, or claims the user's authentication result.
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
    return this.launchForProvider('muse', input)
  }

  /** Catalogued login launch for any provider with a manual login flow. */
  async launchForProvider(
    providerId: string,
    input: { readonly argv: readonly string[] }
  ): Promise<void> {
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

    await new Promise<void>((resolveHandoff, rejectHandoff) => {
      let settled = false
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        this.pendingBinaries.delete(binary)
        callback()
      }
      child.once('spawn', () => settle(resolveHandoff))
      // Retain this one-shot listener after a successful handoff so an
      // implementation-level error cannot become an unhandled EventEmitter
      // error. It no longer changes the already-resolved handoff result.
      child.once('error', () =>
        settle(() => rejectHandoff(new Error(`${providerId} login terminal handoff failed.`)))
      )
    })
  }
}

export function createHostNodeTerminalLauncher(
  options: HostNodeTerminalLauncherOptions = {}
): HostNodeTerminalLauncher {
  return new HostNodeTerminalLauncher(options)
}

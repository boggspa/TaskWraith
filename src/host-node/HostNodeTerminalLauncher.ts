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
 * Open an interactive Muse login in the Host process's existing terminal.
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
    const [binary, command] = validateLoginArgv(input)
    if (this.pendingBinaries.has(binary)) {
      throw new Error('Muse login terminal handoff is already pending.')
    }
    this.pendingBinaries.add(binary)

    let child: ChildProcess
    try {
      child = (this.options.spawn ?? nodeSpawn)(binary, [command], {
        shell: false,
        stdio: 'inherit'
      })
    } catch {
      this.pendingBinaries.delete(binary)
      throw new Error('Muse login terminal handoff could not start.')
    }
    if (!child || typeof child.once !== 'function') {
      this.pendingBinaries.delete(binary)
      throw new Error('Muse login terminal handoff could not start.')
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
        settle(() => rejectHandoff(new Error('Muse login terminal handoff failed.')))
      )
    })
  }
}

export function createHostNodeTerminalLauncher(
  options: HostNodeTerminalLauncherOptions = {}
): HostNodeMuseTerminalLauncher {
  return new HostNodeTerminalLauncher(options)
}

function validateLoginArgv(input: unknown): readonly [string, 'login'] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { argv?: unknown }).argv)) {
    throw new Error('Muse terminal launcher requires an exact login command.')
  }
  const argv = (input as { argv: unknown[] }).argv
  if (argv.length !== 2 || argv[1] !== 'login' || !canonicalAbsolutePath(argv[0])) {
    throw new Error('Muse terminal launcher requires an exact login command.')
  }
  return [argv[0], 'login']
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

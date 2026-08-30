import { isAbsolute, parse, resolve } from 'node:path'

import {
  HOST_AGY_MODEL_DISCOVERY_ARGS,
  type HostStandaloneAgyCaptureResult
} from '../host-shared/antigravity/HostStandaloneAntigravityAdmission'

const MAX_CAPTURE_BYTES = 256 * 1024
const MAX_TIMEOUT_MS = 30_000
// eslint-disable-next-line no-control-regex -- executable paths reject C0 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export interface HostNodeAgyPtyLike {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  kill(): void
}

export interface HostNodeAgyPtyCaptureDependencies {
  readonly spawnPty?: (
    command: string,
    args: readonly string[],
    options: { readonly env: Record<string, string> }
  ) => HostNodeAgyPtyLike
  readonly loadPty?: () => Promise<{
    spawn(
      command: string,
      args: string[],
      options: {
        readonly name: string
        readonly cols: number
        readonly rows: number
        readonly env: Record<string, string>
      }
    ): {
      onData(listener: (data: string) => void): void
      onExit(listener: (event: { exitCode: number }) => void): void
      kill(): void
    }
  }>
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
}

function canonicalBinary(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    value.trim() === value &&
    isAbsolute(value) &&
    resolve(value) === value &&
    value !== parse(value).root &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function exactDiscoveryArgs(value: readonly string[]): boolean {
  return (
    value.length === HOST_AGY_MODEL_DISCOVERY_ARGS.length &&
    value.every((entry, index) => entry === HOST_AGY_MODEL_DISCOVERY_ARGS[index])
  )
}

/**
 * Bounded PTY capture for the one allowed standalone AntiGravity probe. agy
 * does not reliably emit `models` through ordinary pipes, hence this exact
 * PTY seam rather than a shell or generic command runner.
 */
export function captureHostStandaloneAgyModels(
  command: string,
  args: readonly string[],
  options: { readonly env: Record<string, string>; readonly timeoutMs: number },
  dependencies: HostNodeAgyPtyCaptureDependencies = {}
): Promise<HostStandaloneAgyCaptureResult> {
  if (
    !canonicalBinary(command) ||
    !exactDiscoveryArgs(args) ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_TIMEOUT_MS
  ) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: null,
      error: 'Invalid bounded agy model-probe request.'
    })
  }
  if (dependencies.spawnPty) {
    return captureWithSpawn(command, args, options, dependencies, dependencies.spawnPty)
  }
  const loadPty = dependencies.loadPty ?? (() => import('node-pty'))
  return loadPty()
    .then((pty) =>
      captureWithSpawn(command, args, options, dependencies, (binary, binaryArgs, spawnOptions) => {
        const child = pty.spawn(binary, [...binaryArgs], {
          name: 'xterm-256color',
          cols: 160,
          rows: 30,
          env: spawnOptions.env
        })
        return {
          onData: (listener) => child.onData(listener),
          onExit: (listener) => child.onExit((event) => listener({ exitCode: event.exitCode })),
          kill: () => child.kill()
        }
      })
    )
    .catch(() => ({
      stdout: '',
      stderr: '',
      code: null,
      error: 'agy models could not start.'
    }))
}

function captureWithSpawn(
  command: string,
  args: readonly string[],
  options: { readonly env: Record<string, string>; readonly timeoutMs: number },
  dependencies: HostNodeAgyPtyCaptureDependencies,
  spawnPty: NonNullable<HostNodeAgyPtyCaptureDependencies['spawnPty']>
): Promise<HostStandaloneAgyCaptureResult> {
  return new Promise((resolveCapture) => {
    let output = ''
    let bytes = 0
    let settled = false
    let terminal: HostNodeAgyPtyLike | null = null
    let timer: unknown = null
    const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    const clearTimer =
      dependencies.clearTimer ?? ((value) => clearTimeout(value as ReturnType<typeof setTimeout>))
    const finish = (result: HostStandaloneAgyCaptureResult): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimer(timer)
      try {
        terminal?.kill()
      } catch {
        // The PTY has already exited.
      }
      resolveCapture(result)
    }
    try {
      terminal = spawnPty(command, args, { env: options.env })
    } catch {
      finish({
        stdout: '',
        stderr: '',
        code: null,
        error: 'agy models could not start.'
      })
      return
    }
    terminal.onData((chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_CAPTURE_BYTES) {
        finish({
          stdout: '',
          stderr: '',
          code: null,
          error: 'agy models output exceeded the bounded capture limit.'
        })
        return
      }
      output += chunk
    })
    terminal.onExit((event) => {
      finish({ stdout: output, stderr: '', code: event.exitCode })
    })
    timer = setTimer(
      () =>
        finish({
          stdout: '',
          stderr: '',
          code: null,
          timedOut: true,
          error: 'agy models timed out.'
        }),
      options.timeoutMs
    )
  })
}

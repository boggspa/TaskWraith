#!/usr/bin/env node

import { parseHostDiagnosticCli, HostDiagnosticCliError } from './HostDiagnosticCli'
import { HostDiagnosticServer } from './HostDiagnosticServer'
import { createHostNodeProductionFactory } from '../host-node/HostNodeProductionFactory'
import { createHostNodeTerminalLauncher } from '../host-node/HostNodeTerminalLauncher'
import { createHostNodeTerminalWindowLauncher } from '../host-node/HostNodeTerminalWindowLauncher'
import type { HostNodeMuseTerminalLauncher } from '../host-node/HostNodeMuseAuthHandoff'
import { parseHostProductionCli, HostProductionCliError } from './HostProductionCli'
import { HostShutdownClient } from '../host-client/HostShutdownClient'
import {
  formatHostStopAllReport,
  stopAllHosts,
  type HostStopAllOptions,
  type HostStopAllReport
} from '../host-client/HostStopAll'
import { resolve } from 'node:path'
import { resolveHostPayloadVersion } from './HostPayloadIdentity'
import {
  canonicalHostProfilePath,
  createHostRegistryPublisherFromEnvironment
} from './HostRegistry'
import type { HostRegistryPublisherPort } from './HostRegistryPort'
import {
  HOST_FULL_ACCESS_BOOTSTRAP_FD,
  HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV,
  readHostFullAccessBootstrapSecret
} from './HostFullAccessBootstrap'
import { installHostStdioGuard, writeHostStderr } from './HostStdioGuard'

export interface HostProductionCliStdio {
  readonly stdin?: { readonly isTTY?: boolean }
  readonly stdout?: { readonly isTTY?: boolean }
  readonly stderr?: { readonly isTTY?: boolean }
}

export interface HostProductionCliRuntime {
  readonly stdio?: HostProductionCliStdio
  readonly createTerminalLauncher?: () => HostNodeMuseTerminalLauncher
  readonly createTerminalWindowLauncher?: () => HostNodeMuseTerminalLauncher | undefined
  readonly readFullAccessBootstrapSecret?: () => Buffer | null | Promise<Buffer | null>
  readonly resolvePayloadVersion?: () => string
  readonly env?: NodeJS.ProcessEnv
  /** Defaults to the machine-wide registry named by the environment. */
  readonly createRegistryPublisher?: (
    input: HostRegistryPublisherInput
  ) => HostRegistryPublisherPort
}

export interface HostRegistryPublisherInput {
  readonly profilePath: string
  readonly env: NodeJS.ProcessEnv
  /** This CLI's own path, so `stop-all --payload-root` can select the Host. */
  readonly cliPath: string
  readonly nodeExecutable: string
  readonly log: (line: string) => void
}

/**
 * How long an ending Host waits for its last stderr lines to reach the reader.
 * It is all that ends a Host whose reader is alive but has stopped reading.
 */
export const HOST_END_PROCESS_FLUSH_MS = 1_000

/**
 * Ends this Host's process after a stop nobody retries (one it decided on, or
 * one requested over its listener) has failed or run out of time. Whatever it
 * left live (a history worker, a provider's pipes) would otherwise keep the
 * process, and with it the profile authority, up for good. It waits for the
 * current turn, so the failure has settled everywhere, then for stderr to
 * flush, but never longer than HOST_END_PROCESS_FLUSH_MS: a reader that
 * stopped reading cannot hold the exit.
 */
export function endHostProcess(code: number): void {
  setImmediate(() => {
    const exit = (): void => {
      process.exit(code)
    }
    const fallback = setTimeout(exit, HOST_END_PROCESS_FLUSH_MS)
    try {
      process.stderr.write('', () => {
        clearTimeout(fallback)
        exit()
      })
    } catch {
      // The fallback still ends the process.
    }
  })
}

export async function runHostDiagnosticCli(
  argv: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const command = parseHostDiagnosticCli(argv)
  const host = new HostDiagnosticServer(command)
  await host.start()
  await host.waitForShutdown()
}

export async function runHostProductionCli(
  argv: readonly string[] = process.argv.slice(2),
  createProduction: typeof createHostNodeProductionFactory = createHostNodeProductionFactory,
  runtime: HostProductionCliRuntime = {}
): Promise<void> {
  // Every entry point that serves a production Host, not only this module's
  // main(): the npm `taskwraith-host` bin calls this directly. Idempotent.
  installHostStdioGuard()
  const command = parseHostProductionCli(argv)
  if (command.command !== 'serve') throw new HostProductionCliError('Expected serve command.')
  const terminalLauncher = providerTerminalLauncher(runtime)
  const environment = runtime.env ?? process.env
  const injectedBootstrapReader = runtime.readFullAccessBootstrapSecret
  const bootstrapAdvertised =
    Boolean(injectedBootstrapReader) ||
    environment[HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV] === String(HOST_FULL_ACCESS_BOOTSTRAP_FD)
  if (environment === process.env) delete process.env[HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV]
  const fullAccessBootstrapSecret = bootstrapAdvertised
    ? await (injectedBootstrapReader ?? readHostFullAccessBootstrapSecret)()
    : null
  let host: ReturnType<typeof createHostNodeProductionFactory>
  try {
    const payloadVersion = (
      runtime.resolvePayloadVersion ?? (() => resolveHostPayloadVersion(resolve(__dirname, '..')))
    )()
    const registry = (
      runtime.createRegistryPublisher ?? createHostRegistryPublisherFromEnvironment
    )({
      profilePath: command.profilePath,
      env: environment,
      cliPath: resolve(__dirname, 'cli.js'),
      nodeExecutable: process.execPath,
      log: (line) => writeHostStderr(`taskwraith-host: ${line}\n`)
    })
    host = createProduction({
      profilePath: command.profilePath,
      payloadVersion,
      registry,
      endProcess: endHostProcess,
      ...(command.museBinary ? { museBinary: command.museBinary } : {}),
      ...(terminalLauncher ? { terminalLauncher } : {}),
      ...(fullAccessBootstrapSecret ? { fullAccessBootstrapSecret } : {})
    })
  } finally {
    fullAccessBootstrapSecret?.fill(0)
  }
  await host.start()
  await host.waitForShutdown()
}

function providerTerminalLauncher(
  runtime: HostProductionCliRuntime
): HostNodeMuseTerminalLauncher | undefined {
  const stdio = runtime.stdio ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  }
  if (stdio.stdin?.isTTY === true && stdio.stdout?.isTTY === true && stdio.stderr?.isTTY === true) {
    return (runtime.createTerminalLauncher ?? createHostNodeTerminalLauncher)()
  }
  return (
    runtime.createTerminalWindowLauncher ??
    (() => createHostNodeTerminalWindowLauncher({ env: runtime.env ?? process.env }))
  )()
}

export async function runHostShutdownCli(
  argv: readonly string[] = process.argv.slice(2),
  createShutdown: (input: { profilePath: string }) => Pick<HostShutdownClient, 'shutdown'> = (
    input
  ) => new HostShutdownClient(input)
): Promise<void> {
  // The npm `taskwraith-host stop` bin calls this directly too, not through
  // main(). Its only writes are its failures, and a gone reader must not turn
  // one into an uncaught EPIPE that replaces the bin's exit code. Idempotent.
  installHostStdioGuard()
  const command = parseHostProductionCli(argv)
  if (command.command !== 'stop') throw new HostProductionCliError('Expected stop command.')
  await createShutdown({ profilePath: command.profilePath }).shutdown()
}

export interface HostRegistryCliRuntime {
  readonly stopAll?: (options: HostStopAllOptions) => Promise<HostStopAllReport>
  readonly write?: (text: string) => void
  readonly log?: (line: string) => void
  readonly env?: NodeJS.ProcessEnv
}

function registryCliIo(runtime: HostRegistryCliRuntime): {
  readonly stopAll: (options: HostStopAllOptions) => Promise<HostStopAllReport>
  readonly write: (text: string) => void
} {
  return {
    stopAll: runtime.stopAll ?? stopAllHosts,
    write: runtime.write ?? ((text) => void process.stdout.write(text))
  }
}

function writeReport(
  report: HostStopAllReport,
  json: boolean,
  write: (text: string) => void
): void {
  write(json ? `${JSON.stringify(report, null, 2)}\n` : formatHostStopAllReport(report))
}

/**
 * `status`: the machine-wide registry (and, with --scan-argv, the Hosts that
 * predate it). It never stops anything.
 */
export async function runHostStatusCli(
  argv: readonly string[] = process.argv.slice(2),
  runtime: HostRegistryCliRuntime = {}
): Promise<number> {
  const command = parseHostProductionCli(argv)
  if (command.command !== 'status') throw new HostProductionCliError('Expected status command.')
  const { stopAll, write } = registryCliIo(runtime)
  const report = await stopAll({
    scope: { kind: 'list' },
    scanArgv: command.scanArgv,
    env: runtime.env ?? process.env
  })
  const profilePath = command.profilePath
  const narrowed: HostStopAllReport = profilePath
    ? {
        ...report,
        hosts: report.hosts.filter(
          (host) =>
            canonicalHostProfilePath(host.profilePath) === canonicalHostProfilePath(profilePath)
        )
      }
    : report
  // A listing is the whole point of status, so it exits 0 where stop-all exits 3.
  writeReport({ ...narrowed, exitCode: 0 }, command.json, write)
  return 0
}

/**
 * `stop-all`: verified termination of every Host the scope selects. No scope
 * lists only and exits 3; a refusal or failure exits 1.
 */
export async function runHostStopAllCli(
  argv: readonly string[] = process.argv.slice(2),
  runtime: HostRegistryCliRuntime = {}
): Promise<number> {
  const command = parseHostProductionCli(argv)
  if (command.command !== 'stop-all') throw new HostProductionCliError('Expected stop-all command.')
  const { stopAll, write } = registryCliIo(runtime)
  const log = runtime.log ?? ((line: string) => void process.stderr.write(`${line}\n`))
  const report = await stopAll({
    scope: command.scope,
    ...(command.expected ? { expected: command.expected } : {}),
    scanArgv: command.scanArgv,
    sweep: command.sweep,
    env: runtime.env ?? process.env,
    log
  })
  writeReport(report, command.json, write)
  return report.exitCode
}

export async function runHostCli(
  argv: readonly string[] = process.argv.slice(2)
): Promise<void | number> {
  if (argv[0] === 'stop') return runHostShutdownCli(argv)
  if (argv[0] === 'status') return runHostStatusCli(argv)
  if (argv[0] === 'stop-all') return runHostStopAllCli(argv)
  const modeIndex = argv.indexOf('--mode')
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined
  if (mode === 'production') return runHostProductionCli(argv)
  return runHostDiagnosticCli(argv)
}

async function main(): Promise<void> {
  // First, before anything can write: a stdio reader that goes away (the app
  // that spawned this Host quit) must never be able to kill the process.
  installHostStdioGuard()
  try {
    const exitCode = await runHostCli()
    if (typeof exitCode === 'number') process.exitCode = exitCode
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeHostStderr(`taskwraith-host: ${message}\n`)
    process.exitCode =
      error instanceof HostDiagnosticCliError || error instanceof HostProductionCliError ? 2 : 1
  }
}

if (require.main === module) {
  void main()
}

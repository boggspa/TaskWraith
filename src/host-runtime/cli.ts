#!/usr/bin/env node

import { parseHostDiagnosticCli, HostDiagnosticCliError } from './HostDiagnosticCli'
import { HostDiagnosticServer } from './HostDiagnosticServer'
import { createHostNodeProductionFactory } from '../host-node/HostNodeProductionFactory'
import { parseHostProductionCli, HostProductionCliError } from './HostProductionCli'
import { HostShutdownClient } from '../host-client/HostShutdownClient'

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
  createProduction: typeof createHostNodeProductionFactory = createHostNodeProductionFactory
): Promise<void> {
  const command = parseHostProductionCli(argv)
  if (command.command !== 'serve') throw new HostProductionCliError('Expected serve command.')
  const host = createProduction({
    profilePath: command.profilePath,
    ...(command.museBinary ? { museBinary: command.museBinary } : {})
  })
  await host.start()
  await host.waitForShutdown()
}

export async function runHostShutdownCli(
  argv: readonly string[] = process.argv.slice(2),
  createShutdown: (input: { profilePath: string }) => Pick<HostShutdownClient, 'shutdown'> = (
    input
  ) => new HostShutdownClient(input)
): Promise<void> {
  const command = parseHostProductionCli(argv)
  if (command.command !== 'stop') throw new HostProductionCliError('Expected stop command.')
  await createShutdown({ profilePath: command.profilePath }).shutdown()
}

export async function runHostCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === 'stop') return runHostShutdownCli(argv)
  const modeIndex = argv.indexOf('--mode')
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined
  if (mode === 'production') return runHostProductionCli(argv)
  return runHostDiagnosticCli(argv)
}

async function main(): Promise<void> {
  try {
    await runHostCli()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`taskwraith-host: ${message}\n`)
    process.exitCode =
      error instanceof HostDiagnosticCliError || error instanceof HostProductionCliError ? 2 : 1
  }
}

if (require.main === module) {
  void main()
}

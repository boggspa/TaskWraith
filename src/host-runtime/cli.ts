#!/usr/bin/env node

import { parseHostDiagnosticCli, HostDiagnosticCliError } from './HostDiagnosticCli'
import { HostDiagnosticServer } from './HostDiagnosticServer'

export async function runHostDiagnosticCli(
  argv: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const command = parseHostDiagnosticCli(argv)
  const host = new HostDiagnosticServer(command)
  await host.start()
  await host.waitForShutdown()
}

async function main(): Promise<void> {
  try {
    await runHostDiagnosticCli()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`taskwraith-host: ${message}\n`)
    process.exitCode = error instanceof HostDiagnosticCliError ? 2 : 1
  }
}

if (require.main === module) {
  void main()
}

#!/usr/bin/env node
'use strict'

const { runHostProductionCli, runHostShutdownCli } = require('../dist/host/host-runtime/cli.js')

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === 'stop') {
    await runHostShutdownCli(args)
    return
  }
  await runHostProductionCli(['serve', '--mode', 'production', ...args])
}

void main().catch((error) => {
  process.stderr.write(
    `taskwraith-host: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
})

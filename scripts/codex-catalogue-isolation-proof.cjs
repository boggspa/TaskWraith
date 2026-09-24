#!/usr/bin/env node
'use strict'

/**
 * Independent Threads Programme A1.4 / B6: native Codex catalogue evidence.
 *
 * DEFAULT / CI:
 *   node scripts/codex-catalogue-isolation-proof.cjs --plan
 * Prints the complete 64-case matrix plus broker-restart and dual-instance
 * procedures. No child processes, network, credential reads, or output files.
 * Placeholder endpoints and paths are recipes, never fabricated live routes.
 *
 * MANUAL ONLY — the panel and PR CI MUST NOT run --live:
 * 1. Build/start a real isolated TaskWraith app/broker. Create legitimate solo,
 *    plain Ensemble and Mesh routes under the intended signed permission
 *    presets. Keep the app running. This tool cannot mint those grants.
 * 2. Prepare an otherwise-quiescent private CODEX_HOME and separate private
 *    evidence directory (0700, no symlinks). Either authenticate that home
 *    independently, OR explicitly opt in to borrowing an existing login:
 *       --reuse-existing-login --login-source /absolute/login-source
 *    Borrowing uses CodexOAuthCredentialLease.ts unchanged, with its durable
 *    lease/CAS rotation writeback. A borrowed home must end in /codex-home.
 *    Never copy auth.json. Do not run another native client on either home
 *    during the proof. The authority cannot lock unrelated external software.
 *    No inherited API key is forwarded. Existing MCP config is refused so this
 *    diagnostic does not start unrelated user-configured servers.
 * 3. Create a private JSON manifest with:
 *    {
 *      "workspace": "/absolute/proof-workspace",
 *      "bridgeCommand": "/absolute/TaskWraith-executable",
 *      "endpoint": {
 *        "socketPath": "/absolute/live-broker.sock",
 *        "brokerToken": "<real token, never committed>",
 *        "instanceEpoch": "<real 32-64 lowercase hex epoch>",
 *        "bridgeLogEpoch": 1
 *      },
 *      "models": ["<installed model A>", "<installed model B>"],
 *      "runtimes": [
 *        {"id":"default","binary":"/absolute/codex","env":{}},
 *        {"id":"alternate","binary":"/absolute/alternate-codex","env":{}}
 *      ],
 *      "routes": {
 *        "solo": {
 *          "fresh":{"appRunId":"<live>","appChatId":"<live>"},
 *          "resume":{"appRunId":"<live>","appChatId":"<live>"},
 *          "retained":{"appRunId":"<live>","appChatId":"<live>"}
 *        },
 *        "ensemble": { "...same three lifecycle keys...": {} },
 *        "mesh": { "...same three lifecycle keys...": {} }
 *      },
 *      "directCall": {
 *        "name":"<safe read-only tool from this real catalogue>",
 *        "arguments":{}, "readOnly":true
 *      },
 *      "permissionCall": {
 *        "name":"apply_patch",
 *        "arguments":{"patch":"<valid patch in the disposable workspace>","check":true},
 *        "expectedOutcome":"<outcome required by that signed posture>"
 *      }
 *    }
 *    Also provide "routePostures": { "<appRunId>": {
 *      "presetId":"read_only", "evidenceRef":"<real broker ledger reference>",
 *      "expectedPermissionOutcome":"<expected denial or dry-run success>"
 *    } } for every route. These are operator declarations, NOT signature proof.
 *    Uniform cases expect read_only for every seat; mixed cases expect
 *    workspace_write for the Ensemble seat and read_only for solo/Mesh.
 *    Supply "mixedPermissionRoutes" in the same shape as "routes" for those
 *    cases, with corresponding routePostures. Missing/mismatched declarations
 *    record an inconclusive case without spawning.
 *    Use routes whose signed posture/profile agrees with the printed matrix.
 *    Resume/retained request the next profile in solo→Ensemble→Mesh→solo order
 *    deliberately, so retained-child cache behavior is visible.
 * 4. Review --plan --manifest /absolute/manifest.json. Then explicitly run:
 *    node scripts/codex-catalogue-isolation-proof.cjs --live \
 *      --i-have-credentials --code-home /absolute/private/codex-home \
 *      --output-dir /absolute/private-evidence --manifest /absolute/manifest.json \
 *      --case route-env/args-1/runtime-0/models-0/permissions-0/bridge-1
 *    Omit --case to run all cases (many model turns; manual cost decision).
 *    --case broker-restart asks the operator to restart the REAL broker and
 *    replace the manifest before continuing; same native threads are resumed.
 *    --case dual-instance also needs a secondInstance manifest object with a
 *    distinct real broker endpoint and its routes (other manifest fields may
 *    be overridden there), --second-code-home plus the
 *    explicit shared-login consent flags. Simultaneous canonical acquisition
 *    is expected to return busy; B only runs after A's release is confirmed.
 * 5. Independently review summary/evidence JSON and metadata-only events.jsonl.
 *    Correlate signed-permission outcomes with the real broker's approval
 *    ledger. The script does not declare signatures valid from an error string.
 *    Missing native methods, missing traffic, censored state, model refusal and
 *    no retained child are inconclusive, never fabricated passes.
 *
 * P1/P4 observe the real MCP child through a byte-transparent stdio wrapper.
 * P2 deliberately holds a real tool reply during an active native turn, then
 * requests unsubscribe/resume; native failure is itself recorded. P3 scans
 * bounded native-state bytes (including SQLite/WAL), excludes auth/lease files,
 * and records only named match flags. Negative scans cannot prove absence.
 * P5 records tools/list and schema SHA-256s at both available native and wire
 * scopes. Global status is never mislabelled per-thread.
 *
 * The installed CLI's generate-json-schema output binds version-specific
 * tool-call/status fields. When direct tool calls are unavailable, a native
 * model turn requests the same safe operation and actual bridge traffic is
 * required. Native approval requests are refused, never silently granted.
 * Protocol: https://learn.chatgpt.com/docs/app-server
 *
 * Electron-free reuse: transpile/load the explicit Node-only McpBridgeRoute,
 * McpSessionProfileFence and CodexOAuthCredentialLease helper graphs. Do not
 * import CodexAppServerClient.ts (Electron graph). Its pure MCP argv builder
 * is replicated and source-parity-tested, including escaping and ordering.
 * Everything persisted is redacted; raw model/RPC text and stderr are omitted.
 * Private native state itself may contain broker credentials: retain it for
 * manual P3 review and dispose of it through the normal operator workflow.
 */

const fs = require('node:fs')
const { createProofPlan } = require('./codex-proof/plan.cjs')
const { collectSecrets, createRedactor } = require('./codex-proof/common.cjs')

function parseArgs(argv) {
  const options = {
    live: false,
    iHaveCredentials: false,
    reuseExistingLogin: false,
    timeoutMs: 60000
  }
  let explicitMode
  const flags = {
    '--i-have-credentials': 'iHaveCredentials',
    '--reuse-existing-login': 'reuseExistingLogin'
  }
  const values = {
    '--code-home': 'codeHome',
    '--output-dir': 'outputDir',
    '--manifest': 'manifestFile',
    '--login-source': 'loginSource',
    '--second-code-home': 'secondCodeHome',
    '--case': 'caseId',
    '--timeout-ms': 'timeoutMs'
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--plan' || arg === '--live') {
      if (explicitMode && explicitMode !== arg) throw new Error('conflicting_modes')
      explicitMode = arg
      options.live = arg === '--live'
    } else if (flags[arg]) options[flags[arg]] = true
    else if (values[arg]) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('missing_argument_value')
      options[values[arg]] = value
    } else throw new Error('unknown_argument')
  }
  options.timeoutMs = Number(options.timeoutMs)
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 300000)
    throw new Error('timeout_out_of_range')
  return options
}
function readManifest(file) {
  if (!file) return {}
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('manifest_limit')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv)
  const output = dependencies.output || ((value) => process.stdout.write(value))
  if (
    options.live &&
    (!options.iHaveCredentials || !options.codeHome || !options.outputDir || !options.manifestFile)
  ) {
    throw new Error('live_requires_ack_explicit_home_output_and_manifest')
  }
  const manifest = (dependencies.readManifest || readManifest)(options.manifestFile)
  const redact = createRedactor({
    secrets: collectSecrets(manifest),
    paths: [options.codeHome, options.loginSource, options.secondCodeHome, options.outputDir]
  })
  if (!options.live) {
    const plan = createProofPlan({
      ...manifest,
      ...(options.codeHome ? { codeHome: options.codeHome } : {}),
      ...(options.secondCodeHome ? { secondCodeHome: options.secondCodeHome } : {}),
      ...(options.outputDir ? { outputDir: options.outputDir } : {})
    })
    const redactPlan = createRedactor({
      secrets: collectSecrets(plan),
      paths: [options.codeHome, options.outputDir]
    })
    output(JSON.stringify(redactPlan(plan), null, 2) + '\n')
    return plan
  }
  const { runLive } = dependencies.runner || require('./codex-proof/runner.cjs')
  const restartBroker =
    dependencies.restartBroker ||
    (async () => {
      if (!process.stdin.isTTY) throw new Error('broker_restart_requires_interactive_operator')
      const readline = require('node:readline/promises').createInterface({
        input: process.stdin,
        output: process.stdout
      })
      try {
        await readline.question(
          'Restart the real isolated broker, update the manifest with its new endpoint and routes, then press Enter. '
        )
        return readManifest(options.manifestFile)
      } finally {
        readline.close()
      }
    })
  const result = await runLive(options, manifest, { restartBroker })
  output(JSON.stringify(redact(result), null, 2) + '\n')
  return result
}

module.exports = { parseArgs, readManifest, main }
if (require.main === module) {
  main().catch(() => {
    // No raw exception: native/tool errors can echo credentials or paths.
    console.error(
      'Catalogue proof could not complete. Check the documented inputs and any redacted evidence already written.'
    )
    process.exitCode = 1
  })
}

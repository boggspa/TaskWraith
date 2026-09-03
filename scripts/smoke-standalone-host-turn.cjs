#!/usr/bin/env node

/**
 * smoke-standalone-host-turn.cjs — headless end-to-end proof for the standalone
 * production Host: one real provider turn that must land a real file mutation.
 *
 * This is the acceptance smoke for the TUI robustness round: unit suites proved
 * each fix in isolation, but the user's gate is a clean send → run → mutation
 * against a real provider. This script drives exactly that path through the
 * same control client the TUI uses:
 *
 *   compile host-runtime + host-client to a scratch dir
 *   → spawn `host-runtime/cli.js serve --mode production --profile <disposable>`
 *   → HostProjectionClient connect (discovery + token)
 *   → workspace.register a fresh probe directory at its REALPATH
 *     (macOS /var→/private/var symlink: verifyWorkspacePath rejects symlinked
 *     roots — register the resolved path, never the alias)
 *   → thread.create + thread.configure(provider, default posture "Accept Edits")
 *   → ONE composer.send asking for a tiny file write
 *   → await the terminal run, then assert: send receipt succeeded, run reached
 *     a terminal outcome, the transcript holds user + assistant rows, and the
 *     probe file exists on disk.
 *
 * Quota discipline is binding: ONE provider, ONE run, no retry loops spending
 * user credits. The turn deadline defaults to 120s.
 *
 * Skips legibly (exit 0) when the provider binary or an available model is
 * absent — that means "user must run this", not a product failure. Set
 * TASKWRAITH_SMOKE_REQUIRE_LIVE_TURN=1 to fail closed instead.
 *
 * Usage:
 *   node scripts/smoke-standalone-host-turn.cjs
 *
 * Env:
 *   TASKWRAITH_SMOKE_PROVIDER            provider to drive (default: claude)
 *   TASKWRAITH_SMOKE_TURN_TIMEOUT_MS     terminal-run deadline (default: 120000)
 *   TASKWRAITH_SMOKE_COMPILE_TIMEOUT_MS  tsc deadline (default: 240000)
 *   TASKWRAITH_SMOKE_REQUIRE_LIVE_TURN   1 = treat skips as failures
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const repoRoot = process.cwd()
const providerId = process.env.TASKWRAITH_SMOKE_PROVIDER || 'claude'
const turnTimeoutMs = readIntegerEnv('TASKWRAITH_SMOKE_TURN_TIMEOUT_MS', 120000)
const compileTimeoutMs = readIntegerEnv('TASKWRAITH_SMOKE_COMPILE_TIMEOUT_MS', 240000)
const requireLiveTurn = process.env.TASKWRAITH_SMOKE_REQUIRE_LIVE_TURN === '1'

main().catch((error) => {
  const message =
    error instanceof Error
      ? error.name === 'SmokeFailure'
        ? error.message
        : error.stack || error.message
      : String(error)
  console.error(message)
  process.exit(1)
})

async function main() {
  if (!providerBinaryPresent(providerId)) {
    skip(
      `provider binary for "${providerId}" is not on PATH on this machine.\n` +
        `  install/sign in, then run: node scripts/smoke-standalone-host-turn.cjs`
    )
    return
  }

  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-host-turn-smoke-'))
  )
  const profile = path.join(root, 'profile')
  const workspace = path.join(root, 'workspace')
  const outDir = path.join(root, 'out')
  fs.mkdirSync(workspace)

  let client = null
  let child = null
  let hostStderr = ''
  let succeeded = false
  try {
    const cli = compileHostPayload(root, outDir)
    const { HostProjectionClient } = require(
      path.join(outDir, 'host-client', 'HostProjectionClient.js')
    )

    child = spawn(process.execPath, [cli, 'serve', '--mode', 'production', '--profile', profile], {
      env: hostEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe']
    })
    // Drain stderr continuously so the pipe can never back-pressure the Host;
    // it is also the only explanation when readiness or the run fails.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (hostStderr.length < 64 * 1024) hostStderr += chunk
    })

    await waitFor(
      () =>
        fs.existsSync(path.join(profile, 'taskwraith-host-v2.json')) &&
        fs.existsSync(path.join(profile, 'taskwraith-host-v2.token')),
      'production Host discovery + token',
      20000
    )

    client = new HostProjectionClient({
      userDataPath: profile,
      client: {
        clientId: 'smoke-standalone-host-turn',
        clientClass: 'test',
        clientVersion: '1.0'
      },
      capabilities: [
        'bootstrap',
        'commands',
        'receipts',
        'setup',
        'provider-catalog',
        'provider-auth',
        'snapshot',
        'history',
        'health'
      ]
    })
    await client.connect()

    let offers
    try {
      offers = await client.getProviderOffers(providerId)
    } catch (error) {
      skip(
        `provider "${providerId}" offers could not be read (${errorMessage(error)}).\n` +
          `  connect the account, then run: node scripts/smoke-standalone-host-turn.cjs`
      )
      return
    }
    const model =
      offers.models.find((entry) => entry.default && entry.available) ||
      offers.models.find((entry) => entry.available)
    if (!model) {
      skip(
        `provider "${providerId}" has no available model (sign-in/quota missing?).\n` +
          `  connect the account, then run: node scripts/smoke-standalone-host-turn.cjs`
      )
      return
    }
    const posture = offers.postures?.find(
      (entry) => entry.postureId === 'default' && entry.available
    )
    if (!posture) {
      skip(`provider "${providerId}" offers no available "default" (Accept Edits) posture.`)
      return
    }

    const registered = await client.submitCommand(
      command('workspace.register', 'cmd-e2e-workspace', {}, { path: workspace })
    )
    const workspaceId =
      registered.resultRef?.kind === 'workspace' ? registered.resultRef.workspaceId : ''
    if (!workspaceId) {
      fail(`workspace.register did not return a workspace id: ${JSON.stringify(registered)}`)
    }
    const created = await client.submitCommand(
      command('thread.create', 'cmd-e2e-thread', {}, { scope: 'workspace', workspaceId })
    )
    const threadId = created.resultRef?.kind === 'thread' ? created.resultRef.threadId : ''
    if (!threadId) {
      fail(`thread.create did not return a thread id: ${JSON.stringify(created)}`)
    }
    const configured = await client.submitCommand(
      command(
        'thread.configure',
        'cmd-e2e-configure',
        { threadId },
        {
          providerId,
          modelId: model.modelId,
          postureId: posture.postureId,
          offerRevision: offers.offerRevision,
          ...(posture.requiresExplicitConsent ? { postureConsent: true } : {})
        }
      )
    )
    if (configured.status !== 'succeeded') {
      fail(`thread.configure failed: ${JSON.stringify(configured)}`)
    }

    const probeName = `taskwraith-smoke-probe-${process.pid}.txt`
    const decidedApprovals = new Set()
    const sent = await client.submitCommand(
      command(
        'composer.send',
        'cmd-e2e-send',
        { threadId },
        {
          text:
            `Create a new plain-text file named ${probeName} in the workspace root whose ` +
            `entire contents are the two characters: ok. Create it immediately with your ` +
            `file-writing tool; do not ask me anything, and reply with one short sentence ` +
            `when done.`
        }
      )
    )
    // THE assertion this smoke exists for: every defect fixed this round ended
    // right here, before the provider ever ran.
    if (sent.status !== 'succeeded' || sent.resultSummary !== 'run_started') {
      fail(
        `composer.send did not start a run: ${JSON.stringify(sent)}\nhost stderr:\n${hostStderr}`
      )
    }

    const terminal = await waitForTerminalRun(client, 'cmd-e2e-send', turnTimeoutMs, {
      probePath: path.join(workspace, probeName),
      hostStderr: () => hostStderr,
      decidedApprovals
    })
    if (decidedApprovals.size > 0) {
      console.log(
        `note: auto-accepted ${decidedApprovals.size} tool approval(s), as the TUI card would`
      )
    }
    if (terminal.providerOutcome !== 'completed') {
      fail(
        `run reached terminal outcome "${String(terminal.providerOutcome)}" instead of completed:\n` +
          `${JSON.stringify(terminal)}\nhost stderr:\n${hostStderr}`
      )
    }

    succeeded = true

    const history = await client.getThreadHistory({ threadId, limit: 50 })
    const userRow = history.entries.find(
      (entry) => entry.role === 'user' && entry.text.includes(probeName)
    )
    const assistantRow = history.entries.find(
      (entry) => entry.role === 'assistant' && entry.text.trim().length > 0
    )
    if (!userRow || !assistantRow) {
      fail(
        `transcript missing rows (user=${Boolean(userRow)} assistant=${Boolean(assistantRow)}):\n` +
          JSON.stringify(
            history.entries.map((entry) => ({ role: entry.role, text: entry.text.slice(0, 80) }))
          )
      )
    }

    const probePath = path.join(workspace, probeName)
    if (!fs.existsSync(probePath) || !fs.readFileSync(probePath, 'utf8').includes('ok')) {
      const listing = safeReadDir(workspace).join(', ') || '(empty)'
      fail(
        `probe file ${probeName} missing or wrong content at ${probePath}.\n` +
          `workspace holds: ${listing}\nThe turn completed but no mutation landed.`
      )
    }

    console.log(
      `standalone Host turn smoke ok: ${providerId}/${model.modelId} completed a run and wrote ${probeName}`
    )
  } finally {
    if (client) {
      try {
        client.close()
      } catch {
        // Best effort; the stop below is authoritative.
      }
    }
    await stopHost(root, profile, outDir, child, hostStderr)
    if (!succeeded && process.env.TASKWRAITH_SMOKE_KEEP_ON_FAILURE === '1') {
      console.error(`note: TASKWRAITH_SMOKE_KEEP_ON_FAILURE=1 — preserving evidence at ${root}`)
    } else {
      removeSmokeTree(root)
    }
  }
}

function compileHostPayload(root, outDir) {
  // One tsc pass over host-runtime (the Host itself, pulling its host-node /
  // shared / host-shared closure) plus host-client (the control client this
  // script drives). Mirrors the closure the subprocess test compiles, with
  // host-client added since the Host's own graph never imports its client.
  const tsconfig = path.join(root, 'tsconfig.smoke.json')
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        extends: path.join(repoRoot, 'src', 'host-runtime', 'tsconfig.json'),
        compilerOptions: {
          rootDir: path.join(repoRoot, 'src'),
          outDir,
          sourceMap: false,
          // The generated tsconfig lives outside the repo, so `types: ["node"]`
          // would resolve against the scratch dir; pin @types to the repo.
          typeRoots: [path.join(repoRoot, 'node_modules', '@types')]
        },
        include: [
          path.join(repoRoot, 'src', 'host-runtime', '**', '*.ts'),
          path.join(repoRoot, 'src', 'host-client', '**', '*.ts')
        ],
        exclude: [
          path.join(repoRoot, 'src', 'host-runtime', '**', '*.test.ts'),
          path.join(repoRoot, 'src', 'host-client', '**', '*.test.ts')
        ]
      },
      null,
      2
    )
  )
  const compile = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfig],
    { cwd: repoRoot, encoding: 'utf8', timeout: compileTimeoutMs }
  )
  if (compile.error || compile.status !== 0) {
    fail(
      `host payload failed to compile (exit ${String(compile.status)}): ` +
        `${compile.error?.message || `${compile.stdout || ''}${compile.stderr || ''}`.slice(0, 4000)}`
    )
  }
  const cli = path.join(outDir, 'host-runtime', 'cli.js')
  if (!fs.existsSync(cli)) fail(`compiled Host CLI missing at ${cli}`)
  if (!fs.existsSync(path.join(outDir, 'host-client', 'HostProjectionClient.js'))) {
    fail('compiled HostProjectionClient missing from the smoke payload')
  }
  return cli
}

async function waitForTerminalRun(client, runId, timeoutMs, context) {
  const deadline = Date.now() + timeoutMs
  let lastSeen = null
  let lastNote = ''
  let lastApprovals = []
  while (Date.now() < deadline) {
    const snapshot = await client.getSnapshot()
    lastApprovals = snapshot.snapshot.approvals ?? []
    // A tool approval the user would answer through the TUI card must not hang
    // a headless run: accept each pending approval once, exactly as a user
    // pressing "accept" on the card would.
    for (const approval of lastApprovals) {
      if (approval.status !== 'pending' || context.decidedApprovals.has(approval.approvalId)) {
        continue
      }
      context.decidedApprovals.add(approval.approvalId)
      console.log(`auto-accepting pending approval ${approval.approvalId} (${approval.actionKind})`)
      await client.submitCommand(
        command(
          'approval.decide',
          `cmd-e2e-approve-${context.decidedApprovals.size}`,
          { approvalId: approval.approvalId },
          { decision: 'accept' }
        )
      )
    }
    const run = snapshot.snapshot.runs.find((entry) => entry.runId === runId)
    if (run) {
      lastSeen = run
      const note = `${run.providerOutcome}${run.phase ? `/${run.phase}` : ''}`
      if (note !== lastNote) {
        lastNote = note
        console.log(`run ${runId}: ${note}`)
      }
      const outcome = run.providerOutcome
      if (outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled') {
        return run
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const probeNote = fs.existsSync(context.probePath)
    ? 'probe file EXISTS (mutation landed; terminal detection is the gap)'
    : 'probe file missing'
  throw namedError(
    'SmokeFailure',
    `run ${runId} did not reach a terminal outcome within ${timeoutMs}ms.\n` +
      `last seen: ${JSON.stringify(lastSeen)}\n${probeNote}\n` +
      `approvals: ${JSON.stringify(lastApprovals.map((entry) => [entry.approvalId, entry.status, entry.actionKind]))}\n` +
      `host stderr tail:\n${context.hostStderr().slice(-2000)}`
  )
}

async function stopHost(root, profile, outDir, child, hostStderr) {
  if (!child) return
  const cli = path.join(outDir, 'host-runtime', 'cli.js')
  let gracefulStatus = null
  if (fs.existsSync(cli)) {
    const graceful = spawnSync(process.execPath, [cli, 'stop', '--profile', profile], {
      env: hostEnvironment(),
      encoding: 'utf8',
      timeout: 10000
    })
    gracefulStatus = graceful.status
  }
  if (gracefulStatus === 0) {
    await waitForChildExit(child)
    if (child.exitCode !== 0) {
      fail(`production Host exited ${String(child.exitCode)} after graceful stop`)
    }
    return
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await waitForChildExit(child)
  }
  console.error(
    `note: graceful Host stop unavailable (status ${String(gracefulStatus)}); SIGTERM used.\n` +
      `host stderr tail:\n${hostStderr.slice(-2000)}`
  )
}

function hostEnvironment() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function providerBinaryPresent(id) {
  if (id !== 'claude') {
    // Only claude's resolution is known to this smoke; other providers are the
    // caller's responsibility to probe via TASKWRAITH_SMOKE_PROVIDER overrides.
    return true
  }
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 })
  return !probe.error && probe.status === 0
}

function command(name, commandId, target, args) {
  return {
    type: 'host.command',
    protocolVersion: 2,
    commandId,
    idempotencyKey: `key-${commandId}`,
    actor: {
      actorId: 'smoke-standalone-host-turn',
      clientId: 'smoke-standalone-host-turn',
      clientClass: 'test'
    },
    name,
    target,
    arguments: args,
    issuedAt: new Date().toISOString()
  }
}

function waitFor(check, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() >= deadline) {
        clearInterval(timer)
        reject(namedError('SmokeFailure', `timed out waiting for ${label}`))
      }
    }, 50)
  })
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(
      () => reject(namedError('SmokeFailure', 'production Host did not exit')),
      10000
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function removeSmokeTree(targetPath) {
  // Windows can briefly retain child-process profile files after shutdown.
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath)
  } catch {
    return []
  }
}

function skip(message) {
  const text = `standalone Host turn smoke SKIPPED: ${message}`
  if (requireLiveTurn) fail(text)
  console.log(text)
}

function fail(message) {
  throw namedError('SmokeFailure', message)
}

function namedError(name, message) {
  const error = new Error(message)
  error.name = name
  return error
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function readIntegerEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

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
 * Quota discipline is binding: ONE provider, at most TWO runs, no retry loops
 * spending user credits. The turn deadline defaults to 120s.
 *
 * Axes (all against the same thread, in order):
 *   base    — the original gate: configure default model + default posture,
 *             ONE send, terminal completed, transcript rows, probe file on disk.
 *   posture — switch posture default -> workspace_write via an explicit
 *             thread.configure (the TUI elevated path), then prove it took
 *             effect from the snapshot thread projection. Zero live turns.
 *   reuse   — stop the Host and re-serve the SAME profile mid-thread (the
 *             `npm run tui` rebuild scenario), reconnect a fresh client, and
 *             prove the thread, its runs and its transcript survived. A run
 *             that vanishes or hangs here is the "silently reaped" class.
 *             Zero live turns. (Deliberately NOT a mid-turn kill: orphaning a
 *             paid turn on purpose is not a gate, and the legibility half of
 *             that case belongs to the run-reason projection work.)
 *   model   — switch model mid-thread via an explicit thread.configure, send
 *             ONE more turn, and assert the run's projected modelId IS the
 *             selected model, never the provider default. This is the
 *             "always jumps to the default model" regression. Costs the second
 *             live turn; skipped loudly (no turn spent) when the provider
 *             offers no second available model.
 *   resume  — close the client without stopping the Host, reconnect, and prove
 *             the full transcript is still there (TUI disconnect/reconnect).
 *             Zero live turns.
 *
 * Skips legibly (exit 0) when the provider binary or an available model is
 * absent — that means "user must run this", not a product failure. Set
 * TASKWRAITH_SMOKE_REQUIRE_LIVE_TURN=1 to fail closed instead. Per-axis
 * unavailability (one model only, no workspace_write posture) is a loud
 * `axis <name> SKIPPED` note and NEVER fails closed: a provider that genuinely
 * offers one model is not a product failure. An axis that CAN run but FAILS
 * fails the script — a red gate naming a real defect is a deliverable.
 *
 * Usage:
 *   node scripts/smoke-standalone-host-turn.cjs
 *
 * Env:
 *   TASKWRAITH_SMOKE_PROVIDER            provider to drive (default: claude)
 *   TASKWRAITH_SMOKE_TURN_TIMEOUT_MS     terminal-run deadline (default: 120000)
 *   TASKWRAITH_SMOKE_COMPILE_TIMEOUT_MS  tsc deadline (default: 240000)
 *   TASKWRAITH_SMOKE_REQUIRE_LIVE_TURN   1 = treat base skips as failures
 *   TASKWRAITH_SMOKE_AXES                comma list subset of
 *                                        base,posture,reuse,model,resume
 *                                        (default: all — narrows quota spend)
 *   TASKWRAITH_SMOKE_SELFTEST            1 = run the pure-assertion selftests
 *                                        and exit; no compile, spawn, or quota
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
const ALL_AXES = ['base', 'posture', 'reuse', 'model', 'resume']
const axisSkips = []
const passedAxes = []

if (process.env.TASKWRAITH_SMOKE_SELFTEST === '1') {
  runSelfTests()
} else {
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
}

async function main() {
  const axes = readAxesEnv(process.env.TASKWRAITH_SMOKE_AXES)
  for (const axis of ALL_AXES) {
    if (!axes.includes(axis)) axisSkip(axis, 'deselected by TASKWRAITH_SMOKE_AXES')
  }
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
  const hostStderrTails = []
  let succeeded = false
  const stderrAll = () =>
    hostStderrTails.length > 0
      ? `${hostStderrTails.join('\n--- previous Host generation ---\n')}\n--- current Host generation ---\n${hostStderr}`
      : hostStderr
  try {
    const cli = compileHostPayload(root, outDir)
    const { HostProjectionClient } = require(
      path.join(outDir, 'host-client', 'HostProjectionClient.js')
    )

    child = spawnHost(cli, profile, (chunk) => {
      if (hostStderr.length < 64 * 1024) hostStderr += chunk
    })
    await awaitHostReady(profile)

    client = new HostProjectionClient(clientOptions(profile))
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
    await configureSelection(client, 'cmd-e2e-configure', {
      threadId,
      providerId,
      modelId: model.modelId,
      posture: posture,
      offerRevision: offers.offerRevision,
      axis: 'base'
    })
    let currentModelId = model.modelId
    let currentPostureId = posture.postureId
    let currentOfferRevision = offers.offerRevision
    const defaultModelId = model.modelId
    const decidedApprovals = new Set()
    // Every completed turn's (runId, probeName): the reuse/resume axes prove
    // these exact runs and rows survive a Host restart and a reconnect.
    const completedRuns = []
    const sentProbes = []

    const probeNameFor = (n) => `taskwraith-smoke-probe-${process.pid}-${n}.txt`

    // --- AXIS base: the original gate, unchanged in spirit. ---
    if (axes.includes('base')) {
      const probeName = probeNameFor(1)
      await sendTurn(client, {
        threadId,
        runCommandId: 'cmd-e2e-send',
        probeName,
        workspace,
        decidedApprovals,
        hostStderr: stderrAll,
        axis: 'base'
      })
      completedRuns.push({ runId: 'cmd-e2e-send', probeName })
      sentProbes.push(probeName)
      assertProbeFile(workspace, probeName, 'base')
      // Restored pre-widening guarantee: the base turn must leave user +
      // assistant rows immediately — reuse/resume only prove survival of rows
      // that were asserted here, so TASKWRAITH_SMOKE_AXES=base alone must look
      // at history too.
      const baseHistory = await client.getThreadHistory({ threadId, limit: 50 })
      assertBaseTranscript(baseHistory.entries, probeName)
      passAxis(
        'base',
        `axis base ok: ${providerId}/${currentModelId} completed a run and wrote ${probeName}`
      )
    }

    // --- AXIS posture: default -> workspace_write via an explicit
    // thread.configure (the TUI elevated path), proved from the snapshot. ---
    if (axes.includes('posture')) {
      const fresh = await client.getProviderOffers(providerId)
      currentOfferRevision = fresh.offerRevision
      const target = pickSwitchPosture(fresh.postures, currentPostureId)
      if (!target) {
        axisSkip(
          'posture',
          `no switchable write-capable posture offered (current "${currentPostureId}").`
        )
      } else {
        await configureSelection(client, 'cmd-e2e-configure-posture', {
          threadId,
          providerId,
          modelId: currentModelId,
          posture: target,
          offerRevision: currentOfferRevision,
          axis: 'posture'
        })
        const snapshot = await client.getSnapshot()
        const thread = findThread(snapshot, threadId)
        if (!thread) {
          fail(`axis posture: thread ${threadId} missing from snapshot after reconfigure`)
        }
        if (thread.permissionPresetId !== target.postureId) {
          fail(
            `axis posture: configure to "${target.postureId}" succeeded but the snapshot ` +
              `thread still shows permissionPresetId "${String(thread.permissionPresetId)}" — ` +
              `the switch did not take effect.`
          )
        }
        currentPostureId = target.postureId
        passAxis(
          'posture',
          `axis posture ok: ${providerId} thread now "${currentPostureId}" ` +
            `(permissionPresetId confirmed in snapshot)`
        )
      }
    }

    // --- AXIS reuse: stop the Host, re-serve the SAME profile mid-thread
    // (the `npm run tui` rebuild scenario), reconnect, prove nothing was
    // silently reaped. ---
    if (axes.includes('reuse')) {
      if (completedRuns.length === 0) {
        axisSkip('reuse', 'no completed run yet (base deselected) — nothing to prove survived.')
      } else {
        const before = await client.getSnapshot()
        const beforeRuns = before.snapshot.runs.filter((run) => run.threadId === threadId)
        const beforeHistory = await client.getThreadHistory({ threadId, limit: 50 })
        client.close()
        client = null
        hostStderrTails.push(hostStderr.slice(-2000))
        hostStderr = ''
        await stopHost(root, profile, outDir, child, stderrAll())
        child = null
        child = spawnHost(cli, profile, (chunk) => {
          if (hostStderr.length < 64 * 1024) hostStderr += chunk
        })
        await awaitHostReady(profile)
        client = new HostProjectionClient(clientOptions(profile))
        await client.connect()
        const after = await client.getSnapshot()
        const missing = missingRunIds(beforeRuns, after.snapshot.runs)
        if (missing.length > 0) {
          fail(
            `axis reuse: ${missing.length} run(s) vanished across a Host restart with the ` +
              `same profile: ${missing.join(', ')} — silently reaped.`
          )
        }
        for (const previous of beforeRuns) {
          const now = after.snapshot.runs.find((run) => run.runId === previous.runId)
          if (!now) {
            fail(`axis reuse: run ${previous.runId} vanished across Host restart.`)
          }
          if (now.providerOutcome !== previous.providerOutcome) {
            fail(
              `axis reuse: run ${previous.runId} changed outcome across restart ` +
                `(${previous.providerOutcome} -> ${now.providerOutcome}).`
            )
          }
        }
        const afterHistory = await client.getThreadHistory({ threadId, limit: 50 })
        assertHistoryCoversProbes(
          afterHistory.entries,
          sentProbes,
          `axis reuse: transcript lost rows across restart ` +
            `(before ${beforeHistory.entries.length}, after ${afterHistory.entries.length})`
        )
        const reselected = findThread(after, threadId)
        if (!reselected) fail(`axis reuse: thread ${threadId} missing from snapshot after restart.`)
        passAxis(
          'reuse',
          `axis reuse ok: ${beforeRuns.length} run(s) + ${afterHistory.entries.length} history ` +
            `row(s) survived a stop/re-serve of the same profile`
        )
      }
    }

    // --- AXIS model: switch model mid-thread, send ONE turn, assert the run
    // actually ran the selected model. Costs the second live turn. ---
    if (axes.includes('model')) {
      const fresh = await client.getProviderOffers(providerId)
      currentOfferRevision = fresh.offerRevision
      const second = pickSecondModel(fresh.models, currentModelId)
      if (!second) {
        axisSkip(
          'model',
          `provider "${providerId}" offers no second available model (only "${currentModelId}") ` +
            `— pinning is vacuous here, not broken. No turn spent.`
        )
      } else {
        const switchPosture = fresh.postures.find(
          (entry) => entry.postureId === currentPostureId && entry.available
        )
        if (!switchPosture) {
          fail(
            `axis model: current posture "${currentPostureId}" is no longer offered; ` +
              `refusing to guess a replacement inside the gate.`
          )
        }
        await configureSelection(client, 'cmd-e2e-configure-model', {
          threadId,
          providerId,
          modelId: second.modelId,
          posture: switchPosture,
          offerRevision: currentOfferRevision,
          axis: 'model'
        })
        const probeName = probeNameFor(2)
        await sendTurn(client, {
          threadId,
          runCommandId: 'cmd-e2e-send-2',
          probeName,
          workspace,
          decidedApprovals,
          hostStderr: stderrAll,
          axis: 'model'
        })
        completedRuns.push({ runId: 'cmd-e2e-send-2', probeName })
        sentProbes.push(probeName)
        assertProbeFile(workspace, probeName, 'model')
        const snapshot = await client.getSnapshot()
        checkRunModelStrict(snapshot, 'cmd-e2e-send-2', second.modelId, defaultModelId)
        currentModelId = second.modelId
        passAxis(
          'model',
          `axis model ok: second turn ran on selected "${second.modelId}", ` +
            `not the default "${defaultModelId}"`
        )
      }
    }

    // --- AXIS resume: fresh client, same live Host, full transcript intact. ---
    if (axes.includes('resume')) {
      if (sentProbes.length === 0) {
        axisSkip('resume', 'no turn was sent — nothing to prove resumable.')
      } else {
        client.close()
        client = null
        client = new HostProjectionClient(clientOptions(profile))
        await client.connect()
        const history = await client.getThreadHistory({ threadId, limit: 50 })
        assertHistoryCoversProbes(
          history.entries,
          sentProbes,
          'axis resume: transcript lost rows across reconnect'
        )
        passAxis(
          'resume',
          `axis resume ok: ${history.entries.length} history row(s) intact after reconnect`
        )
      }
    }

    if (decidedApprovals.size > 0) {
      console.log(
        `note: auto-accepted ${decidedApprovals.size} tool approval(s), as the TUI card would`
      )
    }
    succeeded = true

    console.log(
      `standalone Host turn smoke ok: ${providerId}/${currentModelId} ` +
        `(${completedRuns.length} completed turn(s)) — axes passed: ${passedAxesSnapshot()} ` +
        `${axisSkips.length > 0 ? `— axes skipped: ${axisSkips.join('; ')}` : '— no axes skipped'}`
    )
  } finally {
    if (client) {
      try {
        client.close()
      } catch {
        // Best effort; the stop below is authoritative.
      }
    }
    await stopHost(root, profile, outDir, child, stderrAll())
    if (!succeeded && process.env.TASKWRAITH_SMOKE_KEEP_ON_FAILURE === '1') {
      console.error(`note: TASKWRAITH_SMOKE_KEEP_ON_FAILURE=1 — preserving evidence at ${root}`)
    } else {
      removeSmokeTree(root)
    }
  }
}

function readAxesEnv(raw) {
  if (raw == null || raw.trim() === '') return [...ALL_AXES]
  const picked = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  const unknown = picked.filter((entry) => !ALL_AXES.includes(entry))
  if (unknown.length > 0) {
    throw namedError(
      'SmokeFailure',
      `TASKWRAITH_SMOKE_AXES has unknown axe(s): ${unknown.join(', ')} (known: ${ALL_AXES.join(', ')})`
    )
  }
  return [...new Set(picked)]
}

/**
 * An axis that cannot run here (one model offered, posture absent, setup turn
 * deselected). Loud, counted in the final summary, and NEVER fail-closed: a
 * provider that genuinely offers one model is not a product failure.
 */
function axisSkip(axis, reason) {
  const note = `${axis} (${reason})`
  axisSkips.push(note)
  console.log(`axis ${axis} SKIPPED: ${reason}`)
}

function passAxis(axis, message) {
  passedAxes.push(axis)
  console.log(message)
}

function passedAxesSnapshot() {
  return passedAxes.length > 0 ? passedAxes.join(',') : '(none)'
}

function clientOptions(profile) {
  return {
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
  }
}

function spawnHost(cli, profile, onStderr) {
  const child = spawn(
    process.execPath,
    [cli, 'serve', '--mode', 'production', '--profile', profile],
    {
      env: hostEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
  // Drain stderr continuously so the pipe can never back-pressure the Host;
  // it is also the only explanation when readiness or the run fails.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', onStderr)
  return child
}

function awaitHostReady(profile) {
  return waitFor(
    () =>
      fs.existsSync(path.join(profile, 'taskwraith-host-v2.json')) &&
      fs.existsSync(path.join(profile, 'taskwraith-host-v2.token')),
    'production Host discovery + token',
    20000
  )
}

async function configureSelection(client, commandId, selection) {
  const configured = await client.submitCommand(
    command(
      'thread.configure',
      commandId,
      { threadId: selection.threadId },
      {
        providerId: selection.providerId,
        modelId: selection.modelId,
        postureId: selection.posture.postureId,
        offerRevision: selection.offerRevision,
        ...(selection.posture.requiresExplicitConsent ? { postureConsent: true } : {})
      }
    )
  )
  if (configured.status !== 'succeeded') {
    fail(
      `axis ${selection.axis}: thread.configure to ${selection.providerId}/` +
        `${selection.modelId}/${selection.posture.postureId} failed: ${JSON.stringify(configured)}`
    )
  }
  return configured
}

async function sendTurn(client, options) {
  const sent = await client.submitCommand(
    command(
      'composer.send',
      options.runCommandId,
      { threadId: options.threadId },
      {
        text:
          `Create a new plain-text file named ${options.probeName} in the workspace root ` +
          `whose entire contents are the two characters: ok. Create it immediately with ` +
          `your file-writing tool; do not ask me anything, and reply with one short ` +
          `sentence when done.`
      }
    )
  )
  // THE assertion this smoke exists for: every defect fixed this round ended
  // right here, before the provider ever ran.
  if (sent.status !== 'succeeded' || sent.resultSummary !== 'run_started') {
    fail(
      `axis ${options.axis}: composer.send did not start a run: ${JSON.stringify(sent)}\n` +
        `host stderr:\n${options.hostStderr()}`
    )
  }
  const terminal = await waitForTerminalRun(client, options.runCommandId, turnTimeoutMs, {
    probePath: path.join(options.workspace, options.probeName),
    hostStderr: options.hostStderr,
    decidedApprovals: options.decidedApprovals
  })
  if (terminal.providerOutcome !== 'completed') {
    fail(
      `axis ${options.axis}: run reached terminal outcome ` +
        `"${String(terminal.providerOutcome)}" instead of completed:\n` +
        `${JSON.stringify(terminal)}\nhost stderr:\n${options.hostStderr()}`
    )
  }
  return terminal
}

function assertProbeFile(workspace, probeName, axis) {
  const probePath = path.join(workspace, probeName)
  if (!fs.existsSync(probePath) || !fs.readFileSync(probePath, 'utf8').includes('ok')) {
    const listing = safeReadDir(workspace).join(', ') || '(empty)'
    fail(
      `axis ${axis}: probe file ${probeName} missing or wrong content at ${probePath}.\n` +
        `workspace holds: ${listing}\nThe turn completed but no mutation landed.`
    )
  }
}

function findThread(snapshotFrame, threadId) {
  const threads = snapshotFrame?.snapshot?.threads
  if (!Array.isArray(threads)) return undefined
  return threads.find((thread) => thread && thread.id === threadId)
}

function findRun(snapshotFrame, runId) {
  const runs = snapshotFrame?.snapshot?.runs
  if (!Array.isArray(runs)) return undefined
  return runs.find((run) => run && run.runId === runId)
}

/**
 * The model-pinning regression assertion: the run must project the model the
 * thread was configured with, never a silent fallback to the provider
 * default. A run with NO projected modelId is a failure too — without it the
 * gate cannot tell pinning from fallback, and a vacuous pass is worse than red.
 */
function checkRunModelStrict(snapshotFrame, runId, expectedModelId, defaultModelId) {
  const run = findRun(snapshotFrame, runId)
  if (!run) {
    fail(`axis model: run ${runId} missing from snapshot — cannot prove which model ran.`)
  }
  if (run.modelId !== expectedModelId) {
    const actual = run.modelId === undefined ? '(absent)' : `"${run.modelId}"`
    fail(
      `axis model: run ${runId} projected modelId ${actual}, expected selected ` +
        `"${expectedModelId}" (provider default "${defaultModelId}"). The turn did not ` +
        `run the selected model.`
    )
  }
}

/**
 * The posture-switch target: a write-capable posture other than the current
 * one. Deliberately never `plan`/`read_only` (their read ceiling would strand
 * the mutation turn) and never `full_access` (the standalone Host cannot mint
 * its signed consent proof, so configuring it from this gate always fails).
 */
function pickSwitchPosture(postures, currentPostureId) {
  if (!Array.isArray(postures)) return null
  const target = postures.find(
    (entry) =>
      entry &&
      entry.available &&
      entry.postureId === 'workspace_write' &&
      entry.postureId !== currentPostureId
  )
  return target || null
}

/** A second available model distinct from the current one, else null. */
function pickSecondModel(models, currentModelId) {
  if (!Array.isArray(models)) return null
  return (
    models.find((entry) => entry && entry.available && entry.modelId !== currentModelId) || null
  )
}

function missingRunIds(beforeRuns, afterRuns) {
  const afterIds = new Set((afterRuns || []).map((run) => run && run.runId))
  return (beforeRuns || []).filter((run) => run && !afterIds.has(run.runId)).map((run) => run.runId)
}

/**
 * The base-axis transcript gate (the pre-widening guarantee): immediately
 * after the base turn, history must hold the user row naming the probe plus
 * an assistant row. Single-probe wrapper so the live base path and the
 * selftest pin the same function — weakening this wrapper must red the
 * NAMED `base-transcript-*` selftest checks below.
 */
function assertBaseTranscript(entries, probeName) {
  assertHistoryCoversProbes(
    entries,
    [probeName],
    'axis base: transcript missing rows for the completed turn'
  )
}

/** Every sent probe needs its user row; assistant rows must cover every turn. */
function assertHistoryCoversProbes(entries, probeNames, context) {
  const rows = entries || []
  const missing = probeNames.filter(
    (probe) =>
      !rows.some(
        (entry) => entry && entry.role === 'user' && String(entry.text || '').includes(probe)
      )
  )
  const assistantRows = rows.filter(
    (entry) => entry && entry.role === 'assistant' && String(entry.text || '').trim().length > 0
  ).length
  if (missing.length > 0 || assistantRows < probeNames.length) {
    fail(
      `${context} (probes missing user rows: ${missing.join(', ') || '(none)'}; ` +
        `assistant rows ${assistantRows}/${probeNames.length}):\n` +
        JSON.stringify(
          rows.map((entry) => ({
            role: entry && entry.role,
            text: String((entry && entry.text) || '').slice(0, 80)
          }))
        )
    )
  }
}

function runSelfTests() {
  // Zero-quota verification for every pure assertion the new axes depend on.
  // Each behaviour has a positive case AND a negative case (the helper must
  // throw where the gate must go red); a red-proof run deletes one behaviour
  // at a time and confirms its NAMED test fails.
  let passed = 0
  const check = (name, fn) => {
    try {
      fn()
    } catch (error) {
      console.error(`selftest FAIL ${name}: ${errorMessage(error)}`)
      process.exitCode = 1
      return
    }
    passed += 1
    console.log(`selftest ok ${name}`)
  }
  const expectThrow = (name, fn, pattern) => {
    check(name, () => {
      let thrown = null
      try {
        fn()
      } catch (error) {
        thrown = error
      }
      if (!thrown) throw new Error('expected a throw, nothing was thrown')
      if (pattern && !pattern.test(errorMessage(thrown))) {
        throw new Error(`thrown message did not match ${String(pattern)}: ${errorMessage(thrown)}`)
      }
    })
  }

  check('axes-default-all', () => {
    const result = readAxesEnv(undefined)
    if (result.join(',') !== ALL_AXES.join(',')) throw new Error(`got ${result.join(',')}`)
  })
  check('axes-subset', () => {
    const result = readAxesEnv('base,model')
    if (result.join(',') !== 'base,model') throw new Error(`got ${result.join(',')}`)
  })
  expectThrow('axes-unknown-fails', () => readAxesEnv('base,nope'), /unknown axe/)

  check('second-model-picked', () => {
    const found = pickSecondModel(
      [
        { modelId: 'a', available: true },
        { modelId: 'b', available: true }
      ],
      'a'
    )
    if (!found || found.modelId !== 'b') throw new Error('wrong pick')
  })
  check('second-model-skips-unavailable', () => {
    const found = pickSecondModel(
      [
        { modelId: 'a', available: true },
        { modelId: 'b', available: false }
      ],
      'a'
    )
    if (found !== null) throw new Error('should be null')
  })
  check('second-model-none', () => {
    if (pickSecondModel([{ modelId: 'a', available: true }], 'a') !== null) {
      throw new Error('should be null')
    }
    if (pickSecondModel(undefined, 'a') !== null) throw new Error('should be null')
  })

  check('posture-target-picked', () => {
    const found = pickSwitchPosture(
      [
        { postureId: 'default', available: true, ceiling: 'workspace_write' },
        { postureId: 'workspace_write', available: true, ceiling: 'workspace_write' }
      ],
      'default'
    )
    if (!found || found.postureId !== 'workspace_write') throw new Error('wrong pick')
  })
  check('posture-no-target', () => {
    if (pickSwitchPosture([{ postureId: 'default', available: true }], 'default') !== null) {
      throw new Error('should be null')
    }
    if (pickSwitchPosture([{ postureId: 'full_access', available: true }], 'default') !== null) {
      throw new Error('full_access must never be picked')
    }
    if (pickSwitchPosture(undefined, 'default') !== null) throw new Error('should be null')
  })

  check('run-model-strict-pass', () => {
    checkRunModelStrict({ snapshot: { runs: [{ runId: 'r1', modelId: 'm2' }] } }, 'r1', 'm2', 'm1')
  })
  expectThrow(
    'run-model-fallback-red',
    () =>
      checkRunModelStrict(
        { snapshot: { runs: [{ runId: 'r1', modelId: 'm1' }] } },
        'r1',
        'm2',
        'm1'
      ),
    /did not run the selected model/
  )
  expectThrow(
    'run-model-absent-red',
    () => checkRunModelStrict({ snapshot: { runs: [{ runId: 'r1' }] } }, 'r1', 'm2', 'm1'),
    /\(absent\)/
  )
  expectThrow(
    'run-model-missing-run-red',
    () => checkRunModelStrict({ snapshot: { runs: [] } }, 'r1', 'm2', 'm1'),
    /missing from snapshot/
  )

  check('reuse-intact', () => {
    const missing = missingRunIds([{ runId: 'r1' }], [{ runId: 'r1' }])
    if (missing.length !== 0) throw new Error('should be empty')
  })
  check('reuse-names-vanished', () => {
    const missing = missingRunIds([{ runId: 'r1' }, { runId: 'r2' }], [{ runId: 'r1' }])
    if (missing.join(',') !== 'r2') throw new Error(`got ${missing.join(',')}`)
  })

  check('history-covered', () => {
    assertHistoryCoversProbes(
      [
        { role: 'user', text: 'write probe-1' },
        { role: 'assistant', text: 'done' }
      ],
      ['probe-1'],
      'ctx'
    )
  })
  expectThrow(
    'history-missing-probe-red',
    () => assertHistoryCoversProbes([{ role: 'assistant', text: 'done' }], ['probe-1'], 'ctx'),
    /missing user rows: probe-1/
  )
  expectThrow(
    'history-no-assistant-red',
    () => assertHistoryCoversProbes([{ role: 'user', text: 'write probe-1' }], ['probe-1'], 'ctx'),
    /assistant rows 0\/1/
  )

  check('base-transcript-covered', () => {
    assertBaseTranscript(
      [
        { role: 'user', text: 'write probe-base' },
        { role: 'assistant', text: 'done' }
      ],
      'probe-base'
    )
  })
  expectThrow(
    'base-transcript-missing-red',
    () => assertBaseTranscript([{ role: 'assistant', text: 'done' }], 'probe-base'),
    /missing user rows: probe-base/
  )
  expectThrow(
    'base-transcript-no-assistant-red',
    () => assertBaseTranscript([{ role: 'user', text: 'write probe-base' }], 'probe-base'),
    /assistant rows 0\/1/
  )

  check('find-thread', () => {
    const frame = { snapshot: { threads: [{ id: 't1' }] } }
    if (!findThread(frame, 't1')) throw new Error('should find')
    if (findThread(frame, 't2') !== undefined) throw new Error('should miss')
  })

  if (process.exitCode) {
    console.error('smoke selftest FAILED')
  } else {
    console.log(`smoke selftest ok: ${passed} checks`)
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

#!/usr/bin/env node
'use strict'

/**
 * Reproducible Studio Outcome 1 runner.
 *
 * Launches only a disposable TaskWraith profile, opens generated media, kills
 * only the exact child Companion, and proves a distinct replacement hydrates
 * the same asset without changing foreground ownership, cursor position, the
 * Electron host, process group, or durable journal boundary.
 */

const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')

const harness = require('./studio-acceptance-harness.cjs')
const session = require('./studio-acceptance-session.cjs')

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(label, probe, timeoutMs = 45_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    label +
      ' timed out' +
      (lastError ? ': ' + (lastError instanceof Error ? lastError.message : String(lastError)) : '')
  )
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function assertFocusHandoff(before, after, oldPid, newPid) {
  const stable =
    before.frontmostPid === after.frontmostPid &&
    before.frontmostPid !== oldPid &&
    before.frontmostPid !== newPid &&
    before.frontmostBundleIdentifier !== 'com.apple.loginwindow' &&
    after.frontmostBundleIdentifier !== 'com.apple.loginwindow' &&
    before.targetPid === oldPid &&
    after.targetPid === newPid &&
    before.targetIsActive === false &&
    after.targetIsActive === false &&
    before.cursorX === after.cursorX &&
    before.cursorY === after.cursorY
  if (!stable) {
    throw new Error(
      'Studio lifecycle changed focus, activation, or cursor: ' +
        JSON.stringify({ before, after, oldPid, newPid })
    )
  }
  return {
    ok: true,
    foregroundPid: before.frontmostPid,
    oldCompanionInactive: true,
    newCompanionInactive: true,
    cursorUnchanged: true
  }
}

function adjudicateLifecycleEvidence(evidence) {
  const before = evidence.before
  const after = evidence.after
  if (
    !before ||
    !after ||
    !Number.isSafeInteger(evidence.electronPid) ||
    before.process.ppid !== evidence.electronPid ||
    after.process.ppid !== evidence.electronPid ||
    before.process.pgid !== evidence.electronPgid ||
    after.process.pgid !== evidence.electronPgid ||
    before.process.pid === after.process.pid ||
    evidence.oldProcessDisappeared !== true
  ) {
    throw new Error('Studio lifecycle did not prove one host and a distinct replacement child')
  }
  for (const [phase, observation] of [
    ['before', before],
    ['after', after]
  ]) {
    if (
      observation.assetMatch?.matched !== true ||
      observation.assetMatch.distance !== 0 ||
      observation.assetMatch.expected !== evidence.expectedAssetId.toLowerCase() ||
      observation.windowTitle !== 'TaskWraith Studio'
    ) {
      throw new Error(
        'Studio lifecycle did not prove exact hydrated media at ' +
          phase +
          ': ' +
          JSON.stringify(observation)
      )
    }
  }
  if (
    !Number.isSafeInteger(before.journalCount) ||
    before.journalCount < 1 ||
    !Number.isSafeInteger(after.journalCount) ||
    after.journalCount < before.journalCount ||
    !Number.isSafeInteger(before.journalLastRevision) ||
    before.journalLastRevision < 1 ||
    !Number.isSafeInteger(after.journalLastRevision) ||
    after.journalLastRevision < before.journalLastRevision ||
    before.journalDigest !== after.journalPrefixDigest
  ) {
    throw new Error('Studio lifecycle durable journal changed or regressed across replacement')
  }
  if (evidence.focus?.ok !== true) {
    throw new Error('Studio lifecycle focus handoff is not proven')
  }
  return {
    ok: true,
    electronPid: evidence.electronPid,
    electronPgid: evidence.electronPgid,
    oldCompanionPid: before.process.pid,
    newCompanionPid: after.process.pid,
    oldProcessDisappeared: true,
    expectedAssetId: evidence.expectedAssetId,
    journalLastRevision: after.journalLastRevision,
    focus: evidence.focus
  }
}

function journalBoundary(entries, prefixCount = entries.length) {
  return {
    journalCount: entries.length,
    journalLastRevision: entries.at(-1)?.revision || 0,
    journalDigest: require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify(entries))
      .digest('hex'),
    journalPrefixCount: prefixCount,
    journalPrefixDigest: require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify(entries.slice(0, prefixCount)))
      .digest('hex')
  }
}

async function exactMediaObservation(plan, target, name) {
  const capture = await session.captureNative(plan, target, name)
  const hud = session.ocrScreenshot(capture.path)
  const assetMatch = session.hudContainsAsset(hud, target.asset.sha256)
  if (!assetMatch.matched || assetMatch.distance !== 0) {
    throw new Error(
      'Studio lifecycle capture does not show the exact generated asset: ' +
        JSON.stringify(assetMatch)
    )
  }
  return {
    capture,
    hud,
    assetMatch,
    windowTitle: target.expectedWindowTitle
  }
}

async function waitForReplacementCompanion(electronPid, electronPgid, oldPid) {
  return waitFor('replacement Studio Companion', async () => {
    const candidate = await harness.findStudioCompanion(electronPid)
    if (candidate.pid === oldPid) return null
    const process = session.exactCompanionProcess(candidate, electronPgid)
    if (process.ppid !== electronPid) {
      throw new Error('replacement Companion is not the exact Electron child')
    }
    return { candidate, process }
  })
}

async function runBoundedLifecycle(options = {}, adapters = {}) {
  const artifactRoot = path.resolve(String(options.artifactRoot || ''))
  if (
    !path.isAbsolute(artifactRoot) ||
    artifactRoot === path.parse(artifactRoot).root ||
    fs.existsSync(artifactRoot)
  ) {
    throw new Error('bounded lifecycle requires a fresh absolute artifact root')
  }
  const staticCustody = session.assertAcceptanceCustody()
  await fsPromises.mkdir(path.dirname(artifactRoot), { recursive: true, mode: 0o700 })
  await fsPromises.mkdir(artifactRoot, { recursive: false, mode: 0o700 })
  const inputs = await (adapters.materializePortableInputs || session.materializePortableInputs)(
    artifactRoot,
    adapters.inputAdapters || {}
  )
  const custody = session.assertAcceptanceCustody(inputs)
  const runtime = await (adapters.prepareFreshRuntime || session.prepareFreshRuntime)(
    artifactRoot,
    inputs
  )
  session.assertWindowServerSessionAvailable(-1, 'preflight')
  const startedAt = new Date().toISOString()
  const result = await (adapters.withIsolatedSession || session.withIsolatedSession)(
    runtime,
    {
      phase: 'bounded-lifecycle',
      remoteDebuggingPort: options.remoteDebuggingPort || 9470,
      mainInspectorPort: options.mainInspectorPort || 9870,
      timeoutMs: options.timeoutMs || 240_000
    },
    async (context) => {
      const plan = { ...context.plan, artifactRoot }
      await sleep(options.hydrationSettleMilliseconds ?? 15_000)
      const openResult = await session.invokeStudioOpen(context.renderer, runtime.asset)
      const beforeWindow = await session.waitForSourceWindow(context.companion)
      const beforeTarget = {
        companion: context.companion,
        electronPgid: context.session.pgid,
        window: beforeWindow,
        expectedWindowTitle: 'TaskWraith Studio',
        asset: runtime.asset
      }
      const beforeJournal = await harness.readStudioJournalOperations(plan)
      const beforeFocus = session.focusSnapshot(context.companion.pid)
      const beforeMedia = await exactMediaObservation(plan, beforeTarget, 'lifecycle-before')
      const beforeProcess = session.exactCompanionProcess(context.companion, context.session.pgid)
      if (beforeProcess.ppid !== context.session.pid) {
        throw new Error('original Companion is not the exact Electron child')
      }

      const kill = adapters.kill || process.kill
      kill(context.companion.pid, 'SIGKILL')
      await waitFor('old Studio Companion disappearance', () =>
        processExists(context.companion.pid) ? null : true
      )
      const replacement = await (
        adapters.waitForReplacementCompanion || waitForReplacementCompanion
      )(context.session.pid, context.session.pgid, context.companion.pid)
      const afterWindow = await session.waitForSourceWindow(replacement.candidate)
      const afterTarget = {
        companion: replacement.candidate,
        electronPgid: context.session.pgid,
        window: afterWindow,
        expectedWindowTitle: 'TaskWraith Studio',
        asset: runtime.asset
      }
      const afterMedia = await exactMediaObservation(plan, afterTarget, 'lifecycle-after')
      const afterJournal = await harness.readStudioJournalOperations(plan)
      const afterFocus = session.focusSnapshot(replacement.candidate.pid)
      const focus = assertFocusHandoff(
        beforeFocus,
        afterFocus,
        context.companion.pid,
        replacement.candidate.pid
      )
      const rawEvidence = {
        electronPid: context.session.pid,
        electronPgid: context.session.pgid,
        expectedAssetId: runtime.asset.sha256,
        oldProcessDisappeared: !processExists(context.companion.pid),
        focus,
        before: {
          process: beforeProcess,
          ...journalBoundary(beforeJournal),
          ...beforeMedia
        },
        after: {
          process: replacement.process,
          ...journalBoundary(afterJournal, beforeJournal.length),
          ...afterMedia
        }
      }
      const verdict = adjudicateLifecycleEvidence(rawEvidence)
      return {
        openResult,
        rawEvidence,
        verdict,
        portOwnership: context.portOwnership,
        mainIdentity: context.mainIdentity
      }
    }
  )
  const custodyAfter = session.assertAcceptanceCustody(inputs)
  const evidence = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-bounded-lifecycle',
    ok: true,
    startedAt,
    recordedAt: new Date().toISOString(),
    staticCustody,
    custody,
    custodyAfter,
    inputs,
    ...result
  }
  const evidencePath = path.join(artifactRoot, 'evidence.json')
  await session.writeJson(evidencePath, evidence)
  return {
    evidencePath,
    evidenceSha256: session.sha256File(evidencePath),
    evidence
  }
}

function parseLifecycleCli(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { help: true, artifactRoot: null }
  }
  let artifactRoot = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('--artifact-root=')) {
      artifactRoot = argument.slice('--artifact-root='.length)
    } else if (argument === '--artifact-root' && index + 1 < argv.length) {
      artifactRoot = argv[++index]
    } else {
      throw new Error('unknown bounded lifecycle argument: ' + argument)
    }
  }
  if (!artifactRoot) throw new Error('--artifact-root is required')
  return { help: false, artifactRoot }
}

module.exports = {
  adjudicateLifecycleEvidence,
  assertFocusHandoff,
  parseLifecycleCli,
  processExists,
  runBoundedLifecycle
}

if (require.main === module) {
  let cli
  try {
    cli = parseLifecycleCli(process.argv.slice(2))
  } catch (error) {
    console.error(
      '[studio-bounded-lifecycle-runner] FAIL — ' +
        (error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
  }
  if (cli?.help) {
    process.stdout.write(
      'Usage: node scripts/studio-bounded-lifecycle-runner.cjs --artifact-root=/fresh/absolute/path\n'
    )
  } else if (cli) {
    runBoundedLifecycle({ artifactRoot: cli.artifactRoot }).catch((error) => {
      console.error(
        '[studio-bounded-lifecycle-runner] FAIL — ' +
          (error instanceof Error ? error.message : String(error))
      )
      process.exitCode = 1
    })
  }
}

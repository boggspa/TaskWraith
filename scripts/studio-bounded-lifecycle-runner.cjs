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

function collectRegularFiles(directory) {
  const pending = [directory]
  const files = []
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) files.push(entryPath)
      else throw new Error('bounded lifecycle hydration source is not regular: ' + entryPath)
    }
  }
  return files.sort()
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

function hydrationBreakpointDefinition() {
  const bundles = collectRegularFiles(path.join(session.repoRoot, 'out', 'main')).filter(
    (filePath) => {
      if (!filePath.endsWith('.js')) return false
      const source = fs.readFileSync(filePath, 'utf8')
      return (
        source.includes('const hydratedRevision = extractHydrationRevision(value, response);') &&
        source.includes('this.emit({ type: "hydration_served", revision: hydratedRevision });')
      )
    }
  )
  if (bundles.length !== 1) {
    throw new Error('could not identify one exact hydration bundle: ' + JSON.stringify(bundles))
  }
  const bundlePath = bundles[0]
  const lines = fs.readFileSync(bundlePath, 'utf8').split(/\r?\n/)
  const methodLine = lines.findIndex((line) => line.trim() === 'if (hydratedRevision !== null) {')
  const eventLine = lines.findIndex(
    (line) => line.trim() === 'this.emit({ type: "hydration_served", revision: hydratedRevision });'
  )
  if (methodLine < 0 || eventLine < 0 || eventLine <= methodLine) {
    throw new Error(
      'hydration breakpoint statements were not unique: ' +
        JSON.stringify({ bundlePath, methodLine, eventLine })
    )
  }
  return {
    bundlePath,
    bundleSha256: session.sha256File(bundlePath),
    urlRegex:
      bundlePath
        .split(path.sep)
        .at(-1)
        .replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '$',
    methodLine,
    eventLine
  }
}

async function armHydrationProbe(mainInspector) {
  const definition = hydrationBreakpointDefinition()
  const hits = []
  let probeError = null
  let pending = Promise.resolve()
  const removeListener = mainInspector.on('Debugger.paused', (params) => {
    pending = pending
      .then(async () => {
        const frame = params?.callFrames?.[0]
        if (!frame?.callFrameId) {
          throw new Error('hydration breakpoint paused without a call frame')
        }
        const evaluated = await mainInspector.post('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression: `(() => {
            const result = response && typeof response === 'object' ? response.result : null;
            const document =
              result && typeof result === 'object' && result.document &&
              typeof result.document === 'object' ? result.document : null;
            return {
              method: value && typeof value === 'object' ? value.method ?? null : null,
              requestId: value && typeof value === 'object' ? value.id ?? null : null,
              responseId: response && typeof response === 'object' ? response.id ?? null : null,
              responseRevision: result && typeof result === 'object' ? result.revision ?? null : null,
              hydrationRevision: typeof hydratedRevision === 'number' ? hydratedRevision : null,
              childPid: child?.pid ?? null,
              supervisorStatus: this.status(),
              hydratedChildMatches: this.hydratedChild === child,
              document: document
                ? {
                    formatVersion: document.formatVersion,
                    assets: (document.assets || []).map((asset) => ({
                      assetId: asset.assetId,
                      path: asset.path,
                      mediaKind: asset.mediaKind
                    }))
                  }
                : null
            };
          })()`,
          returnByValue: true
        })
        if (evaluated?.exceptionDetails) {
          throw new Error(
            'hydration breakpoint evaluation failed: ' + JSON.stringify(evaluated.exceptionDetails)
          )
        }
        hits.push({
          recordedAt: new Date().toISOString(),
          breakpointLine: frame.location?.lineNumber ?? null,
          kind:
            frame.location?.lineNumber === definition.eventLine
              ? 'hydration-served-event'
              : 'request-response',
          ...evaluated?.result?.value
        })
      })
      .catch((error) => {
        probeError = error
      })
      .finally(async () => {
        await mainInspector.post('Debugger.resume').catch((error) => {
          probeError ||= error
        })
      })
  })

  await mainInspector.post('Debugger.enable')
  const methodBreakpoint = await mainInspector.post('Debugger.setBreakpointByUrl', {
    lineNumber: definition.methodLine,
    urlRegex: definition.urlRegex
  })
  const eventBreakpoint = await mainInspector.post('Debugger.setBreakpointByUrl', {
    lineNumber: definition.eventLine,
    urlRegex: definition.urlRegex
  })
  if (
    !methodBreakpoint?.breakpointId ||
    !eventBreakpoint?.breakpointId ||
    !methodBreakpoint.locations?.length ||
    !eventBreakpoint.locations?.length
  ) {
    removeListener()
    await mainInspector.post('Debugger.disable').catch(() => {})
    throw new Error(
      'hydration breakpoints did not bind to the production bundle: ' +
        JSON.stringify({ definition, methodBreakpoint, eventBreakpoint })
    )
  }

  return {
    definition: {
      ...definition,
      methodBreakpointId: methodBreakpoint.breakpointId,
      methodLocations: methodBreakpoint.locations,
      eventBreakpointId: eventBreakpoint.breakpointId,
      eventLocations: eventBreakpoint.locations
    },
    async waitForHydration(expectedPid, expectedRevision) {
      const observed = await waitFor(
        'replacement hello -> getDocument -> hydration_served',
        async () => {
          if (probeError) throw probeError
          const relevant = hits.filter((hit) => hit.childPid === expectedPid)
          const helloIndex = relevant.findIndex(
            (hit) => hit.kind === 'request-response' && hit.method === 'studio/hello'
          )
          const documentIndex = relevant.findIndex(
            (hit) => hit.kind === 'request-response' && hit.method === 'studio/getDocument'
          )
          const eventIndex = relevant.findIndex(
            (hit) => hit.kind === 'hydration-served-event' && hit.method === 'studio/getDocument'
          )
          const event = eventIndex < 0 ? null : relevant[eventIndex]
          if (
            helloIndex < 0 ||
            documentIndex <= helloIndex ||
            eventIndex <= documentIndex ||
            event?.hydrationRevision !== expectedRevision ||
            event?.responseRevision !== expectedRevision ||
            event?.hydratedChildMatches !== true ||
            event?.supervisorStatus?.pid !== expectedPid ||
            !event?.document
          ) {
            return null
          }
          return {
            expectedPid,
            expectedRevision,
            helloIndex,
            documentIndex,
            eventIndex,
            relevantHits: relevant,
            hydratedDocument: event.document
          }
        },
        30_000,
        50
      )
      await pending
      return observed
    },
    async close() {
      await pending
      removeListener()
      await mainInspector
        .post('Debugger.removeBreakpoint', { breakpointId: methodBreakpoint.breakpointId })
        .catch(() => {})
      await mainInspector
        .post('Debugger.removeBreakpoint', { breakpointId: eventBreakpoint.breakpointId })
        .catch(() => {})
      await mainInspector.post('Debugger.disable').catch(() => {})
      if (probeError) throw probeError
    }
  }
}

function assertHydrationEvidence(hydration, expectedPid, expectedRevision, asset) {
  if (
    hydration?.expectedPid !== expectedPid ||
    hydration?.expectedRevision !== expectedRevision ||
    !Number.isSafeInteger(hydration.helloIndex) ||
    !Number.isSafeInteger(hydration.documentIndex) ||
    !Number.isSafeInteger(hydration.eventIndex) ||
    hydration.documentIndex <= hydration.helloIndex ||
    hydration.eventIndex <= hydration.documentIndex ||
    !hydration.hydratedDocument
  ) {
    throw new Error('Studio lifecycle hydration sequence is not exact for the replacement child')
  }
  const hydratedAsset = Array.isArray(hydration.hydratedDocument.assets)
    ? hydration.hydratedDocument.assets.find((candidate) => candidate?.assetId === asset.sha256)
    : null
  if (
    !hydratedAsset ||
    path.resolve(String(hydratedAsset.path || '')) !== path.resolve(asset.assetPath)
  ) {
    throw new Error(
      'Studio lifecycle replacement hydration omitted the exact asset: ' +
        JSON.stringify(hydration.hydratedDocument.assets)
    )
  }
  return { ...hydration, hydratedAsset }
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
  const expectedVisibleIdentity = session.hudAssetIdentityToken(evidence.expectedAssetId)
  for (const [phase, observation] of [
    ['before', before],
    ['after', after]
  ]) {
    const assetMatch = session.hudContainsAsset(observation.hud, evidence.expectedAssetId)
    if (
      assetMatch.matched !== true ||
      assetMatch.distance !== 0 ||
      assetMatch.expected !== expectedVisibleIdentity.toLowerCase() ||
      observation.windowTitle !== 'TaskWraith Studio'
    ) {
      throw new Error(
        'Studio lifecycle did not prove exact hydrated media at ' +
          phase +
          ': ' +
          JSON.stringify({ observation, recomputedAssetMatch: assetMatch })
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
  const expectedAssetPath = path.resolve(String(evidence.expectedAssetPath || ''))
  const hiddenReplacement = evidence.hiddenReplacement
  const hiddenWindows = hiddenReplacement?.windowProbe?.windows
  const hiddenJournal = hiddenReplacement?.journal
  const hydration = hiddenReplacement?.hydration
  const relevantHydrationHits = Array.isArray(hydration?.relevantHits)
    ? hydration.relevantHits.filter((hit) => hit?.childPid === after.process.pid)
    : []
  const helloIndex = relevantHydrationHits.findIndex(
    (hit) => hit?.kind === 'request-response' && hit?.method === 'studio/hello'
  )
  const documentIndex = relevantHydrationHits.findIndex(
    (hit) => hit?.kind === 'request-response' && hit?.method === 'studio/getDocument'
  )
  const eventIndex = relevantHydrationHits.findIndex(
    (hit) => hit?.kind === 'hydration-served-event' && hit?.method === 'studio/getDocument'
  )
  const hydrationEvent = eventIndex < 0 ? null : relevantHydrationHits[eventIndex]
  const hydratedDocument = hydrationEvent?.document
  const hydratedAsset = Array.isArray(hydratedDocument?.assets)
    ? hydratedDocument.assets.find((candidate) => candidate?.assetId === evidence.expectedAssetId)
    : null
  if (
    typeof evidence.expectedAssetPath !== 'string' ||
    !evidence.expectedAssetPath ||
    expectedAssetPath === path.parse(expectedAssetPath).root ||
    !Array.isArray(hiddenWindows) ||
    hiddenReplacement.windowProbe.pid !== after.process.pid ||
    hiddenReplacement.windowProbe.visibleWindowCount !== 0 ||
    hiddenWindows.length !== 0 ||
    !hiddenJournal ||
    hiddenJournal.beforeCount !== before.journalCount ||
    hiddenJournal.afterCount !== before.journalCount ||
    hiddenJournal.beforeDigest !== before.journalDigest ||
    hiddenJournal.afterDigest !== before.journalDigest ||
    helloIndex < 0 ||
    documentIndex <= helloIndex ||
    eventIndex <= documentIndex ||
    hydrationEvent?.hydrationRevision !== before.journalLastRevision ||
    hydrationEvent?.responseRevision !== before.journalLastRevision ||
    hydrationEvent?.hydratedChildMatches !== true ||
    hydrationEvent?.supervisorStatus?.pid !== after.process.pid ||
    !hydratedDocument ||
    !hydratedAsset ||
    path.resolve(String(hydratedAsset.path || '')) !== expectedAssetPath
  ) {
    throw new Error('Studio lifecycle did not prove invisible replacement hydration')
  }
  const explicitJournalDelta = evidence.explicitPresentation?.journalDelta
  const appendedEntries = explicitJournalDelta?.appendedEntries
  const appendedEntry =
    Array.isArray(appendedEntries) && appendedEntries.length === 1 ? appendedEntries[0] : null
  if (
    !explicitJournalDelta ||
    !Array.isArray(appendedEntries) ||
    appendedEntries.length !== 1 ||
    explicitJournalDelta.beforeCount !== before.journalCount ||
    explicitJournalDelta.afterCount !== after.journalCount ||
    explicitJournalDelta.beforeDigest !== before.journalDigest ||
    explicitJournalDelta.afterDigest !== after.journalDigest ||
    after.journalCount !== before.journalCount + appendedEntries.length ||
    before.journalDigest !== after.journalPrefixDigest ||
    appendedEntry?.op?.type !== 'open_media' ||
    appendedEntry.op.asset?.assetId !== evidence.expectedAssetId ||
    path.resolve(String(appendedEntry.op.asset?.path || '')) !== expectedAssetPath
  ) {
    throw new Error(
      'Studio lifecycle explicit reopen journal delta is not one exact same-asset open_media'
    )
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
    sourceWindowPresentedBeforeExplicitOpen: false,
    explicitOpenJournalDelta: explicitJournalDelta,
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

function assertUnchangedJournalAcrossReplacement(before, after) {
  const beforeBoundary = journalBoundary(before)
  const afterBoundary = journalBoundary(after)
  if (
    beforeBoundary.journalCount !== afterBoundary.journalCount ||
    beforeBoundary.journalDigest !== afterBoundary.journalDigest
  ) {
    throw new Error(
      'Studio lifecycle hidden replacement changed the durable journal: ' +
        JSON.stringify({ before: beforeBoundary, after: afterBoundary })
    )
  }
  return {
    beforeCount: beforeBoundary.journalCount,
    afterCount: afterBoundary.journalCount,
    beforeDigest: beforeBoundary.journalDigest,
    afterDigest: afterBoundary.journalDigest,
    journalUnchangedAcrossReplacement: true
  }
}

function assertExplicitOpenJournalDelta(before, after, asset) {
  const beforeBoundary = journalBoundary(before)
  const afterBoundary = journalBoundary(after, before.length)
  const appended = after.slice(before.length)
  const entry = appended.length === 1 ? appended[0] : null
  const sameAssetOpenMedia = Boolean(
    entry?.op?.type === 'open_media' &&
    entry.op.asset?.assetId === asset.sha256 &&
    path.resolve(String(entry.op.asset?.path || '')) === path.resolve(asset.assetPath)
  )
  if (appended.length !== 1 || !sameAssetOpenMedia) {
    throw new Error(
      'Studio lifecycle explicit reopen must append exactly one same-asset open_media: ' +
        JSON.stringify({ before: beforeBoundary, after: afterBoundary, appended })
    )
  }
  return {
    beforeCount: beforeBoundary.journalCount,
    afterCount: afterBoundary.journalCount,
    appendedCount: appended.length,
    beforeDigest: beforeBoundary.journalDigest,
    afterDigest: afterBoundary.journalDigest,
    assetId: asset.sha256,
    sameAssetOpenMedia: true,
    appendedEntries: appended
  }
}

function probeNativeWindowIncludingZero(pid, run = session.runExact) {
  const result = run(
    '/usr/bin/swift',
    [path.join(session.repoRoot, 'scripts', 'studio-acceptance-window-probe.swift'), String(pid)],
    { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }
  )
  const observed = JSON.parse(result.stdout)
  if (
    observed?.pid !== pid ||
    !Number.isSafeInteger(observed?.visibleWindowCount) ||
    observed.visibleWindowCount < 0 ||
    !Array.isArray(observed.windows) ||
    observed.windows.length !== observed.visibleWindowCount
  ) {
    throw new Error('Studio lifecycle raw window probe returned invalid data')
  }
  return observed
}

async function assertNoVisibleSourceWindow(companion, probe = probeNativeWindowIncludingZero) {
  try {
    const observed = await probe(companion.pid)
    const sourceWindows = Array.isArray(observed?.windows)
      ? observed.windows.filter((entry) => entry?.title === 'TaskWraith Studio')
      : []
    if (sourceWindows.length > 0) {
      throw new Error(
        'Studio lifecycle replacement presented a Source window before explicit reopen: ' +
          JSON.stringify(sourceWindows)
      )
    }
    return { sourceWindowPresentedBeforeExplicitOpen: false, observed }
  } catch (error) {
    if (error instanceof Error && /No on-screen native Studio window/.test(error.message)) {
      return {
        sourceWindowPresentedBeforeExplicitOpen: false,
        observed: { pid: companion.pid, visibleWindowCount: 0, windows: [] }
      }
    }
    throw error
  }
}

async function exactMediaObservation(plan, target, name, adapters = {}) {
  // A newly presented AppKit workspace can finish restoring its screen and
  // frame after WindowServer first exposes it. Refresh the exact window receipt
  // for every bounded attempt; the UI driver still re-verifies pid, id, title,
  // and bounds immediately before capture, so this tolerates only an observed
  // AppKit layout transition rather than weakening target custody.
  const window = await (adapters.waitForSourceWindow || session.waitForSourceWindow)(
    target.companion
  )
  const currentTarget = { ...target, window }
  const capture = await (adapters.captureNative || session.captureNative)(plan, currentTarget, name)
  const hud = (adapters.ocrScreenshot || session.ocrScreenshot)(capture.path)
  const assetMatch = (adapters.hudContainsAsset || session.hudContainsAsset)(
    hud,
    target.asset.sha256
  )
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
    window,
    windowTitle: target.expectedWindowTitle
  }
}

async function waitForExactMediaObservation(plan, target, name, options = {}) {
  const observe = options.observe || exactMediaObservation
  return waitFor(
    `exact hydrated Studio media for ${name}`,
    () => observe(plan, target, name),
    options.timeoutMs ?? 45_000,
    options.intervalMs ?? 500
  )
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
      const expectedHydratedRevision = beforeJournal.at(-1)?.revision
      if (!Number.isSafeInteger(expectedHydratedRevision) || expectedHydratedRevision < 1) {
        throw new Error('Studio lifecycle journal has no exact pre-replacement revision')
      }
      const beforeFocus = session.focusSnapshot(context.companion.pid)
      const beforeMedia = await waitForExactMediaObservation(plan, beforeTarget, 'lifecycle-before')
      const beforeProcess = session.exactCompanionProcess(context.companion, context.session.pgid)
      if (beforeProcess.ppid !== context.session.pid) {
        throw new Error('original Companion is not the exact Electron child')
      }

      const hydrationProbe = await (adapters.armHydrationProbe || armHydrationProbe)(
        context.mainInspector
      )
      const kill = adapters.kill || process.kill
      let replacement
      let hydrationEvidence
      try {
        kill(context.companion.pid, 'SIGKILL')
        await waitFor('old Studio Companion disappearance', () =>
          processExists(context.companion.pid) ? null : true
        )
        replacement = await (adapters.waitForReplacementCompanion || waitForReplacementCompanion)(
          context.session.pid,
          context.session.pgid,
          context.companion.pid
        )
        hydrationEvidence = await hydrationProbe.waitForHydration(
          replacement.candidate.pid,
          expectedHydratedRevision
        )
      } finally {
        await hydrationProbe.close()
      }
      hydrationEvidence = assertHydrationEvidence(
        { ...hydrationEvidence, breakpointDefinition: hydrationProbe.definition },
        replacement.candidate.pid,
        expectedHydratedRevision,
        runtime.asset
      )
      const hiddenWindow = await assertNoVisibleSourceWindow(
        replacement.candidate,
        adapters.probeNativeWindow || probeNativeWindowIncludingZero
      )
      const hiddenJournal = await harness.readStudioJournalOperations(plan)
      const hiddenJournalEvidence = assertUnchangedJournalAcrossReplacement(
        beforeJournal,
        hiddenJournal
      )
      const focusBeforeExplicitOpen = session.focusSnapshot(replacement.candidate.pid)
      const explicitOpen = await session.invokeStudioOpen(context.renderer, runtime.asset)
      const afterWindow = await session.waitForSourceWindow(replacement.candidate)
      const afterTarget = {
        companion: replacement.candidate,
        electronPgid: context.session.pgid,
        window: afterWindow,
        expectedWindowTitle: 'TaskWraith Studio',
        asset: runtime.asset
      }
      const afterMedia = await waitForExactMediaObservation(plan, afterTarget, 'lifecycle-after')
      const afterJournal = await harness.readStudioJournalOperations(plan)
      const explicitJournalDelta = assertExplicitOpenJournalDelta(
        hiddenJournal,
        afterJournal,
        runtime.asset
      )
      const afterFocus = session.focusSnapshot(replacement.candidate.pid)
      const explicitOpenFocus = session.assertSourceWindowFocusIsolation(
        focusBeforeExplicitOpen,
        afterFocus,
        replacement.candidate.pid
      )
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
        expectedAssetPath: runtime.asset.assetPath,
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
        },
        hiddenReplacement: {
          hydration: hydrationEvidence,
          windowProbe: hiddenWindow.observed,
          sourceWindowPresentedBeforeExplicitOpen:
            hiddenWindow.sourceWindowPresentedBeforeExplicitOpen,
          journalUnchangedAcrossReplacement:
            hiddenJournalEvidence.journalUnchangedAcrossReplacement,
          journal: hiddenJournalEvidence
        },
        explicitPresentation: {
          productionAction: 'studio:open',
          journalDelta: explicitJournalDelta,
          focus: explicitOpenFocus
        }
      }
      const verdict = adjudicateLifecycleEvidence(rawEvidence)
      return {
        openResult,
        explicitOpen,
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
  assertExplicitOpenJournalDelta,
  assertFocusHandoff,
  assertHydrationEvidence,
  assertNoVisibleSourceWindow,
  assertUnchangedJournalAcrossReplacement,
  armHydrationProbe,
  hydrationBreakpointDefinition,
  exactMediaObservation,
  parseLifecycleCli,
  probeNativeWindowIncludingZero,
  processExists,
  runBoundedLifecycle,
  waitForExactMediaObservation
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

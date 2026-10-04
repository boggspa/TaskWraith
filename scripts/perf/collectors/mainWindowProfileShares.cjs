'use strict'

/**
 * Where the app's main thread spent each measured live window of a capture.
 *
 * The capture's main CPU profile is cut at each window main itself timed (the
 * `mainWindow` receipt the live lanes record) and every sample inside is
 * counted towards the shares below. A share is a fraction of the time sampled
 * inside the window; shares other than idle and busy can overlap (a sync made
 * while preparing a record counts as both).
 *
 * - idle, busy: self time in `(idle)`, and the rest.
 * - sync: self time in the runtime's `fsync` / `fdatasync` frames, with its
 *   owner named from the functions above it (`SYNC_OWNERS`, first match).
 * - wholeThreadRead: time under `readJson` reached through `getChat` or
 *   `readChatRecordCached`, with the callers that asked. `allJsonRead` is all
 *   time under `readJson`, which also holds small files (the run queue).
 * - wholeThreadCopy: time under the Host record transfer.
 * - prepareForSave, transcriptHashing: time under the function each names.
 * - garbageCollection: self time in `(garbage collector)`.
 * - flusherBookkeeping: self time in frames of the durability flusher's class.
 *
 * Frame matching. A captured profile names bundled functions (`readJson$7`),
 * not sources: the main build emits no source map, so the path-qualified rules
 * of `mainGapProfileAttribution.cjs` cannot apply to it. Functions are matched on
 * their base name, the bundler's `$<suffix>` dropped. A class is matched by the
 * lines it spans in the built bundle the profile's frames point into, because
 * its method names (`pump`, `settle`, `snapshot`) are not its alone. Every
 * name a share matches is looked up in that build: a share whose function the
 * build no longer has is reported unmeasured, never as zero.
 *
 * Clock. A window main timed on `performance.now` is placed in the profile by
 * the calibration markers captured around it (`mainProfileCalibration.cjs`).
 * A capture older than the markers timed its windows on the wall clock; its
 * profile is placed by taking its end as the moment the runner asked for the
 * stop plus a nominal lag, and each share and sync owner is then also reported
 * across the lag's bounds so a reader sees how far the estimate could move it.
 */

const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { calibrateMainProfile, mapProfileIntervalBounds } = require('./mainProfileCalibration.cjs')

const SCHEMA_VERSION = 1

/** The runtime's sync calls; an app function of the same name is not one. */
const SYNC_FRAMES = new Set(['fsync', 'fdatasync', 'fsyncSync', 'fdatasyncSync'])
const READ_UNDER = 'readJson'
const READ_THROUGH = Object.freeze(['getChat', 'readChatRecordCached'])
const COPY_UNDER = 'publishHostThreadRecordTransferOffLoop'
const COPY_PARTS = Object.freeze(['canCloneRecord', 'postMessage'])
const PREPARE_UNDER = 'prepareChatForPersistence'
const HASHING_UNDER = 'computeChatSubRevisions'
/**
 * Who a sync belongs to, by the functions above it; the first row that
 * matches wins. Tool detail is first because its checkpoint appends a run
 * event of its own.
 */
const SYNC_OWNERS = Object.freeze([
  ['toolDetail', ['prepareChatForPersistence', 'persistDetailCheckpoint']],
  ['cataloguePublication', ['beginPublication', 'finishPublication', 'settleBurst']],
  ['journal', ['persistIncrementalChatForHostSave', 'checkpointChat']],
  ['runEvents', ['appendRunEvent']],
  ['runQueue', ['writeRunQueueJobs']]
])
/** Shares measured as self time in the frames of one bundled class. */
const CLASS_SHARES = Object.freeze({ flusherBookkeeping: 'MainDurabilityFlusher' })
/** The app functions each share needs the build to still have. */
const SHARE_NAMES = Object.freeze({
  wholeThreadRead: [READ_UNDER, ...READ_THROUGH],
  allJsonRead: [READ_UNDER],
  wholeThreadCopy: [COPY_UNDER, 'canCloneRecord'],
  prepareForSave: [PREPARE_UNDER],
  transcriptHashing: [HASHING_UNDER],
  syncOwners: SYNC_OWNERS.flatMap(([, names]) => names)
})

/** Frames that say nothing about who called. */
const UNNAMED_CALLERS = new Set([
  '(anonymous)',
  '(root)',
  'runMicrotasks',
  'processTicksAndRejections'
])
const MAX_READ_CALLERS = 8
/** How many of a read caller's own callers are named beside it. */
const READ_CALLER_VIA_DEPTH = 2
const MAX_SYNC_OTHER_CALLERS = 5
const SYNC_OTHER_CALLER_DEPTH = 3

/**
 * V8 leaves steps of a microsecond or two backwards in a profile (one to
 * seven in each of seven captures, 10 us in all at most). More than this in
 * total is a clock that cannot be trusted.
 */
const MAX_BACKWARDS_US = 1000
/** A window counts as covered when the profile sampled this much of it. */
const MIN_WINDOW_COVERAGE = 0.99
/**
 * A capture without markers: its profile is taken to have ended this long
 * after the runner asked for the stop (the renderer's profile is stopped
 * first). Measured with markers on six captures the lag was 0.36 to 0.44 s;
 * it cannot be negative, and the upper bound allows a main thread that was
 * slow to answer.
 */
const ESTIMATED_PROFILE_END = Object.freeze({ lagMs: 500, lagBoundsMs: Object.freeze([0, 3000]) })
/** A frame of the app's bundled main process, by its script's URL. */
const BUNDLED_MAIN_SCRIPT = /^file:\/\/.*\/out\/main\/[^/]+\.js$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function baseName(functionName) {
  return functionName ? functionName.replace(/\$[0-9a-z]+$/, '') : '(anonymous)'
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The file a script URL names, or null: a profile escapes what a path does not. */
function scriptPath(url) {
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

/**
 * The profile as a timeline of samples, each ending where the next begins.
 * `{ ok: false, reason }` for a profile that cannot be read as one.
 */
function readProfileTimeline(profile) {
  const malformed = { ok: false, reason: 'malformed' }
  if (
    !isPlainObject(profile) ||
    !Array.isArray(profile.nodes) ||
    !Array.isArray(profile.samples) ||
    !Array.isArray(profile.timeDeltas) ||
    profile.samples.length === 0 ||
    profile.samples.length !== profile.timeDeltas.length ||
    !Number.isFinite(profile.startTime) ||
    !Number.isFinite(profile.endTime) ||
    profile.endTime <= profile.startTime
  ) {
    return malformed
  }
  const frames = new Map()
  for (const node of profile.nodes) {
    if (
      !isPlainObject(node) ||
      !Number.isSafeInteger(node.id) ||
      frames.has(node.id) ||
      !isPlainObject(node.callFrame) ||
      typeof node.callFrame.functionName !== 'string' ||
      typeof node.callFrame.url !== 'string' ||
      (node.children !== undefined && !Array.isArray(node.children))
    ) {
      return malformed
    }
    frames.set(node.id, {
      name: baseName(node.callFrame.functionName),
      url: node.callFrame.url,
      line: node.callFrame.lineNumber
    })
  }
  const parents = new Map()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      if (!frames.has(child) || parents.has(child)) return malformed
      parents.set(child, node.id)
    }
  }
  // One root, and every node under it: a stack can then always be walked.
  const roots = profile.nodes.filter((node) => !parents.has(node.id))
  if (roots.length !== 1) return malformed
  const children = new Map(profile.nodes.map((node) => [node.id, node.children ?? []]))
  const reached = new Set([roots[0].id])
  for (const id of reached) for (const child of children.get(id)) reached.add(child)
  if (reached.size !== frames.size) return malformed

  const timeDeltas = new Array(profile.timeDeltas.length)
  const endUs = new Array(profile.timeDeltas.length)
  let cumulative = profile.startTime
  let end = profile.startTime
  let backwardsDeltas = 0
  let backwardsUs = 0
  for (let index = 0; index < profile.timeDeltas.length; index += 1) {
    const delta = profile.timeDeltas[index]
    if (!Number.isFinite(delta) || !frames.has(profile.samples[index])) return malformed
    if (delta < 0) {
      backwardsDeltas += 1
      backwardsUs -= delta
    }
    cumulative += delta
    const next = Math.max(end, cumulative)
    timeDeltas[index] = next - end
    end = next
    endUs[index] = end
  }
  if (backwardsUs > MAX_BACKWARDS_US) return { ok: false, reason: 'clock_runs_backwards' }
  return {
    ok: true,
    frames,
    parents,
    samples: profile.samples,
    startUs: profile.startTime,
    endUs,
    profileEndUs: profile.endTime,
    backwardsDeltas,
    backwardsUs,
    // The same profile with its steps backwards absorbed, for the calibration.
    monotonic: { ...profile, timeDeltas }
  }
}

/**
 * What the measured build says about the names the shares match: which are
 * gone, and the lines each class spans.
 */
function inspectBuild(buildScripts, unavailable) {
  if (!Array.isArray(buildScripts)) {
    return {
      summary: { scripts: 0, unavailable: unavailable || 'build_scripts_not_given' },
      missing: null,
      classRanges: new Map()
    }
  }
  const names = [...new Set(Object.values(SHARE_NAMES).flat())]
  const missing = new Set(
    names.filter((name) => {
      // Called or declared: `name(`, or `name = (` / `name = function` for an arrow.
      const used = new RegExp(
        `(?<![\\w$])${escapeRegExp(name)}(?:\\$[0-9a-z]+)?\\s*(?:\\(|=\\s*(?:async\\s*)?(?:\\(|function))`
      )
      return !buildScripts.some((script) => used.test(script.text))
    })
  )
  const classes = {}
  const classRanges = new Map()
  for (const className of new Set(Object.values(CLASS_SHARES))) {
    const range = findClassRange(buildScripts, className)
    if (range.found) {
      classRanges.set(className, range)
      classes[className] = {
        found: true,
        script: path.basename(range.path),
        firstLine: range.firstLine,
        lastLine: range.lastLine
      }
    } else classes[className] = range
  }
  return {
    summary: { scripts: buildScripts.length, missingNames: [...missing].sort(), classes },
    missing,
    classRanges
  }
}

/**
 * The zero-based lines a top-level class spans in the bundle. The bundler
 * writes one as `class Name {`, an indented body, and `}` at the margin; any
 * other layout is refused rather than guessed at.
 */
function findClassRange(scripts, className) {
  const named = new RegExp(`(?<![\\w$])class ${escapeRegExp(className)}(?![\\w$])`)
  const declared = new RegExp(
    `^(?:(?:let|const|var) [\\w$]+ = )?class ${escapeRegExp(className)}(?:\\$[0-9a-z]+)?(?: extends [^{]+)? \\{$`
  )
  let seen = false
  for (const script of scripts) {
    if (!named.test(script.text)) continue
    seen = true
    const lines = script.text.split('\n')
    const firstLine = lines.findIndex((line) => declared.test(line))
    const file = scriptPath(script.url)
    if (firstLine < 0 || file === null) continue
    for (let line = firstLine + 1; line < lines.length; line += 1) {
      if (/^\};?$/.test(lines[line])) {
        return { found: true, path: file, firstLine, lastLine: line }
      }
      // Anything else at the margin means the class did not close where expected.
      if (lines[line].length > 0 && !/^\s/.test(lines[line])) break
    }
    return { found: false, reason: 'class_layout_unrecognised' }
  }
  return { found: false, reason: seen ? 'class_layout_unrecognised' : 'class_not_in_build' }
}

/** What one profile node counts towards, worked out once per node. */
function createClassifier(timeline, classRanges) {
  const kinds = new Map()
  const paths = new Map()
  const pathOf = (url) => {
    if (!paths.has(url)) paths.set(url, scriptPath(url))
    return paths.get(url)
  }
  const classShareOf = (frame) => {
    for (const [share, className] of Object.entries(CLASS_SHARES)) {
      const range = classRanges.get(className)
      if (
        range &&
        frame.line >= range.firstLine &&
        frame.line <= range.lastLine &&
        pathOf(frame.url) === range.path
      ) {
        return share
      }
    }
    return null
  }
  return function classify(nodeId) {
    const known = kinds.get(nodeId)
    if (known) return known
    // The stack, root first.
    const stack = []
    for (let id = nodeId; id !== undefined; id = timeline.parents.get(id)) {
      stack.unshift(timeline.frames.get(id))
    }
    const names = stack.map((frame) => frame.name)
    const leaf = stack[stack.length - 1]
    const has = (name) => names.includes(name)
    const kind = {
      idle: leaf.name === '(idle)',
      gc: leaf.name === '(garbage collector)',
      sync: SYNC_FRAMES.has(leaf.name) && (leaf.url === '' || leaf.url.startsWith('node:')),
      syncOwner: null,
      syncOtherCallers: null,
      read: false,
      chatRead: false,
      readCaller: null,
      readCallerVia: null,
      copy: has(COPY_UNDER),
      copyParts: [],
      prepare: has(PREPARE_UNDER),
      hashing: has(HASHING_UNDER),
      classShare: classShareOf(leaf)
    }
    if (kind.sync) {
      const owner = SYNC_OWNERS.find(([, owners]) => owners.some(has))
      kind.syncOwner = owner ? owner[0] : 'other'
      if (!owner) {
        kind.syncOtherCallers = names
          .filter((name) => !SYNC_FRAMES.has(name) && !UNNAMED_CALLERS.has(name))
          .slice(-SYNC_OTHER_CALLER_DEPTH)
          .reverse()
          .join(' <- ')
      }
    }
    const readAt = names.indexOf(READ_UNDER)
    if (readAt >= 0) {
      kind.read = true
      const above = names.slice(0, readAt)
      kind.chatRead = READ_THROUGH.some((name) => above.includes(name))
      if (kind.chatRead) {
        const callers = above.filter(
          (name) => !READ_THROUGH.includes(name) && !UNNAMED_CALLERS.has(name)
        )
        kind.readCaller = callers.length > 0 ? callers[callers.length - 1] : '(unnamed)'
        kind.readCallerVia = callers
          .slice(-1 - READ_CALLER_VIA_DEPTH, -1)
          .reverse()
          .join(' <- ')
      }
    }
    if (kind.copy) kind.copyParts = COPY_PARTS.filter(has)
    kinds.set(nodeId, kind)
    return kind
  }
}

function add(map, key, value) {
  map.set(key, (map.get(key) || 0) + value)
}

/** Sum the samples inside [fromUs, toUs), each clipped to it. */
function sumInterval(timeline, classify, fromUs, toUs) {
  const sums = {
    total: 0,
    idle: 0,
    gc: 0,
    sync: 0,
    read: 0,
    chatRead: 0,
    copy: 0,
    prepare: 0,
    hashing: 0
  }
  const syncOwners = new Map()
  const syncOtherCallers = new Map()
  const readCallers = new Map()
  const readCallerVias = new Map()
  const copyParts = new Map()
  const classShares = new Map()
  // The first sample that ends after the interval starts.
  let low = 0
  let high = timeline.endUs.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (timeline.endUs[middle] > fromUs) high = middle
    else low = middle + 1
  }
  for (let index = low; index < timeline.endUs.length; index += 1) {
    const startUs = index === 0 ? timeline.startUs : timeline.endUs[index - 1]
    if (startUs >= toUs) break
    const us = Math.min(timeline.endUs[index], toUs) - Math.max(startUs, fromUs)
    if (us <= 0) continue
    const kind = classify(timeline.samples[index])
    sums.total += us
    if (kind.idle) sums.idle += us
    if (kind.gc) sums.gc += us
    if (kind.sync) {
      sums.sync += us
      add(syncOwners, kind.syncOwner, us)
      if (kind.syncOtherCallers !== null) add(syncOtherCallers, kind.syncOtherCallers, us)
    }
    if (kind.read) sums.read += us
    if (kind.chatRead) {
      sums.chatRead += us
      add(readCallers, kind.readCaller, us)
      if (!readCallerVias.has(kind.readCaller)) readCallerVias.set(kind.readCaller, new Map())
      add(readCallerVias.get(kind.readCaller), kind.readCallerVia, us)
    }
    if (kind.copy) sums.copy += us
    for (const part of kind.copyParts) add(copyParts, part, us)
    if (kind.prepare) sums.prepare += us
    if (kind.hashing) sums.hashing += us
    if (kind.classShare !== null) add(classShares, kind.classShare, us)
  }
  return {
    sums,
    syncOwners,
    syncOtherCallers,
    readCallers,
    readCallerVias,
    copyParts,
    classShares
  }
}

function topRows(map, total, limit, key) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, us]) => ({ [key]: name, share: round(us / total, 5) }))
}

/** The shares of one summed interval; a share the build cannot vouch for is null. */
function sharesOf(interval, build) {
  const { sums } = interval
  const share = (us) => round(us / sums.total, 5)
  const measurable = (name) =>
    build.missing === null || !SHARE_NAMES[name].some((needed) => build.missing.has(needed))
  const shares = {
    idle: share(sums.idle),
    busy: share(sums.total - sums.idle),
    sync: share(sums.sync),
    wholeThreadRead: measurable('wholeThreadRead') ? share(sums.chatRead) : null,
    allJsonRead: measurable('allJsonRead') ? share(sums.read) : null,
    wholeThreadCopy: measurable('wholeThreadCopy') ? share(sums.copy) : null,
    prepareForSave: measurable('prepareForSave') ? share(sums.prepare) : null,
    garbageCollection: share(sums.gc),
    transcriptHashing: measurable('transcriptHashing') ? share(sums.hashing) : null
  }
  for (const [name, className] of Object.entries(CLASS_SHARES)) {
    shares[name] = build.classRanges.has(className)
      ? share(interval.classShares.get(name) || 0)
      : null
  }
  return shares
}

function describeInterval(interval, build) {
  const { sums } = interval
  const shares = sharesOf(interval, build)
  const ownersMeasurable =
    build.missing === null || !SHARE_NAMES.syncOwners.some((name) => build.missing.has(name))
  const owners = {}
  for (const [owner] of [...SYNC_OWNERS, ['other']]) {
    owners[owner] = round((interval.syncOwners.get(owner) || 0) / sums.total, 5)
  }
  return {
    sampledMs: round(sums.total / 1000, 3),
    shares,
    syncOwners: ownersMeasurable ? owners : null,
    syncOtherCallers: ownersMeasurable
      ? topRows(interval.syncOtherCallers, sums.total, MAX_SYNC_OTHER_CALLERS, 'callers')
      : null,
    // Each caller with the callers it was most often reached through.
    wholeThreadReadCallers:
      shares.wholeThreadRead === null
        ? null
        : topRows(interval.readCallers, sums.total, MAX_READ_CALLERS, 'caller').map((row) => ({
            ...row,
            via: topRows(interval.readCallerVias.get(row.caller), sums.total, 1, 'via')[0].via
          })),
    wholeThreadCopyParts:
      shares.wholeThreadCopy === null
        ? null
        : Object.fromEntries(
            COPY_PARTS.map((part) => [
              part,
              round((interval.copyParts.get(part) || 0) / sums.total, 5)
            ])
          )
  }
}

/** The least and most each share is across placements of one window; null stays null. */
function boundsAcross(candidates) {
  const bounds = {}
  for (const name of Object.keys(candidates[0])) {
    const values = candidates.map((candidate) => candidate[name])
    bounds[name] = values.includes(null) ? null : [Math.min(...values), Math.max(...values)]
  }
  return bounds
}

function measureWindow(window, context) {
  const head = {
    id: isPlainObject(window) && typeof window.id === 'string' ? window.id : null,
    repetition: isPlainObject(window) && window.repetition !== undefined ? window.repetition : null
  }
  const unmeasured = (reason) => ({ ...head, measured: false, reason })
  if (
    !isPlainObject(window) ||
    !Number.isFinite(window.startedAtMs) ||
    !Number.isFinite(window.endedAtMs) ||
    window.endedAtMs <= window.startedAtMs
  ) {
    return unmeasured('main_window_receipt_absent')
  }
  const { timeline, build, classify } = context
  if (!timeline.ok) return unmeasured(`profile_unreadable:${timeline.reason}`)
  const windowMs = window.endedAtMs - window.startedAtMs
  const sum = (fromUs) => sumInterval(timeline, classify, fromUs, fromUs + windowMs * 1000)

  if (isPlainObject(window.clock)) {
    // Timed by main on performance.now: placed by the markers around it.
    const calibration = calibrateMainProfile(
      timeline.monotonic,
      context.markers.filter((marker) => isPlainObject(marker) && marker.windowId === head.id)
    )
    if (!calibration.qualified) {
      return unmeasured(`profile_calibration_unqualified:${calibration.reasons.join(',')}`)
    }
    if (calibration.anchors.some((anchor) => anchor.identity !== window.clock.identity)) {
      return unmeasured('window_clock_identity_mismatch')
    }
    // The envelope of both markers' offsets, as the calibration maps a time.
    const lower = Math.min(...calibration.anchors.map((anchor) => anchor.offsetLowerMs))
    const upper = Math.max(...calibration.anchors.map((anchor) => anchor.offsetUpperMs))
    const fromUs = (window.startedAtMs - (lower + upper) / 2) * 1000
    if (!mapProfileIntervalBounds(calibration, fromUs, fromUs + windowMs * 1000)) {
      return unmeasured('window_outside_calibrated_interval')
    }
    // Both markers were sampled, so the profile covers everything between them.
    return {
      ...head,
      measured: true,
      clock: { basis: 'markers', uncertaintyMs: (upper - lower) / 2 },
      windowMs: round(windowMs, 3),
      ...describeInterval(sum(fromUs), build)
    }
  }

  // Timed on the wall clock by a capture that recorded no markers.
  const stopRequestedAtMs = isPlainObject(context.capture)
    ? context.capture.stopRequestedAtMs
    : undefined
  if (!Number.isFinite(stopRequestedAtMs)) return unmeasured('profile_clock_unknown')
  const { lagMs, lagBoundsMs } = context.estimate
  const fromUsAt = (lag) =>
    timeline.profileEndUs - (stopRequestedAtMs + lag - window.startedAtMs) * 1000
  const interval = sum(fromUsAt(lagMs))
  const atBounds = lagBoundsMs.map((lag) => sum(fromUsAt(lag)))
  const covered = (candidate) => candidate.sums.total >= windowMs * 1000 * MIN_WINDOW_COVERAGE
  if (![interval, ...atBounds].every(covered)) return unmeasured('profile_does_not_cover_window')
  const described = describeInterval(interval, build)
  const candidates = [described, ...atBounds.map((bound) => describeInterval(bound, build))]
  return {
    ...head,
    measured: true,
    clock: {
      basis: 'estimated_profile_end',
      assumedLagMs: lagMs,
      lagBoundsMs: [...lagBoundsMs]
    },
    windowMs: round(windowMs, 3),
    ...described,
    shareBounds: boundsAcross(candidates.map((candidate) => candidate.shares)),
    syncOwnerBounds:
      described.syncOwners === null
        ? null
        : boundsAcross(candidates.map((candidate) => candidate.syncOwners))
  }
}

/**
 * @param {{
 *   profile: object,
 *   windows: Array<{ id: string|null, repetition?: number, startedAtMs?: number,
 *     endedAtMs?: number, clock?: { clockId: string, identity: string } }>,
 *   markers?: object[],
 *   capture?: { stopRequestedAtMs?: number },
 *   buildScripts?: Array<{ url: string, text: string }> | null,
 *   buildScriptsUnavailable?: string,
 *   estimate?: { lagMs: number, lagBoundsMs: [number, number] }
 * }} input
 */
function measureMainWindowProfileShares(input) {
  const timeline = readProfileTimeline(input.profile)
  const build = inspectBuild(input.buildScripts, input.buildScriptsUnavailable)
  const context = {
    timeline,
    build,
    classify: timeline.ok ? createClassifier(timeline, build.classRanges) : null,
    markers: Array.isArray(input.markers) ? input.markers : [],
    capture: input.capture,
    estimate: input.estimate ?? ESTIMATED_PROFILE_END
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    frameMatching: 'bundled_base_names_and_class_lines',
    profile: timeline.ok
      ? {
          samples: timeline.samples.length,
          durationMs: round((timeline.profileEndUs - timeline.startUs) / 1000, 3),
          backwardsDeltas: timeline.backwardsDeltas,
          backwardsUs: timeline.backwardsUs
        }
      : { unreadable: timeline.reason },
    build: build.summary,
    windows: input.windows.map((window) => measureWindow(window, context))
  }
}

/**
 * Each live window's receipt from main, as `measureMainWindowProfileShares`
 * takes it: a live-lane capture's windows, or a many-agent capture's (a run
 * drives one workload or the other).
 */
function mainWindowsOfReport(report) {
  const live = isPlainObject(report.liveRounds) ? report.liveRounds : {}
  const phase = [live.lanes, live.agents].find(
    (candidate) => isPlainObject(candidate) && Array.isArray(candidate.windows)
  )
  const windows = phase ? phase.windows : []
  return windows.map((window) => {
    const receipt = isPlainObject(window.mainWindow) ? window.mainWindow : {}
    return {
      id: typeof receipt.id === 'string' ? receipt.id : null,
      repetition: window.repetition,
      startedAtMs: receipt.startedAtMs,
      endedAtMs: receipt.endedAtMs,
      ...(isPlainObject(receipt.clock) ? { clock: receipt.clock } : {})
    }
  })
}

/**
 * The main-process scripts of the build a profile was taken from: every `.js`
 * beside the bundled scripts its frames name. `{ unavailable }` when they
 * cannot be read.
 */
function readBuildScripts(profile, fsApi = fs) {
  const directories = new Set()
  for (const node of Array.isArray(profile.nodes) ? profile.nodes : []) {
    const url = node?.callFrame?.url
    if (typeof url !== 'string' || !BUNDLED_MAIN_SCRIPT.test(url)) continue
    const file = scriptPath(url)
    if (file !== null) directories.add(path.dirname(file))
  }
  if (directories.size === 0) return { unavailable: 'build_scripts_not_in_profile' }
  try {
    const scripts = []
    for (const directory of directories) {
      for (const name of fsApi.readdirSync(directory)) {
        if (!name.endsWith('.js')) continue
        const file = path.join(directory, name)
        scripts.push({
          url: pathToFileURL(file).href,
          text: String(fsApi.readFileSync(file, 'utf8'))
        })
      }
    }
    return { scripts }
  } catch {
    return { unavailable: 'build_scripts_unreadable' }
  }
}

/**
 * Measure a capture on disk: its report, its main profile, the calibration
 * markers the runner retained and the build its frames point into.
 *
 * @param {string} captureDir
 * @param {{ fs?: { readFileSync: Function, readdirSync: Function }, estimate?: object }} [options]
 */
function mainWindowProfileSharesForCapture(captureDir, options = {}) {
  const fsApi = options.fs || fs
  const readJson = (...segments) => {
    try {
      return JSON.parse(String(fsApi.readFileSync(path.join(captureDir, ...segments), 'utf8')))
    } catch {
      return null
    }
  }
  const unavailable = (reason) => ({
    ...measureMainWindowProfileShares({ windows: [] }),
    unavailable: reason
  })
  const report = readJson('perf-t2-report.json')
  if (!isPlainObject(report)) return unavailable('report_unreadable')
  const profile = readJson('profiles', 'main.cpuprofile')
  if (!isPlainObject(profile)) return unavailable('cpu_profile_unreadable')
  const calibration = readJson('main-profile-calibration.json')
  const build = readBuildScripts(profile, fsApi)
  return measureMainWindowProfileShares({
    profile,
    windows: mainWindowsOfReport(report),
    markers: calibration?.calibration?.markers,
    capture: { stopRequestedAtMs: Date.parse(report.captureDeadline?.captureStartedAt) },
    buildScripts: build.scripts ?? null,
    buildScriptsUnavailable: build.unavailable,
    ...(options.estimate === undefined ? {} : { estimate: options.estimate })
  })
}

/**
 * The shares of a report the runner still holds: the profile is read from
 * the file it was written to, and the markers are the ones the runner kept
 * as the windows ran. A profile that cannot be read is named, and no window
 * is measured from it.
 *
 * @param {{
 *   report: object, profilePath: string, calibrationMarkers?: object[],
 *   fsApi?: { readFileSync: Function, readdirSync: Function }
 * }} input
 */
function mainWindowProfileSharesForReport({ report, profilePath, calibrationMarkers, fsApi = fs }) {
  let profile = null
  try {
    profile = JSON.parse(String(fsApi.readFileSync(profilePath, 'utf8')))
  } catch {
    profile = null
  }
  const readable = isPlainObject(profile)
  const build = readable ? readBuildScripts(profile, fsApi) : {}
  return {
    ...measureMainWindowProfileShares({
      profile,
      windows: mainWindowsOfReport(report),
      markers: calibrationMarkers,
      buildScripts: build.scripts ?? null,
      buildScriptsUnavailable: build.unavailable
    }),
    ...(readable ? {} : { unavailable: 'cpu_profile_unreadable' })
  }
}

module.exports = {
  ESTIMATED_PROFILE_END,
  mainWindowsOfReport,
  mainWindowProfileSharesForCapture,
  mainWindowProfileSharesForReport,
  measureMainWindowProfileShares,
  readBuildScripts
}

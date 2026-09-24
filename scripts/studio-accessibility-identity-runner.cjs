#!/usr/bin/env node
'use strict'

/**
 * Outcome 10's automatable boundary.
 *
 * This runner deliberately stops at Partial. Public AX APIs can prove exact
 * identity, structure, values and actions; they cannot prove what VoiceOver
 * spoke or what a human saw in Cmd-Tab. Those observations belong in a later,
 * separately recorded human checklist, never in caller-shaped booleans here.
 */

const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { isDeepStrictEqual, promisify } = require('node:util')

const harness = require('./studio-acceptance-harness.cjs')
const acceptanceSession = require('./studio-acceptance-session.cjs')

const execFilePromise = promisify(execFile)
const SCHEMA_VERSION = 1
const KIND = 'taskwraith-studio-accessibility-identity'
const PROBE_PATH = path.join(__dirname, 'studio-accessibility-identity-probe.swift')
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 3 * 60_000
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const FORBIDDEN_HUMAN_FIELDS = Object.freeze([
  'voiceOverPassed',
  'cmdTabPassed',
  'humanChecklist',
  'humanChecklistPath',
  'humanPassed'
])
const OPTION_FIELDS = new Set([
  'help',
  'launch',
  'acceptLaunch',
  'ownerConfirmsOrphansCleared',
  'dockOwner',
  'includeDock',
  'pretty',
  'instanceId',
  'artifactRoot',
  'packagedExecutablePath',
  'timeoutMs',
  'transcriptTimeoutMs'
])
const HUMAN_CHECKLIST_REQUIREMENTS = Object.freeze([
  'Direct Dock and Cmd-Tab observation for the owner-selected application identity',
  'VoiceOver reaches the exact TaskWraith Studio workspace window',
  'VoiceOver speaks route, comparison, transport, timecode and transcript state accurately',
  'VoiceOver operates Playback, Playhead and projected route/version controls',
  'Keyboard traversal, trim, Current/Proposed and Accept/Reject remain usable with VoiceOver running',
  'Opening and background AX operations do not steal focus; explicit keyboard focus restores exactly'
])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys, label) {
  invariant(isRecord(value), `${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  invariant(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} has an unexpected key set`
  )
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function measureApparatusCustody() {
  const files = [
    { role: 'runner', filePath: __filename },
    { role: 'probe', filePath: PROBE_PATH }
  ].map(({ role, filePath }) => {
    const resolved = path.resolve(filePath)
    const stat = fs.lstatSync(resolved)
    invariant(
      stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4 * 1024 * 1024,
      `Outcome 10 ${role} source is not a bounded regular file`
    )
    const bytes = fs.readFileSync(resolved)
    return {
      role,
      path: resolved,
      byteLength: bytes.byteLength,
      sha256: sha256Bytes(bytes)
    }
  })
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}-apparatus-custody`,
    files
  }
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value)
  invariant(
    Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `${label} is invalid`
  )
  return parsed
}

function originallyAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be absolute`)
  const resolved = path.resolve(value)
  invariant(resolved !== path.parse(resolved).root, `${label} is unbounded`)
  return resolved
}

function defaultArtifactRoot(instanceId) {
  return path.join(
    acceptanceSession.repoRoot,
    '.local-only',
    'taskwraith-studio',
    'acceptance',
    instanceId
  )
}

function parseCli(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const parsed = {
    help: false,
    launch: false,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    dockOwner: null,
    includeDock: true,
    pretty: false,
    instanceId: null,
    artifactRoot: null,
    packagedExecutablePath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    transcriptTimeoutMs: DEFAULT_TRANSCRIPT_TIMEOUT_MS
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared') {
      parsed.ownerConfirmsOrphansCleared = true
    } else if (argument === '--pretty') parsed.pretty = true
    else if (argument === '--no-dock-ax') parsed.includeDock = false
    else if (argument.startsWith('--dock-owner=')) parsed.dockOwner = argument.slice(13)
    else if (argument === '--dock-owner' && index + 1 < argv.length) {
      parsed.dockOwner = argv[++index]
    } else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument === '--instance-id' && index + 1 < argv.length) {
      parsed.instanceId = argv[++index]
    } else if (argument.startsWith('--artifact-root=')) parsed.artifactRoot = argument.slice(16)
    else if (argument === '--artifact-root' && index + 1 < argv.length) {
      parsed.artifactRoot = argv[++index]
    } else if (argument.startsWith('--packaged-executable=')) {
      parsed.packagedExecutablePath = argument.slice('--packaged-executable='.length)
    } else if (argument === '--packaged-executable' && index + 1 < argv.length) {
      parsed.packagedExecutablePath = argv[++index]
    } else if (argument.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = Number(argument.slice('--timeout-ms='.length))
    } else if (argument.startsWith('--transcript-timeout-ms=')) {
      parsed.transcriptTimeoutMs = Number(argument.slice('--transcript-timeout-ms='.length))
    } else {
      throw new Error(`unknown Outcome 10 argument: ${argument}`)
    }
  }
  return parsed
}

function normalizeOptions(options = {}) {
  invariant(isRecord(options), 'Outcome 10 options must be an object')
  for (const field of FORBIDDEN_HUMAN_FIELDS) {
    invariant(
      !Object.prototype.hasOwnProperty.call(options, field),
      `Outcome 10 refuses inline human verdict field ${field}`
    )
  }
  for (const field of Object.keys(options)) {
    invariant(OPTION_FIELDS.has(field), `Outcome 10 options contain unknown field ${field}`)
  }
  for (const field of [
    'help',
    'launch',
    'acceptLaunch',
    'ownerConfirmsOrphansCleared',
    'includeDock',
    'pretty'
  ]) {
    invariant(
      !Object.prototype.hasOwnProperty.call(options, field) || typeof options[field] === 'boolean',
      `Outcome 10 option ${field} must be boolean`
    )
  }
  invariant(
    options.dockOwner === 'host' || options.dockOwner === 'companion',
    'dockOwner is required'
  )
  const instanceId = options.instanceId || `o10-${process.pid}`
  invariant(INSTANCE_PATTERN.test(instanceId), 'instanceId is invalid')
  const artifactRoot = originallyAbsolute(
    options.artifactRoot || defaultArtifactRoot(instanceId),
    'artifactRoot'
  )
  const normalized = {
    launch: options.launch === true,
    acceptLaunch: options.acceptLaunch === true,
    ownerConfirmsOrphansCleared: options.ownerConfirmsOrphansCleared === true,
    dockOwner: options.dockOwner,
    includeDock: options.includeDock !== false,
    pretty: options.pretty === true,
    instanceId,
    artifactRoot,
    packagedExecutablePath:
      options.packagedExecutablePath == null
        ? null
        : originallyAbsolute(options.packagedExecutablePath, 'packagedExecutablePath'),
    timeoutMs: boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      60_000,
      30 * 60_000
    ),
    transcriptTimeoutMs: boundedInteger(
      options.transcriptTimeoutMs ?? DEFAULT_TRANSCRIPT_TIMEOUT_MS,
      'transcriptTimeoutMs',
      45_000,
      5 * 60_000
    )
  }
  invariant(
    normalized.transcriptTimeoutMs <= normalized.timeoutMs,
    'transcriptTimeoutMs exceeds watchdog timeoutMs'
  )
  if (normalized.launch) {
    invariant(normalized.acceptLaunch, 'launch requires --i-accept-studio-isolated-launch')
    invariant(
      normalized.ownerConfirmsOrphansCleared,
      'launch requires --owner-confirms-existing-orphans-cleared'
    )
    invariant(normalized.packagedExecutablePath, 'launch requires --packaged-executable')
    invariant(!fs.existsSync(artifactRoot), 'live launch requires a fresh artifact root')
  }
  return normalized
}

function buildPlan(options = {}) {
  const config = normalizeOptions(options)
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}-plan`,
    launched: false,
    ...config,
    fixture: { kind: 'tracked-deterministic-speech', generatedByHarness: true },
    apparatusCustody: measureApparatusCustody(),
    automatedScope: {
      exactSignedHostAndCompanionIdentity: true,
      exactActivationPolicy: true,
      exactWindowAndOrderedPublicAxTree: true,
      backgroundAxActions: ['Playback AXPress', 'Playhead AXIncrement', 'Source/Timeline AXPress'],
      packagedKeyboardActions: ['Tab'],
      focusAndCursorBrackets: true,
      dockAxMembership: config.includeDock
    },
    humanBoundary: {
      required: true,
      acceptedInlineVerdicts: false,
      requirements: HUMAN_CHECKLIST_REQUIREMENTS,
      maximumAutomatedStatus: 'partial'
    },
    knownAutomationGaps: [
      'Cmd-Tab membership has no stable direct query API',
      'VoiceOver speech, rotor and assistive focus require human observation',
      'Shared keyboard driver does not yet allow Escape, Delete, x, d, Shift-Tab or Shift-Right'
    ],
    safety: {
      planOnlyByDefault: true,
      explicitDockOwnerRequired: true,
      explicitLaunchInterlocks: true,
      harnessOwnsDisposableProfileWatchdogCustodyAndCleanup: true,
      neverTargetsInstalledTaskWraith: true,
      noCallerShapedHumanPass: true
    }
  }
}

function companionExecutable(command) {
  const match = /(^.*\/TaskWraithStudioCompanion)(?:\s|$)/.exec(String(command || ''))
  invariant(match && path.isAbsolute(match[1]), 'exact Companion executable is unavailable')
  invariant(
    !match[1].startsWith('/Applications/TaskWraith.app/'),
    'Outcome 10 refuses installed TaskWraith'
  )
  return path.resolve(match[1])
}

function buildProbeRequest(plan, target, config) {
  const exactTarget = harness.resolveStudioWorkspaceWindow(target)
  const exactWindow = exactTarget.window.windows[0]
  const hostPid = exactTarget.companion.ppid
  invariant(Number.isSafeInteger(hostPid) && hostPid > 0, 'exact host pid is unavailable')
  invariant(
    exactTarget.companion.pgid === exactTarget.electronPgid,
    'Companion and host process groups differ'
  )
  const hostExecutable = originallyAbsolute(plan.packagedExecutablePath, 'host executable')
  const companionPath = companionExecutable(exactTarget.companion.command)
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}-probe-request`,
    dockOwner: config.dockOwner,
    includeDock: config.includeDock,
    maximumDepth: 8,
    maximumElements: 512,
    host: {
      pid: hostPid,
      pgid: exactTarget.electronPgid,
      bundleIdentifier: 'com.chrisizatt.taskwraith',
      executablePath: hostExecutable,
      activationPolicy: config.dockOwner === 'host' ? 'regular' : 'accessory',
      dockLabel: 'TaskWraith'
    },
    companion: {
      pid: exactTarget.companion.pid,
      pgid: exactTarget.companion.pgid,
      bundleIdentifier: 'com.chrisizatt.taskwraith.studio',
      executablePath: companionPath,
      activationPolicy: config.dockOwner === 'companion' ? 'regular' : 'accessory',
      dockLabel: 'TaskWraith Studio'
    },
    window: {
      windowId: exactWindow.windowId,
      title: exactWindow.title,
      bounds: clone(exactWindow.bounds)
    }
  }
}

function validateBounds(value, label) {
  exactKeys(value, ['x', 'y', 'width', 'height'], label)
  for (const key of ['x', 'y', 'width', 'height']) {
    invariant(
      typeof value[key] === 'number' && Number.isFinite(value[key]),
      `${label}.${key} invalid`
    )
  }
  invariant(value.width > 0 && value.height > 0, `${label} is empty`)
}

function validateApplicationReceipt(actual, expected, label) {
  exactKeys(
    actual,
    [
      'pid',
      'pgid',
      'bundleIdentifier',
      'executablePath',
      'activationPolicy',
      'isActive',
      'dockLabel'
    ],
    label
  )
  invariant(
    actual.pid === expected.pid && actual.pgid === expected.pgid,
    `${label} pid/pgid changed`
  )
  invariant(
    actual.bundleIdentifier === expected.bundleIdentifier &&
      path.resolve(actual.executablePath) === path.resolve(expected.executablePath) &&
      actual.activationPolicy === expected.activationPolicy &&
      actual.dockLabel === expected.dockLabel &&
      typeof actual.isActive === 'boolean',
    `${label} identity or activation policy changed`
  )
}

function requiredElement(elements, predicate, label) {
  const matches = elements.filter(predicate)
  invariant(matches.length === 1, `${label} AX identity is missing or duplicated`)
  return matches[0]
}

function validateElements(elements) {
  invariant(
    Array.isArray(elements) && elements.length >= 12 && elements.length <= 512,
    'AX elements invalid'
  )
  const paths = new Set()
  for (const [index, element] of elements.entries()) {
    exactKeys(
      element,
      [
        'order',
        'path',
        'depth',
        'role',
        'identifier',
        'label',
        'value',
        'enabled',
        'valueSettable',
        'actions',
        'frame'
      ],
      `AX element ${index}`
    )
    invariant(element.order === index, `AX element ${index} order changed`)
    invariant(typeof element.path === 'string' && !paths.has(element.path), 'AX path duplicated')
    paths.add(element.path)
    invariant(
      Number.isSafeInteger(element.depth) && element.depth >= 0 && element.depth <= 8,
      'AX depth invalid'
    )
    invariant(
      element.path === 'window' || element.path.startsWith('window/'),
      'AX path is outside the exact window'
    )
    invariant(
      element.path.split('/').length - 1 === element.depth,
      'AX path/depth relationship changed'
    )
    invariant(
      (element.role === null || typeof element.role === 'string') &&
        (element.identifier === null || typeof element.identifier === 'string') &&
        (element.label === null || typeof element.label === 'string') &&
        (element.value === null || typeof element.value === 'string') &&
        (element.enabled === null || typeof element.enabled === 'boolean'),
      'AX element scalar field is invalid'
    )
    invariant(
      Array.isArray(element.actions) &&
        element.actions.every((item) => typeof item === 'string' && item.length > 0) &&
        new Set(element.actions).size === element.actions.length &&
        element.actions.every((item, actionIndex) =>
          actionIndex === 0 ? true : element.actions[actionIndex - 1] <= item
        ),
      'AX actions invalid'
    )
    invariant(typeof element.valueSettable === 'boolean', 'AX settable flag invalid')
    if (element.frame !== null) validateBounds(element.frame, `AX element ${index} frame`)
  }

  const byIdentifier = (identifier, role) => {
    const match = requiredElement(elements, (entry) => entry.identifier === identifier, identifier)
    invariant(match.role === role, `${identifier} AX role changed`)
    return match
  }
  const workspaceRoot = byIdentifier('studio.workspace.root', 'AXGroup')
  const sourceRoute = byIdentifier('studio.workspace.route.source', 'AXCheckBox')
  const timelineRoute = byIdentifier('studio.workspace.route.timeline', 'AXCheckBox')
  const currentVersion = byIdentifier('studio.workspace.review-version.current', 'AXRadioButton')
  const proposedVersion = byIdentifier('studio.workspace.review-version.proposed', 'AXRadioButton')
  const sourceViewer = byIdentifier('studio.workspace.viewer.source', 'AXGroup')
  const transcriptRail = byIdentifier('studio.workspace.transcript', 'AXGroup')
  const playhead = byIdentifier('Playhead', 'AXSlider')
  invariant(workspaceRoot.label === 'Studio workspace', 'Studio workspace AX label changed')
  invariant(sourceRoute.label === 'Source', 'Source route AX label changed')
  invariant(timelineRoute.label === 'Timeline', 'Timeline route AX label changed')
  invariant(currentVersion.label === 'Current', 'Current version AX label changed')
  invariant(proposedVersion.label === 'Proposed', 'Proposed version AX label changed')
  invariant(sourceViewer.label === 'Source viewer', 'Source viewer AX label changed')
  invariant(transcriptRail.label === 'Transcript', 'Transcript AX label changed')
  requiredElement(
    elements,
    (entry) => entry.label === 'Studio viewer' && entry.role === 'AXGroup',
    'Studio viewer'
  )
  requiredElement(
    elements,
    (entry) => entry.label === 'Timecode' && entry.role === 'AXStaticText',
    'Timecode'
  )
  requiredElement(
    elements,
    (entry) => entry.label === 'Loop marked range' && entry.role === 'AXStaticText',
    'Loop marked range'
  )
  for (const route of [sourceRoute, timelineRoute]) {
    invariant(route.enabled === true, `${route.identifier} is disabled`)
    invariant(route.actions.includes('AXPress'), `${route.identifier} is not pressable`)
  }
  const playback = byIdentifier('Playback', 'AXButton')
  invariant(playback.label === 'Playback', 'Playback AX label changed')
  invariant(playback.enabled === true, 'Playback is disabled')
  invariant(playback.actions.includes('AXPress'), 'Playback is not pressable')
  invariant(['playing', 'paused'].includes(playback.value), 'Playback value is invalid')
  invariant(playhead.enabled === true, 'Playhead is disabled')
  invariant(playhead.label === 'Playhead', 'Playhead AX label changed')
  invariant(playhead.valueSettable, 'Playhead is not settable')
  invariant(
    playhead.actions.includes('AXIncrement') && playhead.actions.includes('AXDecrement'),
    'Playhead increment/decrement actions are absent'
  )
  const transcriptButtons = elements.filter(
    (entry) =>
      entry.role === 'AXButton' &&
      entry.identifier !== 'Playback' &&
      ['Selected', 'Not selected'].includes(entry.value)
  )
  invariant(transcriptButtons.length > 0, 'transcript AX selection units are absent')
  return { sourceRoute, timelineRoute, playback, playhead, transcriptButtons }
}

function validateProbeReceipt(receipt, request) {
  exactKeys(
    receipt,
    [
      'schemaVersion',
      'kind',
      'dockOwner',
      'recordedAt',
      'host',
      'companion',
      'window',
      'elements',
      'dock',
      'focus'
    ],
    'probe receipt'
  )
  invariant(
    receipt.schemaVersion === SCHEMA_VERSION && receipt.kind === `${KIND}-probe-receipt`,
    'probe receipt schema identity is invalid'
  )
  invariant(receipt.dockOwner === request.dockOwner, 'probe dock owner changed')
  invariant(
    typeof receipt.recordedAt === 'string' && receipt.recordedAt.length > 0,
    'probe time missing'
  )
  validateApplicationReceipt(receipt.host, request.host, 'host')
  validateApplicationReceipt(receipt.companion, request.companion, 'companion')
  exactKeys(
    receipt.window,
    ['windowId', 'title', 'ownerName', 'bounds', 'accessibilityRole', 'accessibilityTitle'],
    'window receipt'
  )
  validateBounds(receipt.window.bounds, 'window bounds')
  invariant(
    receipt.window.windowId === request.window.windowId &&
      receipt.window.title === request.window.title &&
      receipt.window.ownerName === request.companion.dockLabel &&
      isDeepStrictEqual(receipt.window.bounds, request.window.bounds) &&
      receipt.window.accessibilityTitle === request.window.title &&
      receipt.window.accessibilityRole === 'AXWindow',
    'exact window identity changed'
  )
  const normalizedElements = validateElements(receipt.elements)
  exactKeys(receipt.dock, ['requested', 'available', 'dockPid', 'memberships'], 'Dock receipt')
  invariant(receipt.dock.requested === request.includeDock, 'Dock request changed')
  invariant(
    Array.isArray(receipt.dock.memberships) && receipt.dock.memberships.length === 2,
    'Dock memberships invalid'
  )
  const expectedMemberships = [
    { subject: 'host', label: request.host.dockLabel },
    { subject: 'companion', label: request.companion.dockLabel }
  ]
  for (const [index, membership] of receipt.dock.memberships.entries()) {
    exactKeys(membership, ['subject', 'label', 'matchCount'], 'Dock membership')
    invariant(
      membership.subject === expectedMemberships[index].subject &&
        membership.label === expectedMemberships[index].label,
      'Dock membership identity or order changed'
    )
    invariant(
      Number.isSafeInteger(membership.matchCount) && membership.matchCount >= 0,
      'Dock count invalid'
    )
  }
  invariant(typeof receipt.dock.available === 'boolean', 'Dock availability is invalid')
  invariant(
    receipt.dock.dockPid === null ||
      (Number.isSafeInteger(receipt.dock.dockPid) && receipt.dock.dockPid > 0),
    'Dock pid is invalid'
  )
  if (request.includeDock) {
    invariant(
      receipt.dock.available && Number.isSafeInteger(receipt.dock.dockPid),
      'Dock AX unavailable'
    )
    const expectedOwner = request.dockOwner
    const other = expectedOwner === 'host' ? 'companion' : 'host'
    const ownerMembership = receipt.dock.memberships.find(
      (entry) => entry.subject === expectedOwner
    )
    const otherMembership = receipt.dock.memberships.find((entry) => entry.subject === other)
    invariant(ownerMembership?.matchCount === 1, `${expectedOwner} Dock membership is not exact`)
    invariant(otherMembership?.matchCount === 0, `${other} unexpectedly appears in Dock`)
  } else {
    invariant(
      receipt.dock.available === false &&
        receipt.dock.dockPid === null &&
        receipt.dock.memberships.every((entry) => entry.matchCount === 0),
      'disabled Dock observation returned evidence'
    )
  }
  exactKeys(
    receipt.focus,
    [
      'frontmostPid',
      'frontmostBundleIdentifier',
      'cursorX',
      'cursorY',
      'hostIsActive',
      'companionIsActive'
    ],
    'probe focus'
  )
  invariant(
    Number.isSafeInteger(receipt.focus.frontmostPid) &&
      receipt.focus.frontmostPid > 0 &&
      typeof receipt.focus.frontmostBundleIdentifier === 'string' &&
      receipt.focus.frontmostBundleIdentifier.length > 0 &&
      Number.isFinite(receipt.focus.cursorX) &&
      Number.isFinite(receipt.focus.cursorY) &&
      receipt.focus.hostIsActive === receipt.host.isActive &&
      receipt.focus.companionIsActive === receipt.companion.isActive &&
      receipt.focus.companionIsActive === false &&
      receipt.focus.frontmostPid !== receipt.companion.pid &&
      (receipt.focus.frontmostPid === receipt.host.pid
        ? receipt.focus.hostIsActive === true &&
          receipt.focus.frontmostBundleIdentifier === receipt.host.bundleIdentifier
        : receipt.focus.hostIsActive === false),
    'probe focus identity is invalid'
  )
  return { receipt, ...normalizedElements }
}

function validateBoundProbe(probe, plan, target, config) {
  exactKeys(
    probe,
    ['request', 'receipt', 'requestPath', 'stdoutPath', 'stdoutSha256', 'stdoutByteLength'],
    'probe evidence'
  )
  const expectedRequest = buildProbeRequest(plan, target, config)
  invariant(isDeepStrictEqual(probe.request, expectedRequest), 'probe request is not runner-bound')
  const expectedRequestDirectory = path.join(plan.artifactRoot, 'outcome10-probe-requests')
  const expectedReceiptDirectory = path.join(plan.artifactRoot, 'outcome10-probe-receipts')
  const readBoundFile = (filePath, expectedDirectory, label, maximumBytes) => {
    invariant(
      typeof filePath === 'string' &&
        path.isAbsolute(filePath) &&
        path.dirname(path.resolve(filePath)) === path.resolve(expectedDirectory),
      `${label} path is outside the runner artifact root`
    )
    const stat = fs.lstatSync(filePath)
    invariant(
      stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes,
      `${label} is not a bounded regular file`
    )
    invariant(
      fs.realpathSync(path.dirname(filePath)) === fs.realpathSync(expectedDirectory),
      `${label} directory changed`
    )
    return fs.readFileSync(filePath)
  }
  const rawRequest = readBoundFile(
    probe.requestPath,
    expectedRequestDirectory,
    'probe request',
    64 * 1024
  )
  let recordedRequest
  try {
    recordedRequest = JSON.parse(rawRequest.toString('utf8'))
  } catch {
    throw new Error('probe request artifact is not JSON')
  }
  invariant(
    isDeepStrictEqual(recordedRequest, expectedRequest),
    'probe request artifact is not runner-bound'
  )
  const rawStdout = readBoundFile(
    probe.stdoutPath,
    expectedReceiptDirectory,
    'probe stdout',
    4 * 1024 * 1024
  )
  invariant(SHA256_HEX.test(probe.stdoutSha256), 'probe stdout digest is invalid')
  invariant(
    Number.isSafeInteger(probe.stdoutByteLength) &&
      probe.stdoutByteLength > 0 &&
      probe.stdoutByteLength <= 4 * 1024 * 1024 &&
      rawStdout.byteLength === probe.stdoutByteLength,
    'probe stdout length is invalid'
  )
  invariant(sha256Bytes(rawStdout) === probe.stdoutSha256, 'probe stdout digest changed')
  let recordedReceipt
  try {
    recordedReceipt = JSON.parse(rawStdout.toString('utf8'))
  } catch {
    throw new Error('probe stdout artifact is not JSON')
  }
  invariant(
    isDeepStrictEqual(recordedReceipt, probe.receipt),
    'probe receipt is not bound to raw stdout'
  )
  return validateProbeReceipt(probe.receipt, expectedRequest)
}

async function runIdentityProbe(plan, target, config, adapters = {}) {
  const request = buildProbeRequest(plan, target, config)
  const requestDirectory = path.join(plan.artifactRoot, 'outcome10-probe-requests')
  const receiptDirectory = path.join(plan.artifactRoot, 'outcome10-probe-receipts')
  await fsPromises.mkdir(requestDirectory, { recursive: true, mode: 0o700 })
  await fsPromises.mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
  const probeId = crypto.randomUUID()
  const requestPath = path.join(requestDirectory, `${probeId}.json`)
  const stdoutPath = path.join(receiptDirectory, `${probeId}.json`)
  await fsPromises.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  const runExec = adapters.execFile || execFilePromise
  const result = await runExec('/usr/bin/swift', [PROBE_PATH, requestPath], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8'
  })
  const stdout = String(result.stdout || '')
  invariant(Buffer.byteLength(stdout) <= 4 * 1024 * 1024, 'probe stdout is oversized')
  let receipt
  try {
    receipt = JSON.parse(stdout)
  } catch {
    throw new Error('accessibility identity probe did not return JSON')
  }
  validateProbeReceipt(receipt, request)
  await fsPromises.writeFile(stdoutPath, stdout, {
    mode: 0o600,
    flag: 'wx'
  })
  return {
    request,
    receipt,
    requestPath,
    stdoutPath,
    stdoutSha256: sha256Bytes(Buffer.from(stdout)),
    stdoutByteLength: Buffer.byteLength(stdout)
  }
}

function normalizeFocusSnapshot(snapshot, label, expectedTargetPid) {
  invariant(isRecord(snapshot), `${label} focus snapshot is absent`)
  invariant(snapshot.targetPid === expectedTargetPid, `${label} target pid changed`)
  invariant(
    Number.isSafeInteger(snapshot.frontmostPid) &&
      snapshot.frontmostPid > 0 &&
      typeof snapshot.frontmostBundleIdentifier === 'string' &&
      snapshot.frontmostBundleIdentifier.length > 0 &&
      snapshot.frontmostBundleIdentifier !== 'com.apple.loginwindow' &&
      snapshot.targetIsActive === false &&
      Number.isFinite(snapshot.cursorX) &&
      Number.isFinite(snapshot.cursorY) &&
      typeof snapshot.recordedAt === 'string' &&
      snapshot.recordedAt.length > 0 &&
      SHA256_HEX.test(snapshot.stdoutSha256),
    `${label} focus snapshot is invalid`
  )
  return {
    frontmostPid: snapshot.frontmostPid,
    frontmostBundleIdentifier: snapshot.frontmostBundleIdentifier,
    targetPid: snapshot.targetPid,
    targetIsActive: snapshot.targetIsActive,
    cursorX: snapshot.cursorX,
    cursorY: snapshot.cursorY,
    recordedAt: snapshot.recordedAt,
    stdoutSha256: snapshot.stdoutSha256
  }
}

function assertFocusPreserved(beforeRaw, afterRaw, targetPid, label, beforeTargetPid = targetPid) {
  const before = normalizeFocusSnapshot(beforeRaw, `${label} before`, beforeTargetPid)
  const after = normalizeFocusSnapshot(afterRaw, `${label} after`, targetPid)
  const focusPreserved =
    before.frontmostPid === after.frontmostPid &&
    before.frontmostBundleIdentifier === after.frontmostBundleIdentifier &&
    after.frontmostPid !== targetPid
  const cursorPreserved =
    Math.abs(before.cursorX - after.cursorX) <= 0.5 &&
    Math.abs(before.cursorY - after.cursorY) <= 0.5
  invariant(focusPreserved && cursorPreserved, `${label} stole focus or moved the cursor`)
  return { before, after, focusPreserved, cursorPreserved }
}

function keyActions(receipt) {
  return Array.isArray(receipt?.actions)
    ? receipt.actions.filter((action) => action?.type === 'key')
    : []
}

function selectedTranscriptPaths(probe) {
  return probe.receipt.elements
    .filter(
      (entry) =>
        entry.role === 'AXButton' && entry.identifier !== 'Playback' && entry.value === 'Selected'
    )
    .map((entry) => entry.path)
    .sort()
}

function adjudicateKeyboardEvidence(receipt, beforeProbe, afterProbe) {
  invariant(
    receipt?.inputDelivery === 'foreground-global-explicit',
    'keyboard receipt did not use explicit foreground delivery'
  )
  const actions = keyActions(receipt)
  invariant(actions.length === 1 && actions[0].key === 'tab', 'keyboard receipt is unadjudicated')
  const before = selectedTranscriptPaths(beforeProbe)
  const after = selectedTranscriptPaths(afterProbe)
  invariant(
    after.length === 1 && JSON.stringify(after) !== JSON.stringify(before),
    'Tab did not move transcript selection'
  )
  return {
    key: 'tab',
    effect: 'transcript-selection-changed',
    beforeSelectedPaths: before,
    afterSelectedPaths: after
  }
}

function validateKeyboardCoverage(receipts, adjudications) {
  const delivered = receipts.flatMap(keyActions).map((action) => action.key)
  const covered = adjudications.map((entry) => entry.key)
  invariant(
    delivered.length === covered.length && delivered.every((key, index) => key === covered[index]),
    'one or more keyboard actions have no independently recomputed adjudication'
  )
  return { delivered, adjudicated: covered }
}

async function runAutomatedJourney(plan, target, config, context = {}, adapters = {}) {
  const apparatusCustodyBefore = measureApparatusCustody()
  const exactTarget = harness.resolveStudioWorkspaceWindow(target)
  const targetPid = exactTarget.companion.pid
  const focusSnapshot = adapters.focusSnapshot || acceptanceSession.focusSnapshot
  const runProbe = adapters.runProbe || runIdentityProbe
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const readTranscriptStatus = adapters.readTranscriptStatus || context.readTranscriptStatus
  invariant(
    typeof readTranscriptStatus === 'function',
    'renderer transcript status reader is unavailable'
  )
  await (adapters.waitFor || harness.waitFor)({
    label: 'Outcome 10 available transcript',
    timeoutMs: config.transcriptTimeoutMs,
    intervalMs: 250,
    probe: async () => {
      const status = await readTranscriptStatus()
      return status?.assetId === target.asset.sha256 && status?.state === 'available'
        ? status
        : null
    }
  })

  const afterOpenFocus = await Promise.resolve(focusSnapshot(targetPid))
  const openFocus = assertFocusPreserved(
    context.focusBeforeOpen,
    afterOpenFocus,
    targetPid,
    'Studio open',
    0
  )
  const beforeProbe = await runProbe(plan, exactTarget, config, adapters.probeAdapters || {})

  const backgroundFocusBefore = await Promise.resolve(focusSnapshot(targetPid))
  const beforeState = validateBoundProbe(beforeProbe, plan, exactTarget, config)
  const initialPlayback = beforeState.playback.value
  const opposite = initialPlayback === 'paused' ? 'playing' : 'paused'
  const backgroundReceipt = await runDriver(
    plan,
    exactTarget,
    [
      {
        type: 'press-playback',
        playbackValueBefore: initialPlayback,
        playbackValueAfter: opposite
      },
      {
        type: 'press-playback',
        playbackValueBefore: opposite,
        playbackValueAfter: initialPlayback
      },
      { type: 'step-playhead-frame', playheadStepFrames: 1 },
      { type: 'press-workspace-route', route: 'timeline' },
      { type: 'press-workspace-route', route: 'timeline', selectedAfter: false }
    ],
    { inputDelivery: 'background-observation-only', allowForegroundInput: false }
  )
  const backgroundFocusAfter = await Promise.resolve(focusSnapshot(targetPid))
  const backgroundFocus = assertFocusPreserved(
    backgroundFocusBefore,
    backgroundFocusAfter,
    targetPid,
    'background AX actions'
  )
  const afterBackgroundProbe = await runProbe(
    plan,
    exactTarget,
    config,
    adapters.probeAdapters || {}
  )
  const afterBackground = validateBoundProbe(afterBackgroundProbe, plan, exactTarget, config)
  invariant(
    afterBackground.playback.value === initialPlayback,
    'Playback round trip did not return'
  )
  invariant(
    afterBackground.playhead.value !== beforeState.playhead.value,
    'Playhead AXIncrement did not persist'
  )
  invariant(
    afterBackground.sourceRoute.value === beforeState.sourceRoute.value &&
      afterBackground.timelineRoute.value === beforeState.timelineRoute.value,
    'workspace route AXPress round trip did not return'
  )

  const keyboardFocusBefore = await Promise.resolve(focusSnapshot(targetPid))
  const keyboardReceipt = await runDriver(plan, exactTarget, [{ type: 'key', key: 'tab' }], {
    inputDelivery: 'foreground-global-explicit',
    allowForegroundInput: true
  })
  const keyboardFocusAfter = await Promise.resolve(focusSnapshot(targetPid))
  const keyboardFocus = assertFocusPreserved(
    keyboardFocusBefore,
    keyboardFocusAfter,
    targetPid,
    'explicit keyboard restoration'
  )
  const afterKeyboardProbe = await runProbe(plan, exactTarget, config, adapters.probeAdapters || {})
  validateBoundProbe(afterKeyboardProbe, plan, exactTarget, config)
  const keyboardAdjudication = adjudicateKeyboardEvidence(
    keyboardReceipt,
    afterBackgroundProbe,
    afterKeyboardProbe
  )
  const keyboardCoverage = validateKeyboardCoverage([keyboardReceipt], [keyboardAdjudication])
  const apparatusCustodyAfter = measureApparatusCustody()
  invariant(
    isDeepStrictEqual(apparatusCustodyBefore, apparatusCustodyAfter),
    'Outcome 10 apparatus changed during the journey'
  )

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}-journey`,
    dockOwner: config.dockOwner,
    probes: {
      before: beforeProbe,
      afterBackground: afterBackgroundProbe,
      afterKeyboard: afterKeyboardProbe
    },
    focusIsolation: { open: openFocus, background: backgroundFocus, keyboard: keyboardFocus },
    backgroundActions: backgroundReceipt,
    keyboard: {
      receipts: [keyboardReceipt],
      adjudications: [keyboardAdjudication],
      coverage: keyboardCoverage
    },
    apparatusCustody: {
      before: apparatusCustodyBefore,
      after: apparatusCustodyAfter,
      unchanged: true
    },
    automated: { status: 'pass', promotionAuthorized: false },
    humanChecklist: {
      status: 'required-not-recorded',
      acceptedInlineVerdicts: false,
      requirements: HUMAN_CHECKLIST_REQUIREMENTS
    },
    outcomeStatus: 'partial',
    outcomePromotionAuthorized: false
  }
}

function assertHarnessBoundary(result) {
  invariant(
    result?.launched === true && result.evidence?.ok === true,
    'harness evidence is not Green'
  )
  const evidence = result.evidence
  exactKeys(
    evidence.journey?.apparatusCustody,
    ['before', 'after', 'unchanged'],
    'Outcome 10 apparatus custody'
  )
  invariant(
    evidence.journey?.kind === `${KIND}-journey` &&
      evidence.journey.automated?.status === 'pass' &&
      evidence.journey.automated?.promotionAuthorized === false &&
      evidence.journey.humanChecklist?.status === 'required-not-recorded' &&
      evidence.journey.humanChecklist?.acceptedInlineVerdicts === false &&
      evidence.journey.outcomeStatus === 'partial' &&
      evidence.journey.outcomePromotionAuthorized === false,
    'Outcome 10 journey overclaimed its automated evidence'
  )
  invariant(
    evidence.journey.apparatusCustody.unchanged === true &&
      isDeepStrictEqual(
        evidence.journey.apparatusCustody.before,
        evidence.journey.apparatusCustody.after
      ) &&
      isDeepStrictEqual(evidence.journey.apparatusCustody.after, measureApparatusCustody()),
    'Outcome 10 apparatus custody changed'
  )
  invariant(
    evidence.watchdogTerminal?.status === 'reaped' &&
      evidence.watchdogTerminal.groupExitVerified === true &&
      evidence.watchdogTerminal.detachedGroupExitVerified === true,
    'watchdog did not prove terminal reaping'
  )
  invariant(
    isRecord(evidence.custodyBefore) &&
      isDeepStrictEqual(evidence.custodyBefore, evidence.custodyAfter),
    'source/build custody changed during Outcome 10'
  )
  invariant(
    isRecord(evidence.packagedExecutionBefore) &&
      isDeepStrictEqual(evidence.packagedExecutionBefore, evidence.packagedExecutionAfter),
    'packaged execution custody changed during Outcome 10'
  )
  return evidence
}

async function runAccessibilityIdentityAcceptance(options = {}, adapters = {}) {
  const config = options.argv ? normalizeOptions(parseCli(options.argv)) : normalizeOptions(options)
  const plan = buildPlan(config)
  if (!config.launch) return plan
  let focusBeforeOpen = null
  const invokeOpen = async (renderer, asset, openOptions) => {
    const focusSnapshot = adapters.focusSnapshot || acceptanceSession.focusSnapshot
    focusBeforeOpen = await Promise.resolve(focusSnapshot(0))
    return (adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen)(
      renderer,
      asset,
      openOptions
    )
  }
  const runAcceptance = adapters.runStudioAcceptance || harness.runStudioAcceptance
  const result = await runAcceptance(
    {
      launch: true,
      acceptLaunch: true,
      ownerConfirmsOrphansCleared: true,
      instanceId: config.instanceId,
      packagedExecutablePath: config.packagedExecutablePath,
      generateSpeechFixture: true,
      mediaPath: null,
      mimeType: null,
      timeoutMs: config.timeoutMs,
      transcriptTimeoutMs: config.transcriptTimeoutMs
    },
    {
      planOptions: {
        artifactRoot: config.artifactRoot,
        instanceId: config.instanceId,
        packagedExecutablePath: config.packagedExecutablePath
      },
      invokeStudioOpen: invokeOpen,
      driveUiJourney: async (acceptancePlan, target, journeyAdapters) => {
        invariant(focusBeforeOpen, 'pre-open focus receipt is absent')
        return (adapters.runAutomatedJourney || runAutomatedJourney)(
          acceptancePlan,
          target,
          config,
          { focusBeforeOpen, readTranscriptStatus: journeyAdapters.readTranscriptStatus },
          { ...adapters, ...journeyAdapters }
        )
      }
    }
  )
  const evidence = assertHarnessBoundary(result)
  return {
    ...result,
    outcome10: {
      schemaVersion: SCHEMA_VERSION,
      kind: `${KIND}-result`,
      status: 'partial',
      automatedStatus: evidence.journey.automated.status,
      humanChecklistStatus: evidence.journey.humanChecklist.status,
      promotionAuthorized: false
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv)
  if (parsed.help) {
    process.stdout.write(
      'Usage: studio-accessibility-identity-runner.cjs --dock-owner=host|companion [--launch --i-accept-studio-isolated-launch --owner-confirms-existing-orphans-cleared --packaged-executable PATH]\n'
    )
    return { help: true }
  }
  const result = await runAccessibilityIdentityAcceptance(parsed)
  process.stdout.write(`${JSON.stringify(result, null, result.pretty ? 2 : 0)}\n`)
  return result
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[studio-accessibility-identity] FAIL — ${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSCRIPT_TIMEOUT_MS,
  FORBIDDEN_HUMAN_FIELDS,
  HUMAN_CHECKLIST_REQUIREMENTS,
  KIND,
  PROBE_PATH,
  SCHEMA_VERSION,
  adjudicateKeyboardEvidence,
  assertFocusPreserved,
  assertHarnessBoundary,
  buildPlan,
  buildProbeRequest,
  measureApparatusCustody,
  normalizeOptions,
  parseCli,
  runAccessibilityIdentityAcceptance,
  runAutomatedJourney,
  runIdentityProbe,
  validateElements,
  validateBoundProbe,
  validateKeyboardCoverage,
  validateProbeReceipt
}

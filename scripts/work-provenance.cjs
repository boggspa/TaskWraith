const { execFileSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const EVENT_SCHEMA_VERSION = 1
const PROJECTION_VERSION = 1
const CLASSIFIER_VERSION = 1
const STORE_DIRECTORY = path.join('taskwraith', 'work-provenance-v1')
const EVENTS_DIRECTORY = 'events'
const RECOVERY_REF_PREFIX = 'refs/taskwraith/work-provenance/'
const DEFAULT_QUERY_LIMIT = 200
const MAX_QUERY_LIMIT = 1_000
const MAX_DIRTY_PATHS = 1_000
const MAX_TEXT = 512
const MAX_EVENT_FILE_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 10_000

function git(root, args, extraEnv) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function gitQuiet(root, args, extraEnv) {
  try {
    return git(root, args, extraEnv)
  } catch {
    return null
  }
}

function gitBuffer(root, args, extraEnv) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function gitBufferQuiet(root, args, extraEnv) {
  try {
    return gitBuffer(root, args, extraEnv)
  } catch {
    return null
  }
}

function physicalPath(candidate) {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

function resolveWorkspaceIdentity(root) {
  const raw = gitQuiet(root, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir'
  ])
  if (!raw) return null
  const [rootLine, gitDirLine, commonDirLine] = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!rootLine || !gitDirLine || !commonDirLine) return null
  const repositoryRoot = physicalPath(path.resolve(root, rootLine))
  const gitDir = physicalPath(path.resolve(root, gitDirLine))
  const gitCommonDir = physicalPath(path.resolve(root, commonDirLine))
  return {
    root: repositoryRoot,
    gitDir,
    gitCommonDir,
    repositoryId: sha256(gitCommonDir),
    worktreeId: sha256(`${repositoryRoot}\0${gitDir}`)
  }
}

function eventDirectory(identity) {
  return path.join(identity.gitCommonDir, STORE_DIRECTORY, EVENTS_DIRECTORY)
}

function ensureEventDirectory(identity) {
  const taskWraith = path.join(identity.gitCommonDir, 'taskwraith')
  const provenance = path.join(identity.gitCommonDir, STORE_DIRECTORY)
  const events = eventDirectory(identity)
  for (const directory of [taskWraith, provenance, events]) {
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Work provenance path is not a physical directory: ${directory}`)
      }
    } else {
      try {
        fs.mkdirSync(directory, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Work provenance path is not a physical directory: ${directory}`)
      }
    }
    try {
      fs.chmodSync(directory, 0o700)
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }
  return events
}

function readEventRecords(identity) {
  const directory = eventDirectory(identity)
  let names
  try {
    names = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
  const records = []
  for (const name of names) {
    try {
      const eventPath = path.join(directory, name)
      const stat = fs.lstatSync(eventPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENT_FILE_BYTES) continue
      const bytes = fs.readFileSync(eventPath)
      const event = JSON.parse(bytes.toString('utf8'))
      if (
        event?.schemaVersion !== EVENT_SCHEMA_VERSION ||
        typeof event?.eventId !== 'string' ||
        typeof event?.recordedAt !== 'string' ||
        !validEventShape(event)
      ) {
        continue
      }
      records.push({
        name,
        digest: sha256(bytes),
        event
      })
    } catch {
      // A corrupt local receipt is isolated to that receipt.
    }
  }
  return records.sort(
    (left, right) =>
      String(left.event.recordedAt).localeCompare(String(right.event.recordedAt)) ||
      left.event.eventId.localeCompare(right.event.eventId)
  )
}

function validEventShape(event) {
  if (event.kind === 'origin') {
    return (
      safeEventPath(event.path) &&
      typeof event.workspace?.repositoryId === 'string' &&
      typeof event.workspace?.worktreeId === 'string' &&
      event.after &&
      typeof event.after === 'object'
    )
  }
  if (event.kind === 'resolution') return typeof event.originEventId === 'string'
  return (
    event.kind === 'recovery' &&
    typeof event.originEventId === 'string' &&
    event.eventId === `recovery-${sha256(event.originEventId)}` &&
    typeof event.recovery?.ref === 'string' &&
    /^refs\/taskwraith\/work-provenance\/[a-f0-9]{40}$/.test(event.recovery.ref) &&
    /^[a-f0-9]{40,64}$/.test(event.recovery?.commit || '') &&
    /^[a-f0-9]{40,64}$/.test(event.recovery?.tree || '')
  )
}

function safeEventPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes('\0') &&
    !path.posix.isAbsolute(value) &&
    !value.split('/').includes('..') &&
    value !== '.git' &&
    !value.startsWith('.git/')
  )
}

function writeEventImmutable(identity, event) {
  const directory = ensureEventDirectory(identity)
  const safeId = String(event.eventId).replace(/[^A-Za-z0-9._-]+/g, '-')
  const destination = path.join(directory, `${safeId}.json`)
  const temporary = path.join(directory, `.${safeId}.${process.pid}.${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(event, null, 2)}\n`
  let descriptor = null
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, serialized, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    try {
      fs.linkSync(temporary, destination)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existingText = fs.readFileSync(destination, 'utf8')
      let equivalent = existingText === serialized
      if (!equivalent) {
        try {
          equivalent = isDeepStrictEqual(
            eventIdentityPayload(JSON.parse(existingText)),
            eventIdentityPayload(event)
          )
        } catch {
          equivalent = false
        }
      }
      if (!equivalent) {
        throw new Error(`Work provenance event identity collision: ${event.eventId}`)
      }
    }
    try {
      const directoryDescriptor = fs.openSync(directory, 'r')
      try {
        fs.fsyncSync(directoryDescriptor)
      } finally {
        fs.closeSync(directoryDescriptor)
      }
    } catch {
      // Some filesystems reject directory fsync; the immutable link still wins.
    }
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // The immutable destination remains authoritative.
      }
    }
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // A stale dotfile is ignored by the event reader.
    }
  }
}

function eventIdentityPayload(event) {
  if (!event || typeof event !== 'object') return event
  const { recordedAt: _recordedAt, ...identity } = event
  if (identity.kind === 'recovery' && identity.recovery && typeof identity.recovery === 'object') {
    const { pinnedAt: _pinnedAt, ...recoveryIdentity } = identity.recovery
    return { ...identity, recovery: recoveryIdentity }
  }
  return identity
}

function boundedText(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/[\0\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized ? normalized.slice(0, MAX_TEXT) : undefined
}

function markerActor(marker, observationId) {
  return compactObject({
    sessionId: boundedText(marker.session),
    taskId: boundedText(marker.taskId || marker.chatId || marker.session),
    runId: boundedText(marker.runId),
    chatId: boundedText(marker.chatId),
    chatTitle: boundedText(marker.task || marker.chatTitle || marker.owner),
    provider: boundedText(marker.provider || marker.agent),
    participantId: boundedText(marker.participantId),
    participantRole: boundedText(marker.participantRole),
    laneId: boundedText(marker.laneId),
    displayName: boundedText(marker.owner || marker.task || marker.chatTitle || marker.agent),
    markerFile: boundedText(marker.file),
    markerObservationId: boundedText(observationId),
    lockOwnerId: boundedText(marker.lockOwnerId),
    authorityInstanceId: boundedText(marker.authorityInstanceId),
    processBirthReceiptHash: boundedText(marker.processBirthReceiptHash)
  })
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null)
  )
}

function fingerprintPath(targetPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const before = fs.lstatSync(targetPath)
      let fingerprint
      if (before.isFile()) {
        fingerprint = {
          state: 'file',
          sha256: sha256File(targetPath),
          sizeBytes: before.size
        }
      } else if (before.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(targetPath)
        fingerprint = {
          state: 'symlink',
          linkTarget,
          sha256: sha256(linkTarget)
        }
      } else if (before.isDirectory()) {
        fingerprint = { state: 'directory' }
      } else {
        fingerprint = { state: 'other' }
      }
      const after = fs.lstatSync(targetPath)
      if (sameStat(before, after)) return fingerprint
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing' }
      if (attempt === 1) return { state: 'unreadable' }
    }
  }
  return { state: 'unstable' }
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function sameStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function fingerprintKey(fingerprint) {
  if (!fingerprint) return 'none'
  return JSON.stringify([
    fingerprint.state,
    fingerprint.sha256 || '',
    fingerprint.sizeBytes ?? -1,
    fingerprint.linkTarget || ''
  ])
}

function sameFingerprint(left, right) {
  return fingerprintKey(left) === fingerprintKey(right)
}

function dirtyFingerprintMap(root, dirtyEntries) {
  const map = new Map()
  for (const entry of (dirtyEntries || []).slice(0, MAX_DIRTY_PATHS)) {
    if (!entry?.path || entry.path === '.git' || entry.path.startsWith('.git/')) continue
    map.set(entry.path, {
      status: entry.status,
      renamedFrom: entry.renamedFrom || null,
      mtimeMs: entry.mtimeMs ?? null,
      fingerprint: fingerprintPath(path.join(root, entry.path))
    })
  }
  return map
}

function markerObservationSnapshot(marker, observationId, claimedDirty, now) {
  const dirtySnapshot = claimedDirty.map((entry) => ({
    path: entry.path,
    status: entry.status,
    renamedFrom: entry.renamedFrom || null,
    mtimeMs: entry.mtimeMs ?? null,
    fingerprint: entry.fingerprint
  }))
  return {
    observationId,
    identityKey: markerIdentityKey(marker),
    file: marker.file,
    present: true,
    firstObservedAt: new Date(now).toISOString(),
    lastObservedAt: new Date(now).toISOString(),
    lastSeen: null,
    marker: {
      session: marker.session || null,
      taskId: marker.taskId || null,
      task: marker.task || null,
      chatId: marker.chatId || null,
      chatTitle: marker.chatTitle || null,
      agent: marker.agent || null,
      owner: marker.owner || null,
      runId: marker.runId || null,
      provider: marker.provider || null,
      participantId: marker.participantId || null,
      participantRole: marker.participantRole || null,
      laneId: marker.laneId || null,
      lockOwnerId: marker.lockOwnerId || null,
      authorityInstanceId: marker.authorityInstanceId || null,
      processBirthReceiptHash: marker.processBirthReceiptHash || null,
      derived: marker.derived === true,
      started: marker.started || null,
      worktree: marker.worktree || null,
      paths: [...(marker.paths || [])]
    },
    baselineDirty: dirtySnapshot,
    claimedDirty: dirtySnapshot,
    provenanceEventIds: []
  }
}

function markerIdentityKey(marker) {
  return JSON.stringify([
    marker.file || '',
    marker.lockOwnerId || '',
    marker.runId || '',
    marker.session || '',
    marker.started || '',
    marker.worktree || '',
    marker.workspaceWide === true,
    [...(marker.paths || [])].sort()
  ])
}

function normalizeSidecar(raw) {
  if (raw?.schemaVersion === 2 && raw.markers && raw.tombstones) {
    return {
      schemaVersion: 2,
      markers: { ...raw.markers },
      tombstones: { ...raw.tombstones }
    }
  }
  return { schemaVersion: 2, markers: {}, tombstones: {}, legacy: raw || {} }
}

function advanceMarkerObservations({ root, markers, dirty, previousSidecar, now, pidAlive }) {
  const previous = normalizeSidecar(previousSidecar)
  const next = { schemaVersion: 2, markers: {}, tombstones: { ...previous.tombstones } }
  const dirtyMap = dirtyFingerprintMap(root, dirty)
  const seenFiles = new Set()
  for (const marker of markers) {
    seenFiles.add(marker.file)
    const markerRoot = physicalPath(path.resolve(root, marker.worktree || root))
    const claimsThisRoot = markerRoot === physicalPath(root)
    const claimed = [...dirtyMap.entries()]
      .filter(([dirtyPath]) => claimsThisRoot && marker.matchers.some((match) => match(dirtyPath)))
      .map(([dirtyPath, evidence]) => ({ path: dirtyPath, ...evidence }))
    const prior = previous.markers[marker.file]
    const legacy = previous.legacy?.[marker.file]
    const sameObservation = prior?.identityKey === markerIdentityKey(marker)
    if (prior && !sameObservation) {
      next.tombstones[prior.observationId] = {
        ...prior,
        present: false,
        vanishedAt: new Date(now).toISOString()
      }
    }
    const observationId = sameObservation ? prior.observationId : `marker-${randomUUID()}`
    const snapshot = markerObservationSnapshot(marker, observationId, claimed, now)
    const newestClaimed = claimed.reduce(
      (latest, entry) => Math.max(latest, Number(entry.mtimeMs) || 0),
      0
    )
    const previousLastSeen = Number(
      (sameObservation ? prior?.lastSeen : undefined) ?? legacy?.lastSeen
    )
    snapshot.firstObservedAt =
      (sameObservation && prior?.firstObservedAt) || snapshot.firstObservedAt
    snapshot.baselineDirty = sameObservation
      ? [...(prior?.baselineDirty || prior?.claimedDirty || [])]
      : snapshot.baselineDirty
    snapshot.lastSeen =
      Math.max(
        Number.isFinite(previousLastSeen) ? previousLastSeen : 0,
        newestClaimed,
        pidAlive(marker.pid) ? now : 0
      ) || null
    snapshot.provenanceEventIds = sameObservation ? [...(prior.provenanceEventIds || [])] : []
    next.markers[marker.file] = snapshot
    // Preserve the v1 top-level heartbeat entry while Observatory and older
    // work-guard builds migrate to the versioned marker/tombstone envelope.
    next[marker.file] = {
      lastSeen: snapshot.lastSeen,
      session: marker.session || null,
      claimedDirty: claimed.length
    }
  }
  for (const [file, prior] of Object.entries(previous.markers)) {
    if (seenFiles.has(file)) continue
    next.tombstones[prior.observationId] = {
      ...prior,
      present: false,
      vanishedAt: prior.vanishedAt || new Date(now).toISOString()
    }
  }
  return next
}

function actorIdentity(actor) {
  const durableIdentity = [
    actor?.runId || '',
    actor?.participantId || '',
    actor?.laneId || '',
    actor?.taskId || actor?.chatId || '',
    actor?.sessionId || '',
    actor?.processBirthReceiptHash || '',
    actor?.lockOwnerId || '',
    actor?.authorityInstanceId || ''
  ]
  if (durableIdentity.some(Boolean)) {
    return JSON.stringify(['durable-contributor', ...durableIdentity])
  }
  return JSON.stringify([
    'observation-contributor',
    actor?.markerObservationId || '',
    actor?.provider || '',
    actor?.displayName || ''
  ])
}

function originMatchesCurrent(origin, current) {
  return Boolean(current && sameFingerprint(origin.after, current.fingerprint))
}

function originEventFromTombstone(
  identity,
  tombstone,
  entry,
  confidence,
  now,
  predecessorOriginEventId
) {
  const marker = { file: tombstone.file, ...(tombstone.marker || {}) }
  const baseline = (tombstone.baselineDirty || []).find(
    (candidate) => candidate.path === entry.path
  )
  const preexistingDirty = Boolean(baseline)
  const observedChange = !baseline || !sameFingerprint(baseline.fingerprint, entry.fingerprint)
  const eventId = `origin-marker-${sha256(
    `${tombstone.observationId}\0${entry.path}\0${fingerprintKey(entry.fingerprint)}`
  )}`
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    kind: 'origin',
    // The event ID is deterministic so a crash between immutable publication
    // and sidecar update can retry safely. Its timestamp must be deterministic
    // too, otherwise the same identity would collide with different bytes.
    recordedAt: tombstone.vanishedAt || tombstone.lastObservedAt || new Date(now).toISOString(),
    confidence,
    source: 'work-guard-marker',
    workspace: identity,
    path: entry.path,
    ...(baseline ? { before: baseline.fingerprint } : {}),
    after: entry.fingerprint,
    actor: markerActor(marker, tombstone.observationId),
    ...(predecessorOriginEventId ? { predecessorOriginEventId } : {}),
    operation: {
      id: tombstone.observationId,
      name: observedChange
        ? 'marker-closed-with-dirty-work'
        : 'marker-closed-with-preexisting-dirt',
      outcome: observedChange ? 'marker-vanished' : 'no-observed-change',
      exclusive: false,
      preexistingDirty
    }
  }
}

function resolutionEvent(origin, reason, now, successorOriginEventId, actor) {
  const eventId = `resolution-${sha256(
    `${origin.eventId}\0${reason}\0${successorOriginEventId || ''}`
  )}`
  return compactObject({
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    kind: 'resolution',
    recordedAt: new Date(now).toISOString(),
    originEventId: origin.eventId,
    reason,
    actor,
    successorOriginEventId
  })
}

function recoveryRefFor(originEventId) {
  return `${RECOVERY_REF_PREFIX}${sha256(originEventId).slice(0, 40)}`
}

function recoveryEventMatchesOrigin(event, origin) {
  return (
    event?.kind === 'recovery' &&
    origin?.kind === 'origin' &&
    event.originEventId === origin.eventId &&
    event.recovery?.ref === recoveryRefFor(origin.eventId)
  )
}

function snapshotIdentity(root, snapshot) {
  if (!snapshot?.ok || !snapshot.ref) return null
  const commit = (snapshot.commit || gitQuiet(root, ['rev-parse', snapshot.ref]))?.trim()
  if (!commit) return null
  const tree = gitQuiet(root, ['rev-parse', `${commit}^{tree}`])?.trim()
  return tree ? { ref: snapshot.ref, commit, tree } : null
}

function pinRecovery(root, identity, origin, snapshot, now) {
  const source = snapshotIdentity(root, snapshot)
  if (!source) return null
  const ref = recoveryRefFor(origin.eventId)
  const existing = gitQuiet(root, ['rev-parse', '--verify', ref])?.trim()
  if (existing && existing !== source.commit) return null
  if (!existing) {
    const objectFormat = gitQuiet(root, ['rev-parse', '--show-object-format'])?.trim()
    const zero = '0'.repeat(objectFormat === 'sha256' ? 64 : 40)
    if (gitQuiet(root, ['update-ref', ref, source.commit, zero]) === null) return null
  }
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `recovery-${sha256(origin.eventId)}`,
    kind: 'recovery',
    recordedAt: new Date(now).toISOString(),
    originEventId: origin.eventId,
    recovery: {
      ref,
      commit: source.commit,
      tree: source.tree,
      pinnedAt: new Date(now).toISOString()
    }
  }
}

function reconcileWorkProvenance({ root, dirty, sidecar, snapshot, now }) {
  const identity = resolveWorkspaceIdentity(root)
  if (!identity) return { sidecar, writtenEventIds: [] }
  const current = dirtyFingerprintMap(identity.root, dirty)
  const writtenEventIds = []
  let records = readEventRecords(identity)
  const origins = () =>
    records
      .map((record) => record.event)
      .filter(
        (event) => event.kind === 'origin' && event.workspace?.worktreeId === identity.worktreeId
      )
  const resolutions = () =>
    new Map(
      records
        .map((record) => record.event)
        .filter((event) => event.kind === 'resolution')
        .map((event) => [event.originEventId, event])
    )

  const tombstoneCandidates = []
  for (const tombstone of Object.values(sidecar.tombstones || {})) {
    if ((tombstone.provenanceEventIds || []).length > 0) continue
    for (const claimed of tombstone.claimedDirty || []) {
      const live = current.get(claimed.path)
      const exact = live
        ? origins().find(
            (origin) =>
              origin.path === claimed.path &&
              origin.confidence === 'exact' &&
              sameFingerprint(origin.after, claimed.fingerprint) &&
              originMatchesCurrent(origin, live)
          )
        : null
      if (exact) {
        tombstone.provenanceEventIds = [exact.eventId]
        continue
      }
      tombstoneCandidates.push({ tombstone, claimed })
    }
  }
  const candidateCounts = new Map()
  for (const candidate of tombstoneCandidates) {
    const key = `${candidate.claimed.path}\0${fingerprintKey(candidate.claimed.fingerprint)}`
    candidateCounts.set(key, (candidateCounts.get(key) || 0) + 1)
  }
  for (const candidate of tombstoneCandidates) {
    const key = `${candidate.claimed.path}\0${fingerprintKey(candidate.claimed.fingerprint)}`
    const baseline = (candidate.tombstone.baselineDirty || []).find(
      (entry) => entry.path === candidate.claimed.path
    )
    const observedChange =
      !baseline || !sameFingerprint(baseline.fingerprint, candidate.claimed.fingerprint)
    const predecessor = baseline
      ? origins()
          .filter(
            (origin) =>
              origin.path === candidate.claimed.path &&
              sameFingerprint(origin.after, baseline.fingerprint) &&
              !resolutions().has(origin.eventId) &&
              origin.recordedAt <= candidate.tombstone.firstObservedAt
          )
          .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]
      : null
    const confidence = !observedChange
      ? 'unknown'
      : candidateCounts.get(key) > 1
        ? 'ambiguous'
        : 'correlated-claim'
    const event = originEventFromTombstone(
      identity,
      candidate.tombstone,
      candidate.claimed,
      confidence,
      now,
      predecessor?.eventId
    )
    writeEventImmutable(identity, event)
    candidate.tombstone.provenanceEventIds = [
      ...(candidate.tombstone.provenanceEventIds || []),
      event.eventId
    ]
    writtenEventIds.push(event.eventId)
  }

  records = readEventRecords(identity)
  const resolved = resolutions()
  const originList = origins()
  const currentMarkers = Object.values(sidecar.markers || {})
  for (const origin of originList) {
    if (resolved.has(origin.eventId)) continue
    const live = current.get(origin.path)
    if (!live) {
      const working = fingerprintPath(path.join(identity.root, origin.path))
      const reason =
        origin.before && sameFingerprint(working, origin.before)
          ? 'reverted'
          : sameFingerprint(working, origin.after)
            ? 'committed'
            : 'clean'
      const event = resolutionEvent(origin, reason, now)
      writeEventImmutable(identity, event)
      writtenEventIds.push(event.eventId)
      continue
    }
    if (originMatchesCurrent(origin, live)) continue
    const successor = originList
      .filter(
        (candidate) =>
          candidate.eventId !== origin.eventId &&
          candidate.path === origin.path &&
          candidate.recordedAt >= origin.recordedAt &&
          originMatchesCurrent(candidate, live) &&
          !resolved.has(candidate.eventId)
      )
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]
    if (successor) {
      const reason =
        actorIdentity(successor.actor) === actorIdentity(origin.actor) ? 'superseded' : 'adopted'
      const event = resolutionEvent(
        origin,
        reason,
        now,
        successor.eventId,
        reason === 'adopted' ? successor.actor : undefined
      )
      writeEventImmutable(identity, event)
      writtenEventIds.push(event.eventId)
      continue
    }
    const adopter = currentMarkers.find((entry) => {
      const claimed = (entry.claimedDirty || []).find((candidate) => candidate.path === origin.path)
      const startedMs = Date.parse(entry.marker?.started || entry.firstObservedAt || '')
      return (
        claimed &&
        sameFingerprint(claimed.fingerprint, live.fingerprint) &&
        Number(claimed.mtimeMs) > startedMs &&
        actorIdentity(markerActor({ file: entry.file, ...entry.marker }, entry.observationId)) !==
          actorIdentity(origin.actor)
      )
    })
    if (adopter) {
      const marker = { file: adopter.file, ...adopter.marker }
      const adoptedOrigin = {
        ...originEventFromTombstone(
          identity,
          adopter,
          {
            path: origin.path,
            status: live.status,
            fingerprint: live.fingerprint
          },
          'correlated-claim',
          now,
          origin.eventId
        ),
        eventId: `origin-adoption-${sha256(
          `${adopter.observationId}\0${origin.eventId}\0${fingerprintKey(live.fingerprint)}`
        )}`,
        predecessorOriginEventId: origin.eventId,
        actor: markerActor(marker, adopter.observationId),
        operation: {
          id: adopter.observationId,
          name: 'marker-adopted-existing-dirt',
          outcome: 'adopted',
          exclusive: false,
          preexistingDirty: true
        }
      }
      writeEventImmutable(identity, adoptedOrigin)
      const adoption = resolutionEvent(
        origin,
        'adopted',
        now,
        adoptedOrigin.eventId,
        adoptedOrigin.actor
      )
      writeEventImmutable(identity, adoption)
      writtenEventIds.push(adoptedOrigin.eventId, adoption.eventId)
      continue
    }
    // The bytes changed again without another defensible contributor receipt.
    // Close the stale attribution and let the query expose the current dirt as
    // unknown instead of leaving an exact-but-no-longer-matching origin pinned.
    const superseded = resolutionEvent(origin, 'superseded', now)
    writeEventImmutable(identity, superseded)
    writtenEventIds.push(superseded.eventId)
  }

  records = readEventRecords(identity)
  const finalResolved = new Set(
    records
      .map((record) => record.event)
      .filter((event) => event.kind === 'resolution')
      .map((event) => event.originEventId)
  )
  const recoveries = new Map(
    records
      .map((record) => record.event)
      .filter(
        (event) =>
          event.kind === 'recovery' && event.recovery?.ref === recoveryRefFor(event.originEventId)
      )
      .map((event) => [event.originEventId, event])
  )
  for (const origin of records
    .map((record) => record.event)
    .filter(
      (event) => event.kind === 'origin' && event.workspace?.worktreeId === identity.worktreeId
    )) {
    if (finalResolved.has(origin.eventId)) {
      const recovery = recoveries.get(origin.eventId)
      if (recoveryEventMatchesOrigin(recovery, origin)) {
        gitQuiet(root, ['update-ref', '-d', recovery.recovery.ref])
      }
      continue
    }
    if (!originMatchesCurrent(origin, current.get(origin.path)) || recoveries.has(origin.eventId)) {
      continue
    }
    const recovery = pinRecovery(root, identity, origin, snapshot, now)
    if (!recovery) continue
    writeEventImmutable(identity, recovery)
    writtenEventIds.push(recovery.eventId)
  }
  const finalRecords = readEventRecords(identity).map((record) => record.event)
  const finalResolutionIds = new Set(
    finalRecords.filter((event) => event.kind === 'resolution').map((event) => event.originEventId)
  )
  for (const [observationId, tombstone] of Object.entries(sidecar.tombstones || {})) {
    const eventIds = tombstone.provenanceEventIds || []
    if (eventIds.length === 0 || eventIds.every((eventId) => finalResolutionIds.has(eventId))) {
      delete sidecar.tombstones[observationId]
    }
  }
  return { sidecar, writtenEventIds }
}

function parseDirtyEntries(root, raw) {
  const fields = raw.split('\0')
  const entries = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 4) continue
    const status = field.slice(0, 2)
    const targetPath = field.slice(3)
    let renamedFrom = null
    if (status[0] === 'R' || status[0] === 'C') {
      renamedFrom = fields[index + 1] || null
      index += 1
    }
    if (!targetPath) continue
    let mtimeMs = null
    try {
      mtimeMs = fs.statSync(path.join(root, targetPath)).mtimeMs
    } catch {
      // Deleted paths are still dirty, merely ageless.
    }
    entries.push({
      status,
      path: targetPath,
      mtimeMs,
      ...(renamedFrom ? { renamedFrom } : {})
    })
  }
  return entries
}

function parseNumstat(raw) {
  const fields = raw.split('\0')
  const deltas = new Map()
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index]
    if (!header) continue
    const firstTab = header.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : header.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additionsText = header.slice(0, firstTab)
    const deletionsText = header.slice(firstTab + 1, secondTab)
    let targetPath = header.slice(secondTab + 1)
    let renamedFrom = null
    if (!targetPath) {
      renamedFrom = fields[index + 1] || null
      targetPath = fields[index + 2] || ''
      index += 2
    }
    if (!targetPath) continue
    const binary = additionsText === '-' || deletionsText === '-'
    const additions = binary ? null : Number(additionsText)
    const deletions = binary ? null : Number(deletionsText)
    deltas.set(targetPath, {
      path: targetPath,
      renamedFrom,
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
      binary
    })
  }
  return deltas
}

function fingerprintMapDigest(current) {
  return sha256(
    JSON.stringify(
      [...current.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([targetPath, entry]) => [
          targetPath,
          entry.status,
          entry.renamedFrom,
          fingerprintKey(entry.fingerprint)
        ])
    )
  )
}

function buildPathDeltas(dirty, numstat) {
  return dirty
    .map((entry) => {
      const tracked = numstat.get(entry.path)
      return {
        path: entry.path,
        status: entry.status,
        renamedFrom: entry.renamedFrom || tracked?.renamedFrom || null,
        additions: tracked?.additions ?? null,
        deletions: tracked?.deletions ?? null,
        binary: tracked?.binary === true,
        untracked: entry.status === '??'
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function captureGitGeneration(root, options = {}) {
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts) || 3))
  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headBefore = gitQuiet(root, ['rev-parse', 'HEAD'])?.trim() || null
    const statusBefore = gitBufferQuiet(root, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all'
    ])
    const numstatBefore = gitBufferQuiet(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      'HEAD',
      '--'
    ])
    if (!statusBefore || !numstatBefore) {
      const observedAt = new Date(options.now || Date.now()).toISOString()
      return {
        id: sha256(JSON.stringify([headBefore, observedAt, 'unavailable'])),
        coherent: false,
        reason: 'Git status or numstat was unavailable.',
        attempt,
        observedAt,
        headCommit: headBefore,
        statusDigest: null,
        numstatDigest: null,
        fingerprintDigest: null,
        dirty: [],
        current: new Map(),
        pathDeltas: []
      }
    }
    const dirty = parseDirtyEntries(root, statusBefore.toString('utf8'))
    const firstCurrent = dirtyFingerprintMap(root, dirty)
    const secondCurrent = dirtyFingerprintMap(root, dirty)
    const numstatAfter = gitBufferQuiet(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      'HEAD',
      '--'
    ])
    const statusAfter = gitBufferQuiet(root, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all'
    ])
    const headAfter = gitQuiet(root, ['rev-parse', 'HEAD'])?.trim() || null
    const statusDigest = sha256(statusBefore)
    const numstatDigest = sha256(numstatBefore)
    const fingerprintDigest = fingerprintMapDigest(secondCurrent)
    const stable =
      headBefore === headAfter &&
      Boolean(statusAfter?.equals(statusBefore)) &&
      Boolean(numstatAfter?.equals(numstatBefore)) &&
      fingerprintMapDigest(firstCurrent) === fingerprintDigest
    const pathDeltas = buildPathDeltas(dirty, parseNumstat(numstatBefore.toString('utf8')))
    const observedAt = new Date(options.now || Date.now()).toISOString()
    const generationId = sha256(
      JSON.stringify([
        headBefore,
        statusDigest,
        numstatDigest,
        fingerprintDigest,
        stable ? 'coherent' : 'unstable'
      ])
    )
    last = {
      id: generationId,
      coherent: stable,
      reason: stable ? null : 'The worktree changed while the Git generation was sampled.',
      attempt,
      observedAt,
      headCommit: headBefore,
      statusDigest,
      numstatDigest,
      fingerprintDigest,
      dirty,
      current: secondCurrent,
      pathDeltas
    }
    if (stable) return last
  }
  return last
}

function deltaSummary(pathDeltas) {
  return pathDeltas.reduce(
    (summary, entry) => {
      summary.files += 1
      if (entry.untracked) summary.untrackedFiles += 1
      else summary.trackedFiles += 1
      if (entry.binary) summary.binaryFiles += 1
      if (entry.additions !== null) summary.additions += entry.additions
      if (entry.deletions !== null) summary.deletions += entry.deletions
      return summary
    },
    {
      files: 0,
      trackedFiles: 0,
      untrackedFiles: 0,
      binaryFiles: 0,
      additions: 0,
      deletions: 0
    }
  )
}

function buildAttributionPartition(pathDeltas, workItems) {
  const itemsByPath = new Map()
  for (const item of workItems.filter((candidate) => candidate.currentDirty)) {
    const current = itemsByPath.get(item.path)
    if (!current || preferCanonicalCurrentWorkItem(item, current)) {
      itemsByPath.set(item.path, item)
    }
  }
  const buckets = {
    unique: [],
    sharedAmbiguous: [],
    unclaimedUnknown: []
  }
  for (const delta of pathDeltas) {
    const item = itemsByPath.get(delta.path)
    const contributorCount = item?.currentContributors?.filter(
      (contributor) => contributor.confidence !== 'unknown'
    ).length
    const bucket =
      !item || item.confidence === 'unknown'
        ? 'unclaimedUnknown'
        : item.confidence === 'ambiguous' || contributorCount > 1
          ? 'sharedAmbiguous'
          : 'unique'
    buckets[bucket].push({
      ...delta,
      workItemId: item?.workItemId || null,
      confidence: item?.confidence || 'unknown',
      contributorCount: contributorCount || 0
    })
  }
  const root = deltaSummary(pathDeltas)
  const unique = deltaSummary(buckets.unique)
  const sharedAmbiguous = deltaSummary(buckets.sharedAmbiguous)
  const unclaimedUnknown = deltaSummary(buckets.unclaimedUnknown)
  const combined = deltaSummary([
    ...buckets.unique,
    ...buckets.sharedAmbiguous,
    ...buckets.unclaimedUnknown
  ])
  return {
    root,
    unique: { ...unique, paths: buckets.unique },
    sharedAmbiguous: { ...sharedAmbiguous, paths: buckets.sharedAmbiguous },
    unclaimedUnknown: { ...unclaimedUnknown, paths: buckets.unclaimedUnknown },
    invariant: {
      files: combined.files === root.files,
      additions: combined.additions === root.additions,
      deletions: combined.deletions === root.deletions,
      satisfied:
        combined.files === root.files &&
        combined.additions === root.additions &&
        combined.deletions === root.deletions
    }
  }
}

function preferCanonicalCurrentWorkItem(candidate, current) {
  const candidateContributors = candidate.currentContributors?.length || 0
  const currentContributors = current.currentContributors?.length || 0
  if (candidateContributors !== currentContributors) {
    return candidateContributors > currentContributors
  }
  const candidateLineage = candidate.lineageOriginEventIds?.length || 0
  const currentLineage = current.lineageOriginEventIds?.length || 0
  if (candidateLineage !== currentLineage) return candidateLineage > currentLineage
  const candidateConfidence = confidenceStrength(candidate.confidence)
  const currentConfidence = confidenceStrength(current.confidence)
  if (candidateConfidence !== currentConfidence) return candidateConfidence > currentConfidence
  const candidateObservedAt = candidate.lastObservedAt || ''
  const currentObservedAt = current.lastObservedAt || ''
  if (candidateObservedAt !== currentObservedAt) return candidateObservedAt > currentObservedAt
  return String(candidate.workItemId) < String(current.workItemId)
}

function queryWorkProvenance(root, options = {}) {
  const identity = resolveWorkspaceIdentity(root)
  if (!identity) return emptyProjection(root)
  const limit = Math.min(
    MAX_QUERY_LIMIT,
    Math.max(1, Math.floor(Number(options.limit) || DEFAULT_QUERY_LIMIT))
  )
  const records = readEventRecords(identity)
  const generation = captureGitGeneration(identity.root, { now: options.now })
  const current = generation.current
  const resolutions = new Map(
    records
      .map((record) => record.event)
      .filter((event) => event.kind === 'resolution')
      .map((event) => [event.originEventId, event])
  )
  const recoveries = new Map(
    records
      .map((record) => record.event)
      .filter(
        (event) =>
          event.kind === 'recovery' && event.recovery?.ref === recoveryRefFor(event.originEventId)
      )
      .map((event) => [event.originEventId, event])
  )
  const markerRows = options.markers || []
  const worktreeOrigins = records
    .map((record) => record.event)
    .filter(
      (event) => event.kind === 'origin' && event.workspace?.worktreeId === identity.worktreeId
    )
  const originsById = new Map(worktreeOrigins.map((origin) => [origin.eventId, origin]))
  const adoptedPredecessorsBySuccessor = new Map()
  for (const resolution of resolutions.values()) {
    if (resolution.reason !== 'adopted' || !resolution.successorOriginEventId) continue
    const predecessors = adoptedPredecessorsBySuccessor.get(resolution.successorOriginEventId) || []
    predecessors.push(resolution.originEventId)
    adoptedPredecessorsBySuccessor.set(resolution.successorOriginEventId, predecessors)
  }
  const groups = new Map()
  for (const origin of worktreeOrigins) {
    const key = `${origin.path}\0${fingerprintKey(origin.after)}`
    const group = groups.get(key) || {
      workItemId: `work-${sha256(`${identity.worktreeId}\0${key}`)}`,
      path: origin.path,
      origins: []
    }
    group.origins.push(origin)
    groups.set(key, group)
  }
  for (const [dirtyPath, evidence] of current) {
    const key = `${dirtyPath}\0${fingerprintKey(evidence.fingerprint)}`
    const matchingGroup = groups.get(key)
    if (matchingGroup?.origins.some((origin) => !resolutions.has(origin.eventId))) continue
    const unknownKey = `${key}\0current-unknown`
    groups.set(unknownKey, {
      workItemId: `work-${sha256(`${identity.worktreeId}\0${unknownKey}`)}`,
      path: dirtyPath,
      origins: [],
      syntheticUnknown: true
    })
  }
  const workItems = [...groups.values()].map((group) => {
    const originRows = group.origins
      .map((origin) => ({
        origin,
        resolution: resolutions.get(origin.eventId) || null,
        recovery: recoveries.get(origin.eventId) || null
      }))
      .sort((left, right) => left.origin.recordedAt.localeCompare(right.origin.recordedAt))
    const currentEvidence = current.get(group.path)
    const unresolved = originRows.filter(
      (row) => !row.resolution && originMatchesCurrent(row.origin, currentEvidence)
    )
    const matchingLiveMarkers = group.syntheticUnknown
      ? markerRows.filter(
          (row) =>
            row.state?.live &&
            markerTargetsWorktree(row, identity.root) &&
            row.marker?.matchers?.some((match) => match(group.path))
        )
      : []
    const lineageRows = []
    const lineageSeen = new Set(originRows.map((row) => row.origin.eventId))
    const continuitySeeds = matchingLiveMarkers
      .map((markerRow) => {
        const markerActorIdentity = actorIdentity(
          markerActor(markerRow.marker, markerRow.observationId)
        )
        const origin = worktreeOrigins
          .filter(
            (candidate) =>
              candidate.path === group.path &&
              (candidate.actor?.markerObservationId === markerRow.observationId ||
                actorIdentity(candidate.actor) === markerActorIdentity)
          )
          .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]
        return origin || null
      })
      .filter(Boolean)
    const lineageQueue = unresolved.map((row) => row.origin)
    for (const seed of continuitySeeds) {
      if (lineageSeen.has(seed.eventId)) continue
      lineageSeen.add(seed.eventId)
      lineageRows.push({
        origin: seed,
        resolution: resolutions.get(seed.eventId) || null,
        recovery: recoveries.get(seed.eventId) || null
      })
      lineageQueue.push(seed)
    }
    while (lineageQueue.length) {
      const successor = lineageQueue.shift()
      const predecessorIds = [
        successor.predecessorOriginEventId,
        ...(adoptedPredecessorsBySuccessor.get(successor.eventId) || [])
      ].filter(Boolean)
      for (const predecessorId of predecessorIds) {
        if (lineageSeen.has(predecessorId)) continue
        const predecessor = originsById.get(predecessorId)
        if (!predecessor || predecessor.path !== group.path) continue
        lineageSeen.add(predecessorId)
        lineageRows.push({
          origin: predecessor,
          resolution: resolutions.get(predecessor.eventId) || null,
          recovery: recoveries.get(predecessor.eventId) || null
        })
        lineageQueue.push(predecessor)
      }
    }
    const openRows = originRows.filter((row) => !row.resolution)
    const currentDirty = Boolean(currentEvidence && (group.syntheticUnknown || unresolved.length))
    const resolutionsForGroup = originRows.map((row) => row.resolution).filter(Boolean)
    const lifecycle = group.syntheticUnknown
      ? 'unresolved'
      : openRows.length
        ? 'unresolved'
        : resolutionsForGroup.some((resolution) => resolution.reason === 'adopted')
          ? 'adopted'
          : resolutionsForGroup.some((resolution) => resolution.reason === 'recovered')
            ? 'recovered'
            : resolutionsForGroup.some((resolution) => resolution.reason === 'discarded')
              ? 'discarded'
              : 'resolved'
    const contributorMap = new Map()
    const currentContributorMap = new Map()
    const addOriginContribution = (target, row, relationship) => {
      const key = actorIdentity(row.origin.actor)
      const contribution = target.get(key) || {
        actor: row.origin.actor,
        confidence: row.origin.confidence,
        confidenceReason: confidenceReason(row.origin.confidence, row.origin.source),
        evidence: []
      }
      if (confidenceStrength(row.origin.confidence) > confidenceStrength(contribution.confidence)) {
        contribution.confidence = row.origin.confidence
        contribution.confidenceReason = confidenceReason(row.origin.confidence, row.origin.source)
      }
      contribution.evidence.push({
        originEventId: row.origin.eventId,
        source: row.origin.source,
        recordedAt: row.origin.recordedAt,
        operation: row.origin.operation || null,
        claim: row.origin.claim || null,
        authority: row.origin.authority || null,
        relationship
      })
      target.set(key, contribution)
    }
    for (const row of originRows) {
      addOriginContribution(
        contributorMap,
        row,
        unresolved.some((candidate) => candidate.origin.eventId === row.origin.eventId)
          ? 'current'
          : 'historical'
      )
    }
    for (const row of lineageRows) addOriginContribution(contributorMap, row, 'predecessor')
    for (const row of unresolved) {
      addOriginContribution(currentContributorMap, row, 'current')
    }
    for (const row of lineageRows) {
      addOriginContribution(currentContributorMap, row, 'predecessor')
    }
    const accountabilityRows = [...originRows, ...lineageRows].filter(
      (row, index, rows) =>
        rows.findIndex((candidate) => candidate.origin.eventId === row.origin.eventId) === index
    )
    for (const row of accountabilityRows) {
      const origin = row.origin
      const declaresPreexistingBoundary = Object.prototype.hasOwnProperty.call(
        origin.operation || {},
        'preexistingDirty'
      )
      const preexistingDirty = declaresPreexistingBoundary
        ? origin.operation.preexistingDirty === true
        : origin.source === 'work-guard-marker' && !origin.before
      const hasKnownPredecessor = Boolean(
        origin.predecessorOriginEventId ||
        (adoptedPredecessorsBySuccessor.get(origin.eventId) || []).length
      )
      if (!preexistingDirty || hasKnownPredecessor) continue
      const key = `unknown-predecessor:${origin.eventId}`
      const contribution = {
        actor: {
          displayName: 'Unattributed pre-existing work',
          markerObservationId: key
        },
        confidence: 'unknown',
        confidenceReason:
          'The path was already dirty when this marker was first observed, and no earlier immutable contributor receipt exists.',
        evidence: [
          {
            originEventId: origin.eventId,
            source: 'preexisting-dirty-boundary',
            recordedAt: origin.recordedAt,
            operation: origin.operation || null,
            claim: null,
            authority: null,
            relationship: 'predecessor'
          }
        ]
      }
      contributorMap.set(key, contribution)
      if (
        currentDirty &&
        (unresolved.some((candidate) => candidate.origin.eventId === origin.eventId) ||
          lineageRows.some((candidate) => candidate.origin.eventId === origin.eventId))
      ) {
        currentContributorMap.set(key, contribution)
      }
    }
    if (group.syntheticUnknown) {
      if (matchingLiveMarkers.length) {
        for (const row of matchingLiveMarkers) {
          const actor = markerActor(row.marker, row.observationId)
          const key = actorIdentity(actor)
          const contribution = {
            actor,
            confidence: matchingLiveMarkers.length > 1 ? 'ambiguous' : 'correlated-claim',
            confidenceReason:
              matchingLiveMarkers.length > 1
                ? 'Multiple live marker claims overlap this current path.'
                : 'A live marker currently claims this path; marker intent is not edit authorship.',
            evidence: [
              {
                originEventId: null,
                source: 'live-marker-projection',
                recordedAt: row.marker.started || null,
                operation: null,
                claim: { paths: row.marker.paths || [] },
                authority: row.marker.lockOwnerId ? { lockOwnerId: row.marker.lockOwnerId } : null,
                relationship: 'current'
              }
            ]
          }
          for (const target of [contributorMap, currentContributorMap]) {
            const existing = target.get(key)
            if (existing) {
              existing.evidence.push(...contribution.evidence)
              if (
                confidenceStrength(contribution.confidence) >
                confidenceStrength(existing.confidence)
              ) {
                existing.confidence = contribution.confidence
                existing.confidenceReason = contribution.confidenceReason
              }
            } else {
              target.set(key, { ...contribution, evidence: [...contribution.evidence] })
            }
          }
        }
      } else {
        const contribution = {
          actor: {},
          confidence: 'unknown',
          confidenceReason:
            'No immutable receipt or defensible marker correlation explains the current bytes.',
          evidence: []
        }
        contributorMap.set('unknown', contribution)
        currentContributorMap.set('unknown', contribution)
      }
    }
    const confidenceContributors = currentDirty ? currentContributorMap : contributorMap
    const confidenceValues = [...confidenceContributors.values()].map((entry) => entry.confidence)
    const confidence =
      confidenceContributors.size > 1 ? 'ambiguous' : aggregateConfidence(confidenceValues)
    const activeRecovery = openRows
      .map((row) => row.recovery)
      .filter(Boolean)
      .at(-1)
    const observedTimes = accountabilityRows
      .map((row) => row.origin.recordedAt)
      .filter(Boolean)
      .sort()
    return {
      workItemId: group.workItemId,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
      path: group.path,
      lifecycle,
      confidence,
      confidenceReason:
        confidenceContributors.size > 1
          ? 'Multiple contributor identities overlap the same current path bytes.'
          : [...confidenceContributors.values()][0]?.confidenceReason ||
            confidenceReason(confidence),
      liveness: markerLiveness(group.path, markerRows, identity.root),
      currentDirty,
      currentStatus: currentDirty ? currentEvidence?.status || null : null,
      renamedFrom: currentDirty ? currentEvidence?.renamedFrom || null : null,
      currentFingerprint: currentDirty ? currentEvidence?.fingerprint || null : null,
      contributors: [...contributorMap.values()],
      currentContributors: [...currentContributorMap.values()],
      lineageOriginEventIds: lineageRows.map((row) => row.origin.eventId),
      lineageResolutions: lineageRows.map((row) => row.resolution).filter(Boolean),
      activeRecoveryEvent: activeRecovery || null,
      resolutions: resolutionsForGroup,
      correlatedCommits: [],
      firstObservedAt: observedTimes[0] || null,
      lastObservedAt: observedTimes.at(-1) || null
    }
  })
  workItems.sort(
    (left, right) =>
      Number(right.lifecycle === 'unresolved') - Number(left.lifecycle === 'unresolved') ||
      String(right.lastObservedAt).localeCompare(String(left.lastObservedAt)) ||
      left.path.localeCompare(right.path)
  )
  const attribution = buildAttributionPartition(generation.pathDeltas, workItems)
  const bounded = workItems.slice(0, limit).map(({ activeRecoveryEvent, ...item }) => ({
    ...item,
    recovery: activeRecoveryEvent ? recoveryProjection(root, activeRecoveryEvent) : null,
    correlatedCommits:
      options.includeCorrelatedCommits === true && item.lastObservedAt
        ? correlatedCommits(identity.root, item.path, item.lastObservedAt)
        : [],
    correlatedCommitsIncluded: options.includeCorrelatedCommits === true
  }))
  const cursorPayload = {
    records: records.map((record) => [record.name, record.digest]),
    gitGenerationId: generation.id
  }
  return {
    projectionVersion: PROJECTION_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    cursor: sha256(JSON.stringify(cursorPayload)),
    generatedAt: generation.observedAt,
    repository: identity,
    gitGeneration: {
      id: generation.id,
      coherent: generation.coherent,
      reason: generation.reason,
      attempt: generation.attempt,
      observedAt: generation.observedAt,
      headCommit: generation.headCommit,
      statusDigest: generation.statusDigest,
      numstatDigest: generation.numstatDigest,
      fingerprintDigest: generation.fingerprintDigest
    },
    attribution,
    window: {
      limit,
      totalItems: workItems.length,
      returnedItems: bounded.length,
      truncated: workItems.length > bounded.length
    },
    workItems: bounded
  }
}

function emptyProjection(root) {
  const rootDelta = deltaSummary([])
  return {
    projectionVersion: PROJECTION_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    cursor: sha256('empty'),
    generatedAt: new Date().toISOString(),
    repository: null,
    gitGeneration: null,
    attribution: {
      root: rootDelta,
      unique: { ...rootDelta, paths: [] },
      sharedAmbiguous: { ...rootDelta, paths: [] },
      unclaimedUnknown: { ...rootDelta, paths: [] },
      invariant: { files: true, additions: true, deletions: true, satisfied: true }
    },
    window: { limit: DEFAULT_QUERY_LIMIT, totalItems: 0, returnedItems: 0, truncated: false },
    workItems: [],
    unavailableReason: `No Git worktree was found for ${path.resolve(root)}.`
  }
}

function aggregateConfidence(values) {
  const unique = [...new Set(values)]
  if (unique.length === 0) return 'unknown'
  if (unique.includes('ambiguous')) return 'ambiguous'
  if (unique.length > 1) return 'ambiguous'
  return unique[0]
}

function confidenceStrength(confidence) {
  return (
    {
      unknown: 0,
      ambiguous: 1,
      'correlated-claim': 2,
      'observed-native': 3,
      exact: 4
    }[confidence] || 0
  )
}

function confidenceReason(confidence, source) {
  if (confidence === 'exact') {
    return 'TaskWraith observed before/after bytes for an exact verified file or hunk operation.'
  }
  if (confidence === 'observed-native') {
    return 'The bytes changed inside one non-overlapping native provider run boundary; no exact tool receipt exists.'
  }
  if (confidence === 'correlated-claim') {
    return 'A marker claimed the path when the matching dirty bytes were last observed; this is correlation, not authorship.'
  }
  if (confidence === 'ambiguous') {
    return 'Overlapping contributors or an unstable observation prevent a unique attribution.'
  }
  return source
    ? `The ${source} evidence does not defensibly identify a contributor.`
    : 'No defensible contributor evidence is available.'
}

function markerLiveness(targetPath, markerRows, worktreeRoot) {
  const matching = markerRows.filter(
    (row) =>
      markerTargetsWorktree(row, worktreeRoot) &&
      row.marker?.matchers?.some((match) => match(targetPath))
  )
  if (matching.some((row) => row.marker?.derived && row.state?.live)) return 'runtime'
  if (matching.some((row) => row.state?.live)) return 'live'
  if (matching.length) return 'decayed'
  return 'absent'
}

function markerTargetsWorktree(row, worktreeRoot) {
  const marker = row.marker || {}
  const markerBaseRoot = row.markerRoot || worktreeRoot
  const declaredRoot = marker.worktree
    ? path.resolve(markerBaseRoot, marker.worktree)
    : path.resolve(markerBaseRoot)
  return physicalPath(declaredRoot) === physicalPath(worktreeRoot)
}

function recoveryProjection(root, event) {
  if (event?.recovery?.ref !== recoveryRefFor(event?.originEventId || '')) return null
  const commitAvailable = Boolean(
    gitQuiet(root, ['cat-file', '-e', `${event.recovery.commit}^{commit}`]) !== null
  )
  const refCommit = gitQuiet(root, ['rev-parse', '--verify', event.recovery.ref])?.trim() || null
  return {
    ...event.recovery,
    pinned: refCommit === event.recovery.commit,
    available: commitAvailable,
    refCommit
  }
}

function correlatedCommits(root, targetPath, since) {
  const output = gitQuiet(root, [
    'log',
    '--format=%H',
    '--max-count=8',
    `--since=${since}`,
    '--',
    targetPath
  ])
  return output ? output.split(/\r?\n/).filter(Boolean) : []
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

module.exports = {
  CLASSIFIER_VERSION,
  EVENT_SCHEMA_VERSION,
  PROJECTION_VERSION,
  RECOVERY_REF_PREFIX,
  advanceMarkerObservations,
  captureGitGeneration,
  dirtyFingerprintMap,
  fingerprintKey,
  fingerprintPath,
  markerIdentityKey,
  normalizeSidecar,
  queryWorkProvenance,
  readEventRecords,
  reconcileWorkProvenance,
  resolveWorkspaceIdentity,
  sameFingerprint,
  writeEventImmutable
}

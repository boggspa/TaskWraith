'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { generatePerfFixture, fixtureFingerprint } = require('./fixtureGenerator.cjs')
const { MATERIALIZE_MODES } = require('./schema.cjs')

/**
 * Materialize a synthetic fixture into an isolated userData-shaped tree.
 * Never writes under the live TaskWraith / TaskWraith Dev profile dirs.
 *
 * Modes:
 *   legacy_v1  — fat chat-list index (ChatRecord-spread) + 508 checkpoints (493 superseded)
 *   future_v2  — minimal DTO list index + no fat global checkpoint rewrite (hot stub only)
 */

const FORBIDDEN_USERDATA_SUBSTRINGS = Object.freeze([
  'Application Support/TaskWraith',
  'Application Support/AGBench'
])

const LEGACY_CHECKPOINT_TOTAL = 508
const LEGACY_CHECKPOINT_SUPERSEDED = 493

function assertIsolatedUserDataDir(userDataDir) {
  if (typeof userDataDir !== 'string' || userDataDir.length < 4) {
    throw new Error('userDataDir must be a non-empty path')
  }
  const resolved = path.resolve(userDataDir)
  const home = os.homedir()
  const liveCandidates = [
    path.join(home, 'Library', 'Application Support', 'TaskWraith'),
    path.join(home, 'Library', 'Application Support', 'TaskWraith Dev'),
    path.join(home, 'Library', 'Application Support', 'AGBench')
  ]
  for (const live of liveCandidates) {
    if (resolved === live || resolved.startsWith(`${live}${path.sep}`)) {
      throw new Error(
        `Refusing to materialize into live userData path: ${resolved}. Use an isolated temp/perf dir.`
      )
    }
  }
  for (const needle of FORBIDDEN_USERDATA_SUBSTRINGS) {
    if (resolved.includes(needle) && liveCandidates.some((live) => resolved === live)) {
      throw new Error(`Refusing live userData: ${resolved}`)
    }
  }
  return resolved
}

/**
 * Strip harness-only `_perfMeta` before writing chat JSON the app can load.
 * @param {object} chat
 */
function toPersistedChatRecord(chat) {
  const { _perfMeta, ...rest } = chat
  return rest
}

/**
 * Minimal chat-list index entry — future-v2 DTO shape.
 * @param {object} chat
 */
function toMinimalChatListItem(chat) {
  return {
    appChatId: chat.appChatId,
    title: chat.title,
    provider: chat.provider,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    archived: false,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: chat.messages.length,
    runCount: chat.runs.length,
    persistenceRevision: chat.persistenceRevision || 1
  }
}

/**
 * Legacy-v1 fat index entry: spreads much of ChatRecord (mission suspect).
 * @param {object} chat
 */
function toLegacyFatChatListItem(chat) {
  const persisted = toPersistedChatRecord(chat)
  return {
    ...persisted,
    // Keep messages/runs in the index entry to reproduce HEAD rewrite amplification.
    summaryOnly: false,
    messageCount: chat.messages.length,
    runCount: chat.runs.length,
    ensembleSummary: persisted.ensemble
      ? {
          enabled: persisted.ensemble.enabled,
          orchestrationMode: persisted.ensemble.orchestrationMode,
          participantCount: Array.isArray(persisted.ensemble.participants)
            ? persisted.ensemble.participants.length
            : 0,
          activeRound: persisted.ensemble.activeRound || null
        }
      : null
  }
}

/**
 * Build 508 checkpoint records with 493 superseded — reproduces session-checkpoints.json bloat.
 * @param {object} fixture
 * @param {number} [baseTimestamp]
 */
function buildLegacyCheckpointRecords(fixture, baseTimestamp) {
  const baseTs = baseTimestamp == null ? Date.UTC(2026, 7, 3, 12, 0, 0) : baseTimestamp
  const hotChat = fixture.chats[0]
  /** @type {object[]} */
  const records = []
  const hotCount = LEGACY_CHECKPOINT_TOTAL - LEGACY_CHECKPOINT_SUPERSEDED
  for (let i = 0; i < LEGACY_CHECKPOINT_TOTAL; i++) {
    const superseded = i < LEGACY_CHECKPOINT_SUPERSEDED
    const chatId =
      superseded && fixture.chats.length > 1
        ? fixture.chats[i % fixture.chats.length].appChatId
        : hotChat.appChatId
    records.push({
      id: `perf-ckpt-${String(i + 1).padStart(4, '0')}`,
      appChatId: chatId,
      roundId: `${chatId}-round-hist-${i + 1}`,
      status: superseded ? 'superseded' : 'active',
      reason: superseded ? 'participant-updated' : 'round-start',
      createdAt: baseTs + i * 1000,
      updatedAt: baseTs + i * 1000 + 500,
      superseded,
      // Inflate like HEAD full-fidelity mirrors (trimmed vs live for harness size control).
      snapshot: {
        persistenceRevision: i + 1,
        messageCount: hotChat.messages.length,
        runCount: hotChat.runs.length,
        ensembleParticipantCount: hotChat.ensemble.participants.length,
        padding: superseded ? `superseded-archive-${i}` : `hot-record-${i}`
      }
    })
  }
  return {
    schemaVersion: 1,
    kind: 'taskwraith-perf-legacy-checkpoints',
    total: records.length,
    supersededCount: records.filter((r) => r.superseded).length,
    hotCount,
    records
  }
}

/**
 * future-v2: one hot checkpoint stub per chat (archive stays out of the hot rewrite file).
 * @param {object} fixture
 */
function buildFutureV2CheckpointStub(fixture) {
  return {
    schemaVersion: 2,
    kind: 'taskwraith-perf-future-v2-checkpoints',
    hotRecords: fixture.chats.map((chat) => ({
      id: `perf-hot-${chat.appChatId}`,
      appChatId: chat.appChatId,
      roundId: chat.ensemble.activeRound.id,
      status: 'active',
      reason: 'round-start',
      superseded: false,
      snapshot: {
        persistenceRevision: chat.persistenceRevision || 1,
        messageCount: chat.messages.length,
        runCount: chat.runs.length
      }
    })),
    archiveNote: 'Superseded history lives outside the hot rewrite path (ADR amendment).'
  }
}

/**
 * @param {object} options
 * @param {'30seat'|'50seat'|'dual_run'|'455_soak'|'50_chat_switch'} options.workload
 * @param {string} options.userDataDir
 * @param {number} [options.seed]
 * @param {object} [options.fixture]
 * @param {boolean} [options.pretty=false]
 * @param {'legacy_v1'|'future_v2'} [options.mode='legacy_v1']
 * @param {boolean} [options.lean]
 * @param {number} [options.scaleDown]
 */
function materializePerfUserData(options) {
  const userDataDir = assertIsolatedUserDataDir(options.userDataDir)
  const mode = options.mode || 'legacy_v1'
  if (!MATERIALIZE_MODES.includes(mode)) {
    throw new Error(`mode must be one of ${MATERIALIZE_MODES.join(', ')}`)
  }
  const fixture =
    options.fixture ||
    generatePerfFixture({
      workload: options.workload,
      seed: options.seed,
      lean: options.lean,
      scaleDown: options.scaleDown
    })
  const pretty = options.pretty === true
  const chatsDir = path.join(userDataDir, 'chats')
  fs.mkdirSync(chatsDir, { recursive: true })

  const listItems = []
  for (const chat of fixture.chats) {
    const persisted = toPersistedChatRecord(chat)
    const filePath = path.join(chatsDir, `${chat.appChatId}.json`)
    const body = pretty
      ? `${JSON.stringify(persisted, null, 2)}\n`
      : `${JSON.stringify(persisted)}\n`
    fs.writeFileSync(filePath, body, 'utf8')
    listItems.push(
      mode === 'legacy_v1' ? toLegacyFatChatListItem(chat) : toMinimalChatListItem(chat)
    )
  }

  const indexPath = path.join(userDataDir, 'chat-list-index.json')
  fs.writeFileSync(
    indexPath,
    pretty ? `${JSON.stringify(listItems, null, 2)}\n` : `${JSON.stringify(listItems)}\n`,
    'utf8'
  )

  const checkpointPath = path.join(userDataDir, 'session-checkpoints.json')
  const checkpointDoc =
    mode === 'legacy_v1'
      ? buildLegacyCheckpointRecords(fixture)
      : buildFutureV2CheckpointStub(fixture)
  fs.writeFileSync(
    checkpointPath,
    pretty ? `${JSON.stringify(checkpointDoc, null, 2)}\n` : `${JSON.stringify(checkpointDoc)}\n`,
    'utf8'
  )

  const replayPath = path.join(userDataDir, 'perf-replay-schedule.json')
  const replayDoc = {
    schemaVersion: 1,
    kind: 'taskwraith-perf-replay-schedule',
    workload: fixture.workload,
    seed: fixture.seed,
    fingerprint: fixtureFingerprint(fixture),
    eventCount: Array.isArray(fixture.replaySchedule) ? fixture.replaySchedule.length : 0,
    events: fixture.replaySchedule || []
  }
  fs.writeFileSync(replayPath, `${JSON.stringify(replayDoc)}\n`, 'utf8')

  const indexBytes = fs.statSync(indexPath).size
  const checkpointBytes = fs.statSync(checkpointPath).size

  const manifest = {
    schemaVersion: 1,
    kind: 'taskwraith-perf-fixture-manifest',
    workload: fixture.workload,
    seed: fixture.seed,
    mode,
    fingerprint: fixtureFingerprint(fixture),
    totals: fixture.totals,
    sizes: {
      indexBytes,
      checkpointBytes,
      chatSerializedBytes: fixture.totals.chatSerializedBytes,
      toolSerializedBytes: fixture.totals.toolSerializedBytes
    },
    checkpoints:
      mode === 'legacy_v1'
        ? {
            total: checkpointDoc.total,
            supersededCount: checkpointDoc.supersededCount
          }
        : {
            hotCount: checkpointDoc.hotRecords.length,
            supersededCount: 0
          },
    chatFiles: fixture.chats.map((c) => `chats/${c.appChatId}.json`),
    replayScheduleFile: 'perf-replay-schedule.json',
    userDataDir,
    materializedAt: new Date().toISOString()
  }
  const manifestPath = path.join(userDataDir, 'perf-fixture-manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return {
    userDataDir,
    chatsDir,
    indexPath,
    checkpointPath,
    replayPath,
    manifestPath,
    manifest,
    fixture,
    mode,
    sizes: manifest.sizes
  }
}

module.exports = {
  assertIsolatedUserDataDir,
  toPersistedChatRecord,
  toMinimalChatListItem,
  toLegacyFatChatListItem,
  buildLegacyCheckpointRecords,
  buildFutureV2CheckpointStub,
  materializePerfUserData,
  LEGACY_CHECKPOINT_TOTAL,
  LEGACY_CHECKPOINT_SUPERSEDED
}

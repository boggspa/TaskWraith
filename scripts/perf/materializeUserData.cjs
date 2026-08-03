'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { generatePerfFixture, fixtureFingerprint } = require('./fixtureGenerator.cjs')
const { MATERIALIZE_MODES } = require('./schema.cjs')

/**
 * Materialize a synthetic fixture into an isolated userData-shaped tree.
 * Never writes under the live TaskWraith / bare TaskWraith Dev / AGBench profile dirs.
 * Sibling `TaskWraith Dev <sanitizedId>` paths are allowed (T2 attach contract).
 *
 * Modes:
 *   legacy_v1  — HEAD-shaped chat-list index map + 508 checkpoints (493 superseded)
 *   future_v2  — minimal DTO list index + one hot checkpoint per chat (no fat archive)
 */

const FORBIDDEN_USERDATA_SUBSTRINGS = Object.freeze([
  'Application Support/TaskWraith',
  'Application Support/AGBench'
])

const LEGACY_CHECKPOINT_TOTAL = 508
const LEGACY_CHECKPOINT_SUPERSEDED = 493
const SESSION_CHECKPOINT_SCHEMA_VERSION = 1
const SESSION_CHECKPOINT_RELATIVE_PATH = path.join('checkpoints', 'session-checkpoints.json')

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
 * @param {unknown} text
 * @param {number} maxLength
 */
function previewText(text, maxLength) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

/**
 * Fixture runs historically used `id`; production ChatRun uses `runId`.
 * @param {object|null|undefined} run
 * @returns {string|null}
 */
function runIdOf(run) {
  if (!run || typeof run !== 'object') return null
  if (typeof run.runId === 'string' && run.runId) return run.runId
  if (typeof run.id === 'string' && run.id) return run.id
  return null
}

/**
 * Lean lastRun projection matching store summarizeLastRun field set.
 * @param {object|undefined} run
 */
function summarizeLastRunLean(run) {
  const runId = runIdOf(run)
  if (!run || !runId) return undefined
  return {
    runId,
    provider: run.provider,
    providerRunId: run.providerRunId,
    providerThreadId: run.providerThreadId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    requestedModel: run.requestedModel,
    actualModel: run.actualModel,
    approvalMode: run.approvalMode,
    workflowMode: run.workflowMode,
    status: run.status,
    cancelled: run.cancelled,
    exitCode: run.exitCode,
    runtimeProfileId: run.runtimeProfileId,
    geminiAuthProfileId: run.geminiAuthProfileId,
    ensembleRoundId: run.ensembleRoundId,
    ensembleParticipantId: run.ensembleParticipantId,
    ensembleLaneId: run.ensembleLaneId,
    ensembleRole: run.ensembleRole,
    ensembleStageRole: run.ensembleStageRole,
    ensembleOrder: run.ensembleOrder
  }
}

/**
 * Lean runsSummary row matching store summarizeRunForChatList (diffFileCount=0 in fixtures).
 * @param {object} run
 */
function summarizeRunForListLean(run) {
  const runId = runIdOf(run)
  return {
    runId,
    ...(run.provider ? { provider: run.provider } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.requestedModel ? { requestedModel: run.requestedModel } : {}),
    ...(run.actualModel ? { actualModel: run.actualModel } : {}),
    diffFileCount: 0
  }
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
    messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
    runCount: Array.isArray(chat.runs) ? chat.runs.length : 0,
    persistenceRevision: chat.persistenceRevision || 1
  }
}

/**
 * Legacy-v1 HEAD-shaped list entry: spreads ChatRecord metadata, clears messages/runs,
 * summaryOnly:true — retains fat ensemble/goal/grant fields that amplify index rewrites.
 * @param {object} chat
 */
function toLegacyFatChatListItem(chat) {
  const persisted = toPersistedChatRecord(chat)
  const messages = Array.isArray(persisted.messages) ? persisted.messages : []
  const runs = Array.isArray(persisted.runs) ? persisted.runs : []
  const lastRun = summarizeLastRunLean(runs[runs.length - 1])
  const recentMessageSearch = messages
    .slice(-8)
    .map((message) => `${message.role} ${previewText(message.content, 180)}`)
    .filter(Boolean)
  const latestMessagePreview = [...messages]
    .reverse()
    .map((message) => previewText(message.content, 180))
    .find(Boolean)
  return {
    ...persisted,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: messages.length,
    runCount: runs.length,
    runsSummary: runs.filter((run) => runIdOf(run)).map((run) => summarizeRunForListLean(run)),
    ...(lastRun ? { lastRun } : {}),
    searchText: [
      persisted.title,
      persisted.provider,
      persisted.appChatId,
      persisted.linkedGeminiSessionId,
      persisted.linkedProviderSessionId,
      ...recentMessageSearch
    ]
      .filter(Boolean)
      .join(' '),
    ...(latestMessagePreview ? { searchPreview: latestMessagePreview } : {})
  }
}

/**
 * @param {object} chat
 * @returns {{ roundId: string, round: object }}
 */
function resolveActiveRound(chat) {
  const round = (chat && chat.ensemble && chat.ensemble.activeRound) || {}
  const roundId =
    (typeof round.roundId === 'string' && round.roundId) ||
    (typeof round.id === 'string' && round.id) ||
    `${chat.appChatId}-round-1`
  return { roundId, round }
}

/**
 * Build a snapshot that passes production isSessionCheckpointRecord.
 * @param {object} chat
 * @param {object} round
 * @param {string} roundId
 * @param {number} index
 * @param {boolean} superseded
 */
function buildCheckpointSnapshot(chat, round, roundId, index, superseded) {
  const participants = Array.isArray(round.participants)
    ? round.participants
    : Array.isArray(chat.ensemble && chat.ensemble.participants)
      ? chat.ensemble.participants
      : []
  const prompt =
    typeof round.prompt === 'string'
      ? round.prompt
      : `perf-fixture ${chat.appChatId} ${roundId} #${index + 1}`
  const startedAt =
    typeof round.startedAt === 'string' && Number.isFinite(Date.parse(round.startedAt))
      ? round.startedAt
      : new Date(Date.UTC(2026, 7, 3, 12, 0, 0) + index * 1000).toISOString()
  return {
    blackboard: Array.isArray(chat.ensemble && chat.ensemble.blackboard)
      ? chat.ensemble.blackboard
      : [],
    openTasks: Array.isArray(round.openTasks) ? round.openTasks : [],
    ...(superseded
      ? {}
      : {
          lastRoundSummary: `perf-hot ${chat.appChatId}`
        }),
    queueState: {
      roundStatus: typeof round.status === 'string' ? round.status : 'running',
      prompt,
      startedAt,
      ...(round.endedAt ? { endedAt: round.endedAt } : {}),
      ...(round.activeParticipantId ? { activeParticipantId: round.activeParticipantId } : {}),
      orchestrationMode:
        round.orchestrationMode ||
        (chat.ensemble && chat.ensemble.orchestrationMode) ||
        'continuous',
      ...(round.continuationHops !== undefined ? { continuationHops: round.continuationHops } : {}),
      ...(round.maxContinuationHops !== undefined
        ? { maxContinuationHops: round.maxContinuationHops }
        : {}),
      ...(round.continuationPass !== undefined ? { continuationPass: round.continuationPass } : {}),
      queuedPrompts: Array.isArray(round.queuedPrompts)
        ? round.queuedPrompts
        : typeof round.queuedPrompt === 'string'
          ? [round.queuedPrompt]
          : [],
      sleepingParticipantIds: Array.isArray(round.sleepingParticipantIds)
        ? round.sleepingParticipantIds
        : [],
      pendingWakeupIds: Array.isArray(round.pendingWakeupIds) ? round.pendingWakeupIds : [],
      participants
    }
  }
}

/**
 * Production-validator-equivalent acceptance check (mirrors SessionCheckpoint.ts).
 * @param {unknown} value
 * @returns {boolean}
 */
function isSessionCheckpointRecordEquivalent(value) {
  if (!value || typeof value !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (value)
  const snapshot = /** @type {Record<string, unknown>|undefined} */ (record.snapshot)
  const queueState = /** @type {Record<string, unknown>|undefined} */ (
    snapshot && snapshot.queueState
  )
  return (
    record.schemaVersion === SESSION_CHECKPOINT_SCHEMA_VERSION &&
    typeof record.id === 'string' &&
    typeof record.chatId === 'string' &&
    typeof record.roundId === 'string' &&
    (record.status === 'available' ||
      record.status === 'accepted' ||
      record.status === 'dismissed' ||
      record.status === 'superseded') &&
    typeof record.reason === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    Boolean(snapshot) &&
    Array.isArray(snapshot.blackboard) &&
    Array.isArray(snapshot.openTasks) &&
    Boolean(queueState) &&
    typeof queueState.prompt === 'string' &&
    Array.isArray(queueState.participants) &&
    Array.isArray(queueState.queuedPrompts)
  )
}

/**
 * Build 508 production-valid checkpoint records with 493 superseded.
 * Returns a raw array (production on-disk shape) — not a wrapper object.
 * @param {object} fixture
 * @param {number} [baseTimestamp]
 * @returns {object[]}
 */
function buildLegacyCheckpointRecords(fixture, baseTimestamp) {
  const baseTs = baseTimestamp == null ? Date.UTC(2026, 7, 3, 12, 0, 0) : baseTimestamp
  const hotChat = fixture.chats[0]
  /** @type {object[]} */
  const records = []
  for (let i = 0; i < LEGACY_CHECKPOINT_TOTAL; i++) {
    const superseded = i < LEGACY_CHECKPOINT_SUPERSEDED
    const chat =
      superseded && fixture.chats.length > 1 ? fixture.chats[i % fixture.chats.length] : hotChat
    const { roundId: activeRoundId, round } = resolveActiveRound(chat)
    const roundId = superseded ? `${chat.appChatId}-round-hist-${i + 1}` : activeRoundId
    const createdAt = new Date(baseTs + i * 1000).toISOString()
    const updatedAt = new Date(baseTs + i * 1000 + 500).toISOString()
    /** @type {object} */
    const record = {
      schemaVersion: SESSION_CHECKPOINT_SCHEMA_VERSION,
      id: `perf-ckpt-${String(i + 1).padStart(4, '0')}`,
      chatId: chat.appChatId,
      ...(chat.title ? { chatTitle: chat.title } : {}),
      roundId,
      status: superseded ? 'superseded' : 'available',
      reason: superseded ? 'participant-updated' : 'round-started',
      createdAt,
      updatedAt,
      snapshot: buildCheckpointSnapshot(chat, round, roundId, i, superseded)
    }
    if (superseded) {
      record.supersededAt = updatedAt
    }
    records.push(record)
  }
  return records
}

/**
 * future-v2: one hot valid checkpoint per chat (no superseded archive in the hot file).
 * @param {object} fixture
 * @returns {object[]}
 */
function buildFutureV2CheckpointStub(fixture) {
  const baseTs = Date.UTC(2026, 7, 3, 12, 0, 0)
  return fixture.chats.map((chat, index) => {
    const { roundId, round } = resolveActiveRound(chat)
    const createdAt = new Date(baseTs + index * 1000).toISOString()
    return {
      schemaVersion: SESSION_CHECKPOINT_SCHEMA_VERSION,
      id: `perf-hot-${chat.appChatId}`,
      chatId: chat.appChatId,
      ...(chat.title ? { chatTitle: chat.title } : {}),
      roundId,
      status: 'available',
      reason: 'round-started',
      createdAt,
      updatedAt: createdAt,
      snapshot: buildCheckpointSnapshot(chat, round, roundId, index, false)
    }
  })
}

/**
 * @param {object[]} listItems
 * @returns {Record<string, object>}
 */
function toChatListIndexMap(listItems) {
  /** @type {Record<string, object>} */
  const index = {}
  for (const item of listItems) {
    if (!item || typeof item.appChatId !== 'string' || !item.appChatId) {
      throw new Error('chat-list-index item missing appChatId')
    }
    index[item.appChatId] = item
  }
  return index
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

  /** @type {object[]} */
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

  const indexMap = toChatListIndexMap(listItems)
  const indexPath = path.join(userDataDir, 'chat-list-index.json')
  fs.writeFileSync(
    indexPath,
    pretty ? `${JSON.stringify(indexMap, null, 2)}\n` : `${JSON.stringify(indexMap)}\n`,
    'utf8'
  )

  const checkpointRecords =
    mode === 'legacy_v1'
      ? buildLegacyCheckpointRecords(fixture)
      : buildFutureV2CheckpointStub(fixture)
  const checkpointPath = path.join(userDataDir, SESSION_CHECKPOINT_RELATIVE_PATH)
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true })
  fs.writeFileSync(
    checkpointPath,
    pretty
      ? `${JSON.stringify(checkpointRecords, null, 2)}\n`
      : `${JSON.stringify(checkpointRecords)}\n`,
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
  const supersededCount =
    mode === 'legacy_v1' ? checkpointRecords.filter((r) => r.status === 'superseded').length : 0

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
    paths: {
      chatListIndex: 'chat-list-index.json',
      sessionCheckpoints: SESSION_CHECKPOINT_RELATIVE_PATH.replace(/\\/g, '/')
    },
    checkpoints:
      mode === 'legacy_v1'
        ? {
            total: checkpointRecords.length,
            supersededCount,
            hotCount: checkpointRecords.length - supersededCount,
            relativePath: SESSION_CHECKPOINT_RELATIVE_PATH.replace(/\\/g, '/'),
            onDiskShape: 'raw-array'
          }
        : {
            hotCount: checkpointRecords.length,
            supersededCount: 0,
            relativePath: SESSION_CHECKPOINT_RELATIVE_PATH.replace(/\\/g, '/'),
            onDiskShape: 'raw-array'
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
    sizes: manifest.sizes,
    checkpointRelativePath: SESSION_CHECKPOINT_RELATIVE_PATH.replace(/\\/g, '/')
  }
}

module.exports = {
  assertIsolatedUserDataDir,
  toPersistedChatRecord,
  toMinimalChatListItem,
  toLegacyFatChatListItem,
  buildLegacyCheckpointRecords,
  buildFutureV2CheckpointStub,
  isSessionCheckpointRecordEquivalent,
  materializePerfUserData,
  LEGACY_CHECKPOINT_TOTAL,
  LEGACY_CHECKPOINT_SUPERSEDED,
  SESSION_CHECKPOINT_SCHEMA_VERSION,
  SESSION_CHECKPOINT_RELATIVE_PATH
}

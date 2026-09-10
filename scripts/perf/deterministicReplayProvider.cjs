'use strict'

/**
 * M1 Wall 1 — deterministic replay provider driver.
 *
 * Generates provider-turn LOAD deterministically and applies it through a
 * PageApiAdapter (`getChat` / `saveChat`), reusing `performTrackedSave` for
 * exact compare-and-swap revision semantics. A turn is a scripted sequence of
 * parts — assistant content chunks, then tool calls — applied as growing
 * message saves against one chat. Same (seed, chatId, turnIndex, providerId,
 * shape) always yields the same script bytes; `scriptFingerprint` (sha256)
 * proves it. What is MEASURED (per-part apply latencies on a guarded
 * monotonic clock) is observed, never scripted.
 *
 * Honesty rules, all pinned by `deterministicReplayProvider.test.ts`:
 *
 * - This driver runs NO provider. It replays scripted provider-SHAPED
 *   traffic (B2: never imply matrix data runs providers). Every result
 *   carries `replay: true` plus the seed and script fingerprints so any
 *   downstream consumer can tell replay load from a live run.
 * - Scripts are pure data: no wall clock, no network, no model. Timestamps
 *   are scripted offsets from a fixed epoch. Filler content comes from a
 *   seeded PRNG; tool activities reuse `buildToolActivity` so their shape
 *   is byte-identical to fixture traffic.
 * - The shape profile (chunks, bytes, tool calls) is an ARBITRARY load
 *   profile, not an observed measurement. Defaults are documented
 *   constants; runners override them from fixture profiles.
 * - One chat per run, turns and parts strictly sequential, per-operation
 *   timeout plus an overall deadline, per-chat reservation. Outcomes use
 *   the lanes vocabulary (completed/failed/unsupported/censored/
 *   not_attempted); adapter exceptions never leak text into evidence.
 * - Scripted records are not fixture prefixes, so every save takes the
 *   `saveChat` path (never `savePrefix`). Over CDP that ships the whole
 *   record per part — the same documented instrument cost the lanes'
 *   `saveChat` fallback accepts. Lean fixtures keep it small.
 * - No evidence-v1 block: window/population shaping and pairing are runner
 *   work (P4/P5). Reachability unlisting on landing follows the lanes and
 *   control precedents: capability exists, runners still owed.
 */

const crypto = require('crypto')
const { createPrng, buildToolActivity, TOOL_NAMES } = require('./fixtureGenerator.cjs')
const { performTrackedSave } = require('./replayDriver.cjs')
const { percentileSummary } = require('./concurrentReplayLanes.cjs')

/**
 * V1 load profile. ARBITRARY constants shaping scripted traffic volume —
 * not observed measurements. Runners override from fixture profiles.
 */
const PROVIDER_TURN_SHAPE_DEFAULTS = Object.freeze({
  chunksPerTurn: 4,
  chunkBytes: 512,
  toolCallsPerTurn: 2,
  toolParamBytes: 256,
  toolRawBytes: 512,
  includeRaw: true
})

/** Scripted timestamps are offsets from this fixed epoch — never wall-clock. */
const REPLAY_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z')

const MAX_TIMER_MS = 2 ** 31 - 1

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(label + ' must be a positive integer')
  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(label + ' must be a non-negative integer')
  return value
}

function duration(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(label + ' must be a finite positive timer duration')
  }
  return value
}

function makeClock(nowMs) {
  if (nowMs !== undefined && typeof nowMs !== 'function')
    throw new Error('nowMs must be a function')
  const now = nowMs || (() => require('node:perf_hooks').performance.now())
  let last = null
  return () => {
    const value = now()
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (last !== null && value < last)
    ) {
      throw new Error('nowMs must produce finite non-negative monotonic readings')
    }
    last = value
    return value
  }
}

function clearTimer(timers, timer) {
  if (timer === null) return
  try {
    timers.clearTimeout(timer)
  } catch {
    /* A cleanup seam cannot strand ownership. */
  }
}

/** FNV-1a 32-bit: stable process-independent sub-seeds (no Math.random). */
function fnv1a32(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Deterministic printable filler of exactly `count` chars from `rand`. */
function fillerContent(rand, count) {
  let out = ''
  for (let i = 0; i < count; i++) out += String.fromCharCode(33 + Math.floor(rand() * 94))
  return out
}

function resolveShape(shape) {
  const merged = { ...PROVIDER_TURN_SHAPE_DEFAULTS, ...(shape === undefined ? {} : shape) }
  if (!isPlainObject(merged)) throw new Error('shape must be an object')
  positiveInteger(merged.chunksPerTurn, 'shape.chunksPerTurn')
  positiveInteger(merged.chunkBytes, 'shape.chunkBytes')
  nonNegativeInteger(merged.toolCallsPerTurn, 'shape.toolCallsPerTurn')
  positiveInteger(merged.toolParamBytes, 'shape.toolParamBytes')
  positiveInteger(merged.toolRawBytes, 'shape.toolRawBytes')
  if (typeof merged.includeRaw !== 'boolean') throw new Error('shape.includeRaw must be boolean')
  return merged
}

/**
 * Pure deterministic turn script. Same inputs → same bytes, always.
 * @param {object} options
 */
function generateProviderTurnScript(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  const { seed, chatId, turnIndex, providerId } = options
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer')
  if (typeof chatId !== 'string' || !chatId.trim()) throw new Error('chatId required')
  if (!Number.isSafeInteger(turnIndex) || turnIndex < 0)
    throw new Error('turnIndex must be a non-negative integer')
  if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('providerId required')
  const shape = resolveShape(options.shape)
  const rand = createPrng(fnv1a32(`${seed}/${chatId}/${turnIndex}/${providerId}`))
  const baseMs = REPLAY_EPOCH_MS + turnIndex * 1000
  const chunks = Array.from({ length: shape.chunksPerTurn }, (_, index) => ({
    seq: index,
    bytes: shape.chunkBytes,
    content: fillerContent(rand, shape.chunkBytes)
  }))
  const toolCalls = Array.from({ length: shape.toolCallsPerTurn }, (_, index) => {
    const toolName = TOOL_NAMES[Math.floor(rand() * TOOL_NAMES.length)]
    return {
      seq: index,
      toolName,
      paramBytes: shape.toolParamBytes,
      rawBytes: shape.toolRawBytes,
      activity: buildToolActivity({
        id: `${chatId}-replay-turn-${turnIndex}-tool-${index}`,
        toolName,
        provider: providerId,
        participantId: null,
        startedAt: new Date(baseMs + shape.chunksPerTurn + index).toISOString(),
        includeRaw: shape.includeRaw,
        paramBytes: shape.toolParamBytes,
        rawBytes: shape.toolRawBytes,
        rand
      })
    }
  })
  const partCount = chunks.length + toolCalls.length
  const timestamps = Array.from({ length: partCount }, (_, index) => baseMs + index)
  const script = {
    seed,
    chatId,
    turnIndex,
    providerId,
    runId: `${chatId}-replay-run-${turnIndex}`,
    messageId: `${chatId}-replay-turn-${turnIndex}`,
    shape,
    chunks,
    toolCalls,
    timestamps
  }
  return { ...script, scriptFingerprint: fingerprintScript(script) }
}

function fingerprintScript(script) {
  return crypto.createHash('sha256').update(stableStringify(script)).digest('hex')
}

// One replay run at a time per chat on one adapter: two concurrent runs
// would interleave scripted saves and corrupt revision tracking.
const activeChats = new WeakMap()

async function runProviderTurnReplay(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  const api = options.api
  if (
    !isPlainObject(api) ||
    typeof api.getChat !== 'function' ||
    typeof api.saveChat !== 'function'
  ) {
    throw new Error('api.getChat and api.saveChat required')
  }
  const { chatId, providerId, seed } = options
  if (typeof chatId !== 'string' || !chatId.trim()) throw new Error('chatId required')
  if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('providerId required')
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer')
  positiveInteger(options.turns, 'turns')
  const shape = resolveShape(options.shape)
  if (options.partTimeoutMs !== undefined) duration(options.partTimeoutMs, 'partTimeoutMs')
  if (options.deadlineMs !== undefined) duration(options.deadlineMs, 'deadlineMs')
  const timers = options.timers ?? { setTimeout, clearTimeout }
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new Error('timers require setTimeout and clearTimeout')
  }
  if (options.diagnosticOnly !== undefined && typeof options.diagnosticOnly !== 'boolean') {
    throw new Error('diagnosticOnly must be boolean')
  }
  if (options.metadata !== undefined && !isPlainObject(options.metadata)) {
    throw new Error('metadata must be an object')
  }
  const clock = makeClock(options.nowMs)

  let owners = activeChats.get(api)
  if (!owners) activeChats.set(api, (owners = new Map()))
  if (owners.has(chatId)) throw new Error('replay chat still owned by another replay')
  const token = {}
  owners.set(chatId, token)
  const release = () => {
    if (owners.get(chatId) === token) owners.delete(chatId)
  }

  let fenceReason = null
  let clockFailed = false
  let resolveFence
  const fence = new Promise((resolve) => {
    resolveFence = resolve
  })
  const stop = (reason) => {
    if (fenceReason !== null) return
    fenceReason = reason
    resolveFence({ fence: true })
  }
  const readTime = () => {
    try {
      return clock()
    } catch {
      clockFailed = true
      stop('clock_invalid')
      return null
    }
  }
  // One bounded-operation helper for the baseline read and every save: the
  // per-operation timeout and the overall deadline race the attempt. A fenced
  // outcome carries the live attempt so callers can retain ownership until a
  // cut-off SAVE settles; cut-off reads retain nothing (reads have no effects).
  const racedCall = async (fn) => {
    let timer = null
    const clear = () => clearTimer(timers, timer)
    if (options.partTimeoutMs !== undefined) {
      try {
        timer = timers.setTimeout(() => stop('part_timeout'), Math.ceil(options.partTimeoutMs))
      } catch {
        return { type: 'timer_failed' }
      }
    }
    const attempt = Promise.resolve().then(fn)
    const outcome = await Promise.race([
      attempt.then(
        (value) => ({ type: 'settled', value }),
        (error) => ({ type: 'rejected', error })
      ),
      fence.then(() => ({ type: 'fenced', attempt }))
    ])
    clear()
    return outcome
  }

  const turns = []
  const cutAttempts = []
  const ctx = { api, canonicalRevisions: new Map(), savedCounts: new Map() }
  let deadlineTimer = null
  const startedAtMs = readTime()
  const deadlineAtMs =
    startedAtMs === null || options.deadlineMs === undefined
      ? null
      : startedAtMs + options.deadlineMs
  if (startedAtMs !== null && options.deadlineMs !== undefined) {
    try {
      deadlineTimer = timers.setTimeout(() => stop('deadline'), Math.ceil(options.deadlineMs))
    } catch {
      clockFailed = true
      stop('deadline_timer_failed')
    }
  }

  const recordNotAttemptedTurn = (turnIndex) => {
    const script = generateProviderTurnScript({ seed, chatId, turnIndex, providerId, shape })
    turns.push({
      turnIndex,
      runId: script.runId,
      messageId: script.messageId,
      scriptFingerprint: script.scriptFingerprint,
      outcome: 'not_attempted',
      reason: fenceReason,
      parts: [
        ...script.chunks.map((chunk) => ({
          seq: chunk.seq,
          kind: 'provider_chunk',
          bytes: chunk.bytes,
          latencyMs: null,
          outcome: 'not_attempted',
          reason: fenceReason,
          apiCalls: 0,
          pendingSave: false
        })),
        ...script.toolCalls.map((call) => ({
          seq: call.seq,
          kind: 'provider_tool',
          bytes: call.paramBytes + call.rawBytes,
          latencyMs: null,
          outcome: 'not_attempted',
          reason: fenceReason,
          apiCalls: 0,
          pendingSave: false
        }))
      ]
    })
  }

  try {
    // Baseline once per run: the reservation guarantees no other driver run
    // mutates this chat, so the in-memory revision chain stays canonical. A
    // live app interleaving shows up as an honest save rejection per part.
    const baselineOutcome =
      fenceReason !== null ? { type: 'fenced' } : await racedCall(() => api.getChat(chatId))
    if (baselineOutcome.type !== 'settled' || baselineOutcome.value == null) {
      if (baselineOutcome.type === 'settled') {
        for (let turnIndex = 0; turnIndex < options.turns; turnIndex++) {
          turns.push({
            turnIndex,
            runId: `${chatId}-replay-run-${turnIndex}`,
            messageId: `${chatId}-replay-turn-${turnIndex}`,
            scriptFingerprint: null,
            outcome: 'unsupported',
            reason: 'chat missing',
            parts: []
          })
        }
      } else {
        for (let turnIndex = 0; turnIndex < options.turns; turnIndex++) {
          recordNotAttemptedTurn(turnIndex)
        }
      }
    } else {
      let record = JSON.parse(JSON.stringify(baselineOutcome.value))
      if (!Array.isArray(record.messages)) record.messages = []
      let globalSeq = 0
      for (let turnIndex = 0; turnIndex < options.turns; turnIndex++) {
        if (fenceReason !== null) {
          recordNotAttemptedTurn(turnIndex)
          continue
        }
        const script = generateProviderTurnScript({ seed, chatId, turnIndex, providerId, shape })
        const turn = {
          turnIndex,
          runId: script.runId,
          messageId: script.messageId,
          scriptFingerprint: script.scriptFingerprint,
          outcome: null,
          reason: null,
          parts: []
        }
        turns.push(turn)
        const planned = [
          ...script.chunks.map((chunk, index) => ({
            kind: 'provider_chunk',
            chunk,
            timestamp: script.timestamps[index]
          })),
          ...script.toolCalls.map((call, offset) => ({
            kind: 'provider_tool',
            call,
            timestamp: script.timestamps[script.chunks.length + offset]
          }))
        ]
        for (const part of planned) {
          if (fenceReason !== null) {
            turn.parts.push({
              seq: part.kind === 'provider_chunk' ? part.chunk.seq : part.call.seq,
              kind: part.kind,
              bytes:
                part.kind === 'provider_chunk'
                  ? part.chunk.bytes
                  : part.call.paramBytes + part.call.rawBytes,
              latencyMs: null,
              outcome: 'not_attempted',
              reason: fenceReason,
              apiCalls: 1,
              pendingSave: false
            })
            continue
          }
          const started = readTime()
          if (started === null) {
            turn.parts.push({
              seq: part.kind === 'provider_chunk' ? part.chunk.seq : part.call.seq,
              kind: part.kind,
              bytes:
                part.kind === 'provider_chunk'
                  ? part.chunk.bytes
                  : part.call.paramBytes + part.call.rawBytes,
              latencyMs: null,
              outcome: 'not_attempted',
              reason: fenceReason,
              apiCalls: 0,
              pendingSave: false
            })
            stop('clock_invalid')
            continue
          }
          if (deadlineAtMs !== null && started >= deadlineAtMs) {
            stop('deadline')
            turn.parts.push({
              seq: part.kind === 'provider_chunk' ? part.chunk.seq : part.call.seq,
              kind: part.kind,
              bytes:
                part.kind === 'provider_chunk'
                  ? part.chunk.bytes
                  : part.call.paramBytes + part.call.rawBytes,
              latencyMs: null,
              outcome: 'not_attempted',
              reason: fenceReason,
              apiCalls: 0,
              pendingSave: false
            })
            continue
          }
          const partRecord = {
            seq: part.kind === 'provider_chunk' ? part.chunk.seq : part.call.seq,
            kind: part.kind,
            bytes:
              part.kind === 'provider_chunk'
                ? part.chunk.bytes
                : part.call.paramBytes + part.call.rawBytes,
            latencyMs: null,
            outcome: null,
            reason: null,
            apiCalls: 1,
            pendingSave: false
          }
          turn.parts.push(partRecord)
          const next = JSON.parse(JSON.stringify(record))
          let message = next.messages.find((entry) => entry && entry.id === script.messageId)
          if (!message) {
            message = {
              id: script.messageId,
              role: 'assistant',
              content: '',
              timestamp: new Date(part.timestamp).toISOString(),
              runId: script.runId,
              toolActivities: [],
              metadata: options.metadata === undefined ? {} : { ...options.metadata }
            }
            next.messages.push(message)
          }
          if (part.kind === 'provider_chunk') {
            message.content += part.chunk.content
            message.timestamp = new Date(part.timestamp).toISOString()
          } else {
            message.toolActivities.push(part.call.activity)
            message.timestamp = new Date(part.timestamp).toISOString()
          }
          next.updatedAt = part.timestamp
          const raced = await racedCall(() =>
            performTrackedSave(
              ctx,
              { seq: globalSeq++, kind: partRecord.kind, appChatId: chatId },
              next,
              undefined
            )
          )
          if (raced.type === 'settled') {
            const finished = readTime()
            record = next
            if (finished === null) {
              partRecord.outcome = 'completed'
            } else {
              partRecord.outcome = 'completed'
              partRecord.latencyMs = finished - started
            }
          } else if (raced.type === 'rejected') {
            partRecord.outcome = 'failed'
            partRecord.reason =
              raced.error && raced.error.code === 'T2_REPLAY_SAVE_REJECTED'
                ? 'save_rejected'
                : 'save_failed'
          } else if (raced.type === 'timer_failed') {
            partRecord.outcome = 'failed'
            partRecord.reason = 'part_timer_failed'
            stop('part_timer_failed')
          } else {
            cutAttempts.push(raced.attempt)
            partRecord.pendingSave = true
            if (fenceReason === 'part_timeout') {
              partRecord.outcome = 'failed'
              partRecord.reason = 'part_timeout'
            } else {
              partRecord.outcome = 'censored'
              partRecord.reason = fenceReason
            }
          }
        }
        const outcomes = turn.parts.map((entry) => entry.outcome)
        const attempted = turn.parts.some((entry) => entry.outcome !== 'not_attempted')
        turn.outcome = outcomes.includes('failed')
          ? 'failed'
          : outcomes.includes('unsupported')
            ? 'unsupported'
            : turn.parts.some((entry) => entry.pendingSave)
              ? 'incomplete'
              : !attempted
                ? 'not_attempted'
                : outcomes.includes('censored') || outcomes.includes('not_attempted')
                  ? 'censored'
                  : 'completed'
        turn.reason =
          turn.outcome === 'completed'
            ? null
            : (turn.parts.find((entry) => entry.reason) || {}).reason || fenceReason
      }
    }
  } finally {
    clearTimer(timers, deadlineTimer)
    if (cutAttempts.length === 0) {
      release()
    } else {
      Promise.allSettled(cutAttempts).then(release)
    }
  }

  const endedAtMs = readTime()
  const failed =
    clockFailed ||
    turns.some(
      (turn) => turn.outcome === 'failed' || turn.parts.some((part) => part.outcome === 'failed')
    )
  const unsupported = turns.some(
    (turn) =>
      turn.outcome === 'unsupported' || turn.parts.some((part) => part.outcome === 'unsupported')
  )
  const incomplete = turns.some(
    (turn) => turn.parts.some((part) => part.pendingSave) || turn.outcome === 'incomplete'
  )
  const censored = turns.some(
    (turn) =>
      turn.outcome === 'censored' ||
      turn.outcome === 'not_attempted' ||
      turn.parts.some((part) => part.outcome === 'censored' || part.outcome === 'not_attempted')
  )
  const status = failed
    ? 'failed'
    : unsupported
      ? 'unsupported'
      : incomplete
        ? 'incomplete'
        : censored
          ? 'censored'
          : options.diagnosticOnly === true
            ? 'diagnostic'
            : 'complete'
  const completedLatencies = turns
    .flatMap((turn) => turn.parts)
    .filter((part) => part.outcome === 'completed' && part.latencyMs !== null)
    .map((part) => part.latencyMs)
  return {
    ok: status === 'complete',
    status,
    reason: fenceReason,
    replay: true,
    seed,
    providerId,
    chatId,
    scriptFingerprints: turns
      .map((turn) => turn.scriptFingerprint)
      .filter((fingerprint) => fingerprint !== null),
    startedAtMs,
    endedAtMs,
    elapsedMs: startedAtMs === null || endedAtMs === null ? null : endedAtMs - startedAtMs,
    turns,
    completedParts: turns
      .flatMap((turn) => turn.parts)
      .filter((part) => part.outcome === 'completed').length,
    failedParts: turns.flatMap((turn) => turn.parts).filter((part) => part.outcome === 'failed')
      .length,
    unsupportedParts: turns
      .flatMap((turn) => turn.parts)
      .filter((part) => part.outcome === 'unsupported').length,
    censoredParts: turns.flatMap((turn) => turn.parts).filter((part) => part.outcome === 'censored')
      .length,
    notAttemptedParts: turns
      .flatMap((turn) => turn.parts)
      .filter((part) => part.outcome === 'not_attempted').length,
    latencies: percentileSummary(completedLatencies),
    unsupported: [
      ...new Set(
        turns
          .filter((turn) => turn.outcome === 'unsupported')
          .map((turn) => turn.reason)
          .filter((reason) => typeof reason === 'string')
      )
    ],
    pendingSaves: turns.flatMap((turn) =>
      turn.parts
        .filter((part) => part.pendingSave)
        .map((part) => ({ turnIndex: turn.turnIndex, seq: part.seq, kind: part.kind }))
    )
  }
}

/**
 * `--dry-run`: exercise the driver against a scripted in-memory adapter.
 * No Host, no Electron, no providers — proof the driver works, not a
 * measurement.
 */
async function runDryRun() {
  const revisions = new Map()
  const api = {
    async getChat(chatId) {
      if (!revisions.has(chatId)) revisions.set(chatId, 1)
      return { appChatId: chatId, persistenceRevision: revisions.get(chatId), messages: [] }
    },
    async saveChat(chat) {
      const next = (revisions.get(chat.appChatId) || 0) + 1
      revisions.set(chat.appChatId, next)
      return { persistenceRevision: next, updatedAt: 1 }
    }
  }
  return runProviderTurnReplay({
    api,
    chatId: 'dry-provider-chat',
    providerId: 'dry-provider',
    seed: 7,
    turns: 2,
    shape: { chunksPerTurn: 2, chunkBytes: 64, toolCallsPerTurn: 1 },
    partTimeoutMs: 1000,
    deadlineMs: 5000,
    diagnosticOnly: true
  })
}

if (require.main === module) {
  if (process.argv.includes('--dry-run')) {
    runDryRun().then(
      (result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      },
      (error) => {
        process.stderr.write(
          `dry-run failed: ${String(error && error.stack ? error.stack : error)}\n`
        )
        process.exitCode = 1
      }
    )
  } else {
    process.stderr.write('usage: node scripts/perf/deterministicReplayProvider.cjs --dry-run\n')
    process.exitCode = 2
  }
}

module.exports = {
  PROVIDER_TURN_SHAPE_DEFAULTS,
  generateProviderTurnScript,
  runProviderTurnReplay,
  runDryRun
}

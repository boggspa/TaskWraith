'use strict'

/**
 * M1 live lanes, page side (Independent Threads, slice S5a).
 *
 * The live lanes need each Ensemble round's end without reading the chat: a
 * `getChat` of the heavy chat parses 45 MiB on main, and a probe send to a
 * busy chat steers it. The renderer already receives what the lanes need.
 *
 * - The light chat is the selected chat, so each change reaches the page as a
 *   `chat-updated` delivery. `ensemble` rides a snapshot as `chat.ensemble`, a
 *   v1 patch as `record.ensemble` and a v2 patch as `recordDelta.ensemble` (or
 *   `'ensemble'` in `recordCleared`); a v2 patch without it says nothing.
 * - The heavy chat is not, so main sends the page a compact invalidation for
 *   it, as for any chat the sidebar lists, and the lean ensemble projection
 *   keeps `activeRound`. A summary without `ensemble` says nothing.
 *
 * `activeRound.status` is round-level: `running` from beginRound to
 * finishRound, so the gap between two seats never reads as an end.
 *
 * This module builds three page expressions: one adds a listener to each
 * channel, one reads what they saw, one removes them. The listeners never
 * ack (the app's own listener does), never throw into the app's dispatch,
 * and keep only round ids, statuses and page wall-clock times, so no content
 * leaves the page. A chat's deliveries on the other lane's channel are only
 * counted: they mean the renderer's interest in it changed. Each lane keeps
 * its last transitions under a sequence, so a round that starts and ends
 * between two reads is still seen, and a reader that fell behind is told.
 * Each install has its own id: a reloaded page restarts the sequences, and a
 * reader holding the old install's position would otherwise skip the new
 * transitions without a sign.
 */

const LANE_OBSERVER_GLOBAL = '__TASKWRAITH_PERF_LANES__'
const LANE_OBSERVER_VERSION = 1
const LANE_OBSERVER_MAX_TRANSITIONS = 64
const LANE_NAMES = Object.freeze(['light', 'heavy'])
const TERMINAL_ROUND_STATUSES = Object.freeze(['completed', 'cancelled', 'failed'])
// The renderer's own bound on an interest chat id (`chatUpdateInterest.ts`).
const MAX_CHAT_ID_LENGTH = 512

// The three page functions below run as serialised source in the page.

/**
 * Runs in the page (serialised with its config); keep it self-contained.
 * @returns {'installed'|'already_installed'|'installed_for_other_chats'|'api_unavailable'|'install_failed'}
 */
function installLaneObserverInPage(config) {
  var root = window
  var existing = root[config.globalName]
  if (existing) {
    return existing.version === config.version &&
      existing.lanes.light.chatId === config.lightChatId &&
      existing.lanes.heavy.chatId === config.heavyChatId
      ? 'already_installed'
      : 'installed_for_other_chats'
  }
  var api = root.api
  if (
    !api ||
    typeof api.onChatUpdated !== 'function' ||
    typeof api.onChatUpdateInvalidated !== 'function'
  ) {
    return 'api_unavailable'
  }
  function lane(chatId) {
    return {
      chatId: chatId,
      roundId: null,
      status: null,
      changedAtMs: null,
      carrying: 0,
      otherSource: 0,
      nextSeq: 1,
      transitions: []
    }
  }
  var state = {
    version: config.version,
    installId: String(Date.now()) + '-' + String(Math.random()).slice(2, 12),
    faults: 0,
    lanes: { light: lane(config.lightChatId), heavy: lane(config.heavyChatId) },
    unsubscribe: []
  }
  function isObject(value) {
    return value !== null && typeof value === 'object'
  }
  function observe(target, ensemble) {
    var round = isObject(ensemble) ? ensemble.activeRound : null
    var roundId = isObject(round) && typeof round.roundId === 'string' ? round.roundId : null
    var status = roundId !== null && typeof round.status === 'string' ? round.status : null
    target.carrying += 1
    if (roundId === target.roundId && status === target.status) return
    var atMs = Date.now()
    target.roundId = roundId
    target.status = status
    target.changedAtMs = atMs
    target.transitions.push([target.nextSeq, roundId, status, atMs])
    target.nextSeq += 1
    if (target.transitions.length > config.maxTransitions) target.transitions.shift()
  }
  // The ensemble a full delivery speaks for, boxed, or null when it is silent.
  function deliveredEnsemble(delivery) {
    if (delivery.kind === 'snapshot') {
      return isObject(delivery.chat) ? { value: delivery.chat.ensemble } : null
    }
    if (delivery.kind !== 'patch') return null
    if (isObject(delivery.record)) return { value: delivery.record.ensemble }
    var delta = delivery.recordDelta
    if (isObject(delta) && Object.prototype.hasOwnProperty.call(delta, 'ensemble')) {
      return { value: delta.ensemble }
    }
    var cleared = delivery.recordCleared
    return Array.isArray(cleared) && cleared.indexOf('ensemble') >= 0 ? { value: null } : null
  }
  function summaryEnsemble(invalidation) {
    var summary = invalidation.summary
    return isObject(summary) && Object.prototype.hasOwnProperty.call(summary, 'ensemble')
      ? { value: summary.ensemble }
      : null
  }
  function listener(own, other, read) {
    return function (payload) {
      try {
        if (!isObject(payload)) return
        if (payload.chatId === other.chatId) {
          other.otherSource += 1
          return
        }
        if (payload.chatId !== own.chatId) return
        var held = read(payload)
        if (held !== null) observe(own, held.value)
      } catch (_error) {
        state.faults += 1
      }
    }
  }
  try {
    state.unsubscribe.push(
      api.onChatUpdated(listener(state.lanes.light, state.lanes.heavy, deliveredEnsemble))
    )
    state.unsubscribe.push(
      api.onChatUpdateInvalidated(listener(state.lanes.heavy, state.lanes.light, summaryEnsemble))
    )
  } catch (_error) {
    for (var index = 0; index < state.unsubscribe.length; index += 1) {
      try {
        state.unsubscribe[index]()
      } catch (_ignored) {
        // Nothing more to undo.
      }
    }
    return 'install_failed'
  }
  root[config.globalName] = state
  return 'installed'
}

/**
 * Runs in the page. A JSON string (stringified in the page, so the read
 * stays cheap), or null when no observer of this version is installed.
 * Only transitions after `sinceSeq` travel; `firstRetainedSeq` says whether
 * any after it were already dropped.
 */
function readLaneObserverInPage(config) {
  var state = window[config.globalName]
  if (!state || state.version !== config.version) return null
  function copy(lane, sinceSeq) {
    var transitions = []
    for (var index = 0; index < lane.transitions.length; index += 1) {
      if (lane.transitions[index][0] > sinceSeq) transitions.push(lane.transitions[index].slice())
    }
    return {
      chatId: lane.chatId,
      roundId: lane.roundId,
      status: lane.status,
      changedAtMs: lane.changedAtMs,
      carrying: lane.carrying,
      otherSource: lane.otherSource,
      nextSeq: lane.nextSeq,
      firstRetainedSeq: lane.transitions.length > 0 ? lane.transitions[0][0] : lane.nextSeq,
      transitions: transitions
    }
  }
  return JSON.stringify({
    version: state.version,
    installId: state.installId,
    faults: state.faults,
    lanes: {
      light: copy(state.lanes.light, config.sinceSeq.light),
      heavy: copy(state.lanes.heavy, config.sinceSeq.heavy)
    }
  })
}

/** Runs in the page. */
function uninstallLaneObserverInPage(config) {
  var root = window
  var state = root[config.globalName]
  if (!state) return 'not_installed'
  for (var index = 0; index < state.unsubscribe.length; index += 1) {
    try {
      state.unsubscribe[index]()
    } catch (_error) {
      // The listener is gone with its document either way.
    }
  }
  delete root[config.globalName]
  return 'uninstalled'
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validChatId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CHAT_ID_LENGTH &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- ids with control bytes are refused.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/** The observer's page config for two distinct chat ids. */
function laneObserverConfig({ lightChatId, heavyChatId } = {}) {
  if (!validChatId(lightChatId) || !validChatId(heavyChatId)) {
    throw new Error('lane observer needs a light and a heavy chat id')
  }
  if (lightChatId === heavyChatId) throw new Error('lane observer lanes need distinct chats')
  return Object.freeze({
    globalName: LANE_OBSERVER_GLOBAL,
    version: LANE_OBSERVER_VERSION,
    maxTransitions: LANE_OBSERVER_MAX_TRANSITIONS,
    lightChatId,
    heavyChatId
  })
}

function pageCall(pageFunction, config) {
  return `(${pageFunction.toString()})(${JSON.stringify(config)})`
}

function installLaneObserverExpression(config) {
  return pageCall(installLaneObserverInPage, config)
}

function sinceSeqOf(value) {
  const since = { light: 0, heavy: 0 }
  for (const lane of LANE_NAMES) {
    const seq = isPlainObject(value) ? value[lane] : undefined
    if (seq === undefined) continue
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`sinceSeq.${lane} is invalid`)
    since[lane] = seq
  }
  return since
}

function readLaneObserverExpression(config, sinceSeq) {
  return pageCall(readLaneObserverInPage, { ...config, sinceSeq: sinceSeqOf(sinceSeq) })
}

function uninstallLaneObserverExpression(config) {
  return pageCall(uninstallLaneObserverInPage, config)
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function laneReadProblem(lane, chatId, sinceSeq) {
  if (!isPlainObject(lane)) return 'missing'
  if (lane.chatId !== chatId) return 'chat_mismatch'
  if (lane.roundId !== null && typeof lane.roundId !== 'string') return 'round_invalid'
  if (lane.status !== null && typeof lane.status !== 'string') return 'status_invalid'
  if (lane.changedAtMs !== null && !Number.isFinite(lane.changedAtMs)) return 'time_invalid'
  if (!nonNegativeInteger(lane.carrying) || !nonNegativeInteger(lane.otherSource)) {
    return 'count_invalid'
  }
  if (!Number.isSafeInteger(lane.nextSeq) || lane.nextSeq < 1) return 'seq_invalid'
  if (
    !Number.isSafeInteger(lane.firstRetainedSeq) ||
    lane.firstRetainedSeq < 1 ||
    lane.firstRetainedSeq > lane.nextSeq
  ) {
    return 'seq_invalid'
  }
  if (!Array.isArray(lane.transitions)) return 'transitions_invalid'
  let previous = Math.max(sinceSeq, lane.firstRetainedSeq - 1)
  for (const transition of lane.transitions) {
    if (!Array.isArray(transition) || transition.length !== 4) return 'transitions_invalid'
    const [seq, roundId, status, atMs] = transition
    if (!Number.isSafeInteger(seq) || seq !== previous + 1 || seq >= lane.nextSeq) {
      return 'transitions_invalid'
    }
    if (roundId !== null && typeof roundId !== 'string') return 'transitions_invalid'
    if (status !== null && typeof status !== 'string') return 'transitions_invalid'
    if (!Number.isFinite(atMs)) return 'transitions_invalid'
    previous = seq
  }
  if (previous !== Math.max(sinceSeq, lane.nextSeq - 1)) return 'transitions_invalid'
  return null
}

/**
 * Validate a read made with `sinceSeq`. Returns `{ ok: true, installId,
 * lanes, faults }`, where each lane adds `lost`: transitions after `sinceSeq`
 * the page had already dropped. Returns `{ ok: false, reason }` otherwise. A
 * missing observer reads `not_installed` and another install's read
 * `reinstalled` (pass the first read's `installId` as `expectedInstallId`),
 * so a reloaded page is never taken for a quiet one.
 */
function parseLaneObserverRead(text, config, sinceSeq, expectedInstallId) {
  const since = sinceSeqOf(sinceSeq)
  if (text === null || text === undefined) return { ok: false, reason: 'not_installed' }
  let parsed = null
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!isPlainObject(parsed) || parsed.version !== config.version) {
    return { ok: false, reason: 'read_invalid' }
  }
  if (
    !nonNegativeInteger(parsed.faults) ||
    !isPlainObject(parsed.lanes) ||
    typeof parsed.installId !== 'string' ||
    parsed.installId.length === 0
  ) {
    return { ok: false, reason: 'read_invalid' }
  }
  if (expectedInstallId !== undefined && parsed.installId !== expectedInstallId) {
    return { ok: false, reason: 'reinstalled' }
  }
  const lanes = {}
  for (const name of LANE_NAMES) {
    const lane = parsed.lanes[name]
    const chatId = name === 'light' ? config.lightChatId : config.heavyChatId
    const problem = laneReadProblem(lane, chatId, since[name])
    if (problem !== null) return { ok: false, reason: `${name}_${problem}` }
    lanes[name] = {
      roundId: lane.roundId,
      status: lane.status,
      changedAtMs: lane.changedAtMs,
      carrying: lane.carrying,
      otherSource: lane.otherSource,
      nextSeq: lane.nextSeq,
      lost: lane.firstRetainedSeq > since[name] + 1 && lane.nextSeq - 1 > since[name],
      transitions: lane.transitions.map(([seq, roundId, status, atMs]) => ({
        seq,
        roundId,
        status,
        atMs
      }))
    }
  }
  return { ok: true, installId: parsed.installId, faults: parsed.faults, lanes }
}

/** The first transition that ends `roundId`, or null. */
function roundEndIn(transitions, roundId) {
  if (!Array.isArray(transitions) || typeof roundId !== 'string') return null
  const end = transitions.find(
    (transition) =>
      transition.roundId === roundId && TERMINAL_ROUND_STATUSES.includes(transition.status)
  )
  return end ? { status: end.status, atMs: end.atMs, seq: end.seq } : null
}

module.exports = {
  LANE_OBSERVER_GLOBAL,
  LANE_OBSERVER_MAX_TRANSITIONS,
  LANE_OBSERVER_VERSION,
  TERMINAL_ROUND_STATUSES,
  installLaneObserverExpression,
  laneObserverConfig,
  parseLaneObserverRead,
  readLaneObserverExpression,
  roundEndIn,
  uninstallLaneObserverExpression
}

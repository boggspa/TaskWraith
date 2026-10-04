'use strict'

/**
 * A page observer for the rounds of many threads at once.
 *
 * The many-agent workload drives a round on every thread and must learn each
 * round's end without reading a chat: a read costs main the very thing being
 * measured. The page already receives what is needed. Main sends it every
 * change of the open chat in full (`chat-updated`) and a compact summary of
 * every other chat's change (`chat-update-invalidated`), and both carry the
 * thread's `ensemble.activeRound` (see `liveLaneObserver.cjs`, which reads
 * the same two channels for exactly two threads, each on the channel it
 * expects). This observer takes any number of threads on either channel:
 * which thread happens to be open is not its business.
 *
 * `activeRound.status` is round-level: `running` from the round's start to
 * its end, so the gap between two seats never reads as an end.
 *
 * One listener per channel records each change of a thread's round id or
 * status as a transition in one ring under one sequence. A reader therefore
 * keeps a single position however many threads there are, a round that
 * starts and ends between two reads is still seen, and a reader that fell
 * behind is told. Each install has its own id, because a reloaded page
 * starts the sequence again, and a key of the threads it was installed for,
 * so a reader of other threads is refused rather than handed these.
 *
 * Only round ids, statuses, page wall-clock times and counts leave the page;
 * a thread is named by its place in the list the observer was given. The
 * listeners never acknowledge a delivery (the app's own listener does) and
 * never throw into the app's dispatch.
 */

const { createHash } = require('node:crypto')

const THREAD_OBSERVER_GLOBAL = '__TASKWRAITH_PERF_THREADS__'
const THREAD_OBSERVER_VERSION = 1
const THREAD_OBSERVER_MAX_TRANSITIONS = 4096
/** As many chats as main remembers a compact summary for. */
const THREAD_OBSERVER_MAX_THREADS = 256
// The renderer's own bound on an interest chat id (`chatUpdateInterest.ts`).
const MAX_CHAT_ID_LENGTH = 512

// The three page functions below run as serialised source in the page.

/**
 * Runs in the page (serialised with its config); keep it self-contained.
 * @returns {'installed'|'already_installed'|'installed_for_other_chats'|'api_unavailable'|'install_failed'}
 */
function installThreadObserverInPage(config) {
  var root = window
  var existing = root[config.globalName]
  if (existing) {
    return existing.version === config.version && existing.chatIdsKey === config.chatIdsKey
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
  // No prototype: a chat id is looked up, never an inherited name.
  var placeOf = Object.create(null)
  var threads = []
  for (var place = 0; place < config.chatIds.length; place += 1) {
    placeOf[config.chatIds[place]] = place
    threads.push({ roundId: null, status: null, full: 0, compact: 0 })
  }
  var state = {
    version: config.version,
    chatIdsKey: config.chatIdsKey,
    installId: String(Date.now()) + '-' + String(Math.random()).slice(2, 12),
    faults: 0,
    threads: threads,
    nextSeq: 1,
    transitions: [],
    unsubscribe: []
  }
  function isObject(value) {
    return value !== null && typeof value === 'object'
  }
  function observe(place, ensemble) {
    var thread = threads[place]
    var round = isObject(ensemble) ? ensemble.activeRound : null
    var roundId = isObject(round) && typeof round.roundId === 'string' ? round.roundId : null
    var status = roundId !== null && typeof round.status === 'string' ? round.status : null
    if (roundId === thread.roundId && status === thread.status) return
    thread.roundId = roundId
    thread.status = status
    state.transitions.push([state.nextSeq, place, roundId, status, Date.now()])
    state.nextSeq += 1
    if (state.transitions.length > config.maxTransitions) state.transitions.shift()
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
  function listener(channel, read) {
    return function (payload) {
      try {
        if (!isObject(payload) || typeof payload.chatId !== 'string') return
        var place = placeOf[payload.chatId]
        if (place === undefined) return
        threads[place][channel] += 1
        var held = read(payload)
        if (held !== null) observe(place, held.value)
      } catch (_error) {
        state.faults += 1
      }
    }
  }
  try {
    state.unsubscribe.push(api.onChatUpdated(listener('full', deliveredEnsemble)))
    state.unsubscribe.push(api.onChatUpdateInvalidated(listener('compact', summaryEnsemble)))
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
 * stays cheap), or null when no observer of this version is installed. Only
 * transitions after `sinceSeq` travel; `firstRetainedSeq` says whether any
 * after it were already dropped.
 */
function readThreadObserverInPage(config) {
  var state = window[config.globalName]
  if (!state || state.version !== config.version) return null
  if (state.chatIdsKey !== config.chatIdsKey) {
    return JSON.stringify({ version: state.version, mismatch: true })
  }
  var transitions = []
  for (var index = 0; index < state.transitions.length; index += 1) {
    if (state.transitions[index][0] > config.sinceSeq) {
      transitions.push(state.transitions[index].slice())
    }
  }
  var threads = []
  for (var place = 0; place < state.threads.length; place += 1) {
    var thread = state.threads[place]
    threads.push([thread.roundId, thread.status, thread.full, thread.compact])
  }
  return JSON.stringify({
    version: state.version,
    installId: state.installId,
    faults: state.faults,
    threadCount: state.threads.length,
    nextSeq: state.nextSeq,
    // The ring holds consecutive sequences up to the newest.
    firstRetainedSeq: state.nextSeq - state.transitions.length,
    transitions: transitions,
    threads: threads
  })
}

/** Runs in the page. */
function uninstallThreadObserverInPage(config) {
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

/** The observer's page config for a list of distinct chat ids, in order. */
function threadObserverConfig({ chatIds } = {}) {
  if (
    !Array.isArray(chatIds) ||
    chatIds.length === 0 ||
    chatIds.length > THREAD_OBSERVER_MAX_THREADS
  ) {
    throw new Error(`the thread observer needs 1 to ${THREAD_OBSERVER_MAX_THREADS} chat ids`)
  }
  if (!chatIds.every(validChatId)) {
    throw new Error('the thread observer was given an invalid chat id')
  }
  if (new Set(chatIds).size !== chatIds.length) {
    throw new Error('the thread observer was given a chat id twice')
  }
  return Object.freeze({
    globalName: THREAD_OBSERVER_GLOBAL,
    version: THREAD_OBSERVER_VERSION,
    maxTransitions: THREAD_OBSERVER_MAX_TRANSITIONS,
    chatIds: Object.freeze([...chatIds]),
    // What a read is checked against, so a read need not carry every id.
    chatIdsKey: createHash('sha256').update(JSON.stringify(chatIds)).digest('hex').slice(0, 16)
  })
}

function pageCall(pageFunction, config) {
  return `(${pageFunction.toString()})(${JSON.stringify(config)})`
}

function installThreadObserverExpression(config) {
  return pageCall(installThreadObserverInPage, config)
}

function sinceSeqOf(value) {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('sinceSeq is invalid')
  return value
}

function readThreadObserverExpression(config, sinceSeq) {
  return pageCall(readThreadObserverInPage, {
    globalName: config.globalName,
    version: config.version,
    chatIdsKey: config.chatIdsKey,
    sinceSeq: sinceSeqOf(sinceSeq)
  })
}

function uninstallThreadObserverExpression(config) {
  return pageCall(uninstallThreadObserverInPage, { globalName: config.globalName })
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function textOrNull(value) {
  return value === null || typeof value === 'string'
}

/**
 * Validate a read made with `sinceSeq`. Returns `{ ok: true, installId,
 * faults, nextSeq, lost, transitions, threads }`: each transition names its
 * thread's place and chat id, `threads` is every thread's current round and
 * how many deliveries each channel carried for it, and `lost` says
 * transitions after `sinceSeq` had already been dropped. Returns
 * `{ ok: false, reason }` otherwise: a missing observer reads
 * `not_installed`, another install's read `reinstalled` (pass the first
 * read's `installId` as `expectedInstallId`), and an observer of other
 * threads `chat_mismatch`.
 */
function parseThreadObserverRead(text, config, sinceSeq, expectedInstallId) {
  const since = sinceSeqOf(sinceSeq)
  if (text === null || text === undefined) return { ok: false, reason: 'not_installed' }
  let parsed = null
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!parsed || parsed.version !== config.version) return { ok: false, reason: 'read_invalid' }
  if (parsed.mismatch === true) return { ok: false, reason: 'chat_mismatch' }
  if (
    !nonNegativeInteger(parsed.faults) ||
    typeof parsed.installId !== 'string' ||
    parsed.installId.length === 0
  ) {
    return { ok: false, reason: 'read_invalid' }
  }
  if (expectedInstallId !== undefined && parsed.installId !== expectedInstallId) {
    return { ok: false, reason: 'reinstalled' }
  }
  const { chatIds } = config
  if (parsed.threadCount !== chatIds.length) return { ok: false, reason: 'thread_count_mismatch' }
  const { nextSeq, firstRetainedSeq } = parsed
  if (
    !Number.isSafeInteger(nextSeq) ||
    !Number.isSafeInteger(firstRetainedSeq) ||
    firstRetainedSeq < 1 ||
    firstRetainedSeq > nextSeq
  ) {
    return { ok: false, reason: 'seq_invalid' }
  }

  const invalidTransitions = { ok: false, reason: 'transitions_invalid' }
  if (!Array.isArray(parsed.transitions)) return invalidTransitions
  const transitions = []
  let previous = Math.max(since, firstRetainedSeq - 1)
  for (const row of parsed.transitions) {
    if (!Array.isArray(row) || row.length !== 5) return invalidTransitions
    const [seq, thread, roundId, status, atMs] = row
    if (
      seq !== previous + 1 ||
      !nonNegativeInteger(thread) ||
      thread >= chatIds.length ||
      !textOrNull(roundId) ||
      !textOrNull(status) ||
      !Number.isFinite(atMs)
    ) {
      return invalidTransitions
    }
    transitions.push({ seq, thread, chatId: chatIds[thread], roundId, status, atMs })
    previous = seq
  }
  // They run up to the newest, and no further.
  if (previous !== Math.max(since, nextSeq - 1)) return invalidTransitions

  const invalidThreads = { ok: false, reason: 'threads_invalid' }
  if (!Array.isArray(parsed.threads) || parsed.threads.length !== chatIds.length) {
    return invalidThreads
  }
  const threads = []
  for (const [place, row] of parsed.threads.entries()) {
    if (!Array.isArray(row) || row.length !== 4) return invalidThreads
    const [roundId, status, full, compact] = row
    if (
      !textOrNull(roundId) ||
      !textOrNull(status) ||
      !nonNegativeInteger(full) ||
      !nonNegativeInteger(compact)
    ) {
      return invalidThreads
    }
    threads.push({ chatId: chatIds[place], roundId, status, full, compact })
  }
  return {
    ok: true,
    installId: parsed.installId,
    faults: parsed.faults,
    nextSeq,
    lost: firstRetainedSeq > since + 1,
    transitions,
    threads
  }
}

module.exports = {
  THREAD_OBSERVER_GLOBAL,
  THREAD_OBSERVER_MAX_THREADS,
  THREAD_OBSERVER_MAX_TRANSITIONS,
  THREAD_OBSERVER_VERSION,
  installThreadObserverExpression,
  parseThreadObserverRead,
  readThreadObserverExpression,
  threadObserverConfig,
  uninstallThreadObserverExpression
}

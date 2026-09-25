'use strict'

/**
 * M1 live lanes inside a T2 run (Independent Threads, slice S5d):
 * `runT2Baseline --live-lanes`.
 *
 * The phase runs once the live-round warm-up and smoke (S6) have settled on
 * the light chat. It opens the light chat as a user would (the app boots to
 * a new draft, and only the open chat's changes reach the page in full, which
 * the light lane's observer reads), starts the heavy lane (S5b) on the heavy
 * chat, waits a lead-in so the heavy chat's first round is past its start-up,
 * runs the measured windows (S5c) with the light lane beside it, and stops
 * both lanes.
 *
 * Evidence arrives through four bounded readers:
 * - main's spans: the S3a handle, evaluated through main's inspector;
 * - main's D1 counters: `getMainPerfSnapshot` through the page, at fences;
 * - the Host's spans: the runner's window sampler reads the Host snapshot
 *   file on the runner's own loop (never a measured process) with its
 *   recent-span tail and hands each accepted read to the S3b union; the
 *   sampler itself keeps only the tail-less read;
 * - each lane's model turns: the scripted daemon's record for the lane
 *   chat's own model tag, from the harness's loopback route.
 *
 * A lane that cannot start (the light chat would not open, the observer
 * refused, the heavy lane's first round never seen) is a verdict reason, not
 * a thrown run: the report is still written and the run's result is not ok.
 * The lanes and the sampler are stopped on every path, and then the phase
 * tidies the page: it cancels a lane round that may still be running (the
 * heavy lane is stopped mid-round) so the phases after it do not run beside
 * it, and removes the observer, each once, bounded, and reported.
 */

const { awaitWithTimeout } = require('./boundedAwait.cjs')
const { aggregateHostWindowSamples } = require('./collectors/hostSpans.cjs')
const { createHostRecentSpanUnion } = require('./collectors/hostRecentSpanWindows.cjs')
const {
  DEFAULT_LIVE_LANE_WINDOW_OPTIONS,
  liveLaneWindowsVerdict,
  mainWorkSpanWindowExpression,
  runLiveLaneWindows
} = require('./liveLaneWindows.cjs')
const { uninstallLaneObserverExpression, laneObserverConfig } = require('./liveLaneObserver.cjs')
const { cancelRoundExpression, createLiveLanes } = require('./liveRoundLanes.cjs')
const { readD1Counters } = require('./liveRounds.cjs')

const DEFAULT_OPTIONS = Object.freeze({
  callTimeoutMs: 60_000,
  openChatTimeoutMs: 30_000,
  heavyLeadInMs: 10_000,
  cancelEvery: 3,
  cancelAfterMs: 1_500
})
/** How long past its own bound a main read may take before the runner gives up. */
const MAIN_READ_BACKSTOP_MS = 1_000
/** The sidebar's Recents rows (`SidebarCompactChatRow`); each names its chat id. */
const RECENTS_ROW_CLASS = 'sidebar-recents-item'
/** The main pane's title for its current chat (`MainAppLayout`). */
const CURRENT_CHAT_TITLE_SELECTOR = '.app-transcript .chat-corner-thread-title'
const OPEN_CHAT_POLL_MS = 250

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One S3a read through main's inspector: the text the handle stringified in
 * main, or null when main answered with no handle. The per-send bound is
 * the transport's; the outer one covers a transport that ignores it.
 */
async function readMainWorkSpanWindow(session, query, timeoutMs) {
  const reply = await awaitWithTimeout(
    Promise.resolve().then(() =>
      session.post(
        'Runtime.evaluate',
        {
          expression: mainWorkSpanWindowExpression(query),
          returnByValue: true,
          awaitPromise: false
        },
        { timeoutMs }
      )
    ),
    timeoutMs + MAIN_READ_BACKSTOP_MS,
    'main work-span read'
  )
  if (!isPlainObject(reply) || reply.exceptionDetails || !isPlainObject(reply.result)) {
    throw new Error('main work-span read failed')
  }
  return reply.result.value === undefined ? null : reply.result.value
}

/** The one model every seat of a chat runs, or null when they differ or none is named. */
function chatSeatModel(chat) {
  const seats =
    isPlainObject(chat) && isPlainObject(chat.ensemble) && Array.isArray(chat.ensemble.participants)
      ? chat.ensemble.participants
      : []
  const models = new Set(
    seats.map((seat) => (isPlainObject(seat) && typeof seat.model === 'string' ? seat.model : ''))
  )
  const [model] = models
  return seats.length > 0 && models.size === 1 && model.length > 0 ? model : null
}

/**
 * A live fixture's two lane chats: the light chat first, then the heavy chat
 * with more seats, each of whose seats all run one model tag of the chat's
 * own (the daemon tells the lanes' turns apart by tag). Any other fixture is
 * refused.
 */
function liveLaneChatsOf(fixture) {
  const chats = isPlainObject(fixture) && Array.isArray(fixture.chats) ? fixture.chats : []
  const shapes =
    isPlainObject(fixture) &&
    isPlainObject(fixture.shape) &&
    Array.isArray(fixture.shape.chatShapes)
      ? fixture.shape.chatShapes
      : []
  const ids = chats.map((chat) => (isPlainObject(chat) ? chat.appChatId : undefined))
  const seats = shapes.map((shape) => (isPlainObject(shape) ? shape.seatCount : undefined))
  if (
    ids.length !== 2 ||
    seats.length !== 2 ||
    ids.some((id) => typeof id !== 'string' || id.length === 0) ||
    ids[0] === ids[1] ||
    !seats.every((count) => Number.isSafeInteger(count)) ||
    !(seats[0] < seats[1])
  ) {
    const error = new Error(
      'Refusing --live-lanes: the fixture needs a light chat and then a heavy chat with more seats'
    )
    error.code = 'T2_LIVE_LANES_FIXTURE'
    throw error
  }
  const titles = chats.map((chat) => chat.title)
  if (typeof titles[0] !== 'string' || titles[0].length === 0 || titles[0] === titles[1]) {
    const error = new Error('Refusing --live-lanes: the light chat needs a title of its own')
    error.code = 'T2_LIVE_LANES_FIXTURE'
    throw error
  }
  const models = chats.map(chatSeatModel)
  if (models.some((model) => model === null) || models[0] === models[1]) {
    const error = new Error(
      'Refusing --live-lanes: each lane chat needs every seat on one model tag of its own'
    )
    error.code = 'T2_LIVE_LANES_FIXTURE'
    throw error
  }
  return {
    light: ids[0],
    heavy: ids[1],
    lightTitle: titles[0],
    lightModel: models[0],
    heavyModel: models[1]
  }
}

/**
 * Page expression: click the chat's Recents row in the sidebar, which selects
 * it as a user's click does. Answers 'clicked' or 'row_missing'.
 */
function clickRecentsRowExpression(chatId) {
  return (
    `(function(){ var id = ${JSON.stringify(chatId)}; ` +
    `var rows = document.getElementsByClassName(${JSON.stringify(RECENTS_ROW_CLASS)}); ` +
    'for (var i = 0; i < rows.length; i += 1) { ' +
    "if (rows[i].getAttribute('data-sidebar-thread-id') === id) { rows[i].click(); return 'clicked'; } } " +
    "return 'row_missing'; })()"
  )
}

/**
 * Page expression: whether the chat is open, as `{ rowActive, title }`: the
 * sidebar marks its row selected, and the title the main pane shows for its
 * current chat (null without one). The sidebar can mark a clicked row before
 * the main pane has caught up, so the runner needs both.
 */
function openedChatExpression(chatId) {
  return (
    `(function(){ var id = ${JSON.stringify(chatId)}; var rowActive = false; ` +
    `var rows = document.getElementsByClassName(${JSON.stringify(RECENTS_ROW_CLASS)}); ` +
    'for (var i = 0; i < rows.length; i += 1) { ' +
    "if (rows[i].getAttribute('data-sidebar-thread-id') === id) { rowActive = rows[i].classList.contains('active'); break; } } " +
    `var title = document.querySelector(${JSON.stringify(CURRENT_CHAT_TITLE_SELECTOR)}); ` +
    "return { rowActive: rowActive, title: title ? title.getAttribute('title') : null }; })()"
  )
}

/**
 * Open a chat from the sidebar and wait until the sidebar marks it selected
 * and the main pane shows its title. Resolves null once both hold, or the
 * reason they did not; nothing is retried.
 */
async function openLaneChat({ page, chatId, title, nowMs, sleep, callTimeoutMs, timeoutMs }) {
  const call = (expression, what) =>
    awaitWithTimeout(
      Promise.resolve().then(() => page.evaluate(expression)),
      callTimeoutMs,
      what
    )
  try {
    const clicked = await call(clickRecentsRowExpression(chatId), 'open the light chat')
    if (clicked !== 'clicked') {
      return clicked === 'row_missing' ? 'light_chat_row_missing' : 'light_chat_click_invalid'
    }
    const deadlineMs = nowMs() + timeoutMs
    for (;;) {
      const opened = await call(openedChatExpression(chatId), 'opened chat')
      if (isPlainObject(opened) && opened.rowActive === true && opened.title === title) return null
      if (nowMs() >= deadlineMs) return 'light_chat_not_opened'
      await sleep(OPEN_CHAT_POLL_MS)
    }
  } catch {
    return 'light_chat_call_failed'
  }
}

/**
 * Whether a lane may have left a round running once the lanes stopped: its
 * last round was never seen to end, the lane failed (a send that timed out
 * may still have started one), or the lanes' snapshot is missing. The heavy
 * lane is stopped mid-round, so its answer is normally yes.
 */
function laneMayBeRunning(snapshot, lane) {
  const state = isPlainObject(snapshot) && isPlainObject(snapshot[lane]) ? snapshot[lane] : null
  if (state === null || !Array.isArray(state.rounds)) return true
  if (state.failure !== null && state.failure !== undefined) return true
  const last = state.rounds[state.rounds.length - 1]
  return isPlainObject(last) && last.endedAtMs === null
}

/**
 * Tidy the page once the lanes have stopped: cancel each lane chat's round
 * that may still be running (the phases after this one must not run beside
 * it; a cancel on an idle chat answers false and does nothing), then remove
 * the observer. Each step is one bounded call whose outcome is reported;
 * none throws.
 */
async function tidyLanes({ page, snapshot, lightChatId, heavyChatId, callTimeoutMs }) {
  const call = async (expression, what) => {
    try {
      return {
        value: await awaitWithTimeout(
          Promise.resolve().then(() => page.evaluate(expression)),
          callTimeoutMs,
          what
        )
      }
    } catch {
      return { failed: true }
    }
  }
  const cancel = async (lane, chatId) => {
    if (!laneMayBeRunning(snapshot, lane)) return 'not_running'
    const reply = await call(cancelRoundExpression(chatId), `cancel the ${lane} round`)
    if (reply.failed || !isPlainObject(reply.value) || reply.value.ok !== true) return 'failed'
    return reply.value.cancelled === true ? 'cancelled' : 'not_cancelled'
  }
  const light = await cancel('light', lightChatId)
  const heavy = await cancel('heavy', heavyChatId)
  const removed = await call(
    uninstallLaneObserverExpression(laneObserverConfig({ lightChatId, heavyChatId })),
    'lane observer uninstall'
  )
  const observer = removed.failed
    ? 'failed'
    : removed.value === 'uninstalled' || removed.value === 'not_installed'
      ? removed.value
      : 'invalid'
  return { light, heavy, observer }
}

/** A lane that could not start, named by the lanes' own code and reason. */
function laneStartFailure(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (!code.startsWith('T2_LIVE_')) return null
  const reason = typeof error.reason === 'string' && error.reason ? error.reason : code
  return `lanes_not_started:${reason}`.slice(0, 200)
}

/**
 * Run the live-lane phase.
 *
 * @param {{
 *   page: { evaluate(expression: string): Promise<unknown> },
 *   mainSession: { post(method: string, params?: object, sendOptions?: object): Promise<unknown> },
 *   lightChatId: string, lightChatTitle: string, heavyChatId: string,
 *   laneModels: { light: string, heavy: string },
 *   readDaemonActivity: (query: { model: string, fromMs: number, toMs: number }) =>
 *     Promise<{ started: number, done: number, busyMs: number, maxQuietMs: number }>,
 *   createHostSampler: (union: { add(sample: object): object }) =>
 *     { start(): Promise<boolean>, stop(): { samples?: object[] } & Record<string, unknown> },
 *   createLanes?: typeof createLiveLanes,
 *   nowMs?: () => number, sleep?: (ms: number) => Promise<void>,
 *   callTimeoutMs?: number, openChatTimeoutMs?: number, heavyLeadInMs?: number,
 *   cancelEvery?: number, cancelAfterMs?: number,
 *   laneOptions?: object, windowOptions?: object,
 *   onWindow?: (window: object) => void
 * }} options
 */
async function runT2LiveLanes(options) {
  if (!isPlainObject(options) || !options.page || typeof options.page.evaluate !== 'function') {
    throw new Error('runT2LiveLanes needs a page adapter')
  }
  if (!options.mainSession || typeof options.mainSession.post !== 'function') {
    throw new Error('runT2LiveLanes needs main’s inspector session')
  }
  if (typeof options.createHostSampler !== 'function') {
    throw new Error('runT2LiveLanes needs a Host sampler factory')
  }
  if (typeof options.lightChatTitle !== 'string' || options.lightChatTitle.length === 0) {
    throw new Error('runT2LiveLanes needs the light chat’s title')
  }
  const laneModels = isPlainObject(options.laneModels) ? options.laneModels : {}
  if (
    typeof options.readDaemonActivity !== 'function' ||
    typeof laneModels.light !== 'string' ||
    typeof laneModels.heavy !== 'string' ||
    laneModels.light.length === 0 ||
    laneModels.heavy.length === 0 ||
    laneModels.light === laneModels.heavy
  ) {
    throw new Error('runT2LiveLanes needs a daemon activity reader and one model tag per lane')
  }
  const settings = {}
  for (const name of Object.keys(DEFAULT_OPTIONS)) {
    const value = options[name] === undefined ? DEFAULT_OPTIONS[name] : options[name]
    if (!Number.isSafeInteger(value) || value < 0 || (value === 0 && name !== 'cancelEvery')) {
      throw new Error(
        `${name} must be a ${name === 'cancelEvery' ? 'non-negative' : 'positive'} integer`
      )
    }
    settings[name] = value
  }
  const { page, mainSession, lightChatId, heavyChatId } = options
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const windowOptions = isPlainObject(options.windowOptions) ? options.windowOptions : {}
  const lanes = (options.createLanes || createLiveLanes)({
    page,
    lightChatId,
    heavyChatId,
    nowMs,
    sleep,
    callTimeoutMs: settings.callTimeoutMs,
    cancelEvery: settings.cancelEvery,
    cancelAfterMs: settings.cancelAfterMs,
    ...(isPlainObject(options.laneOptions) ? options.laneOptions : {})
  })
  const union = createHostRecentSpanUnion()
  const sampler = options.createHostSampler(union)

  const expected =
    windowOptions.windows === undefined
      ? DEFAULT_LIVE_LANE_WINDOW_OPTIONS.windows
      : windowOptions.windows
  let windowsResult = null
  let startFailure = null
  let lanesSnapshot = null
  let samplerSummary = null
  let teardown = null
  try {
    const samplerStarted = (await sampler.start()) === true
    const notOpened = await openLaneChat({
      page,
      chatId: lightChatId,
      title: options.lightChatTitle,
      nowMs,
      sleep,
      callTimeoutMs: settings.callTimeoutMs,
      timeoutMs: settings.openChatTimeoutMs
    })
    if (notOpened !== null) startFailure = `lanes_not_started:${notOpened}`
    else {
      try {
        await lanes.install()
        await lanes.startHeavy()
      } catch (error) {
        startFailure = laneStartFailure(error)
        if (startFailure === null) throw error
      }
    }
    if (startFailure === null) {
      await sleep(settings.heavyLeadInMs)
      windowsResult = await runLiveLaneWindows({
        ...windowOptions,
        lanes,
        lightChatId,
        heavyChatId,
        readMainWindow: (query) =>
          readMainWorkSpanWindow(mainSession, query, settings.callTimeoutMs),
        readD1Counters: () => readD1Counters(page, { timeoutMs: settings.callTimeoutMs }),
        // The daemon keys whole milliseconds; widen a fractional range outward.
        readLaneActivity: (lane, range) =>
          options.readDaemonActivity({
            model: laneModels[lane],
            fromMs: Math.floor(range.fromMs),
            toMs: Math.ceil(range.toMs)
          }),
        hostUnion: samplerStarted ? union : null,
        nowMs,
        sleep,
        ...(typeof options.onWindow === 'function' ? { onWindow: options.onWindow } : {})
      })
    }
  } finally {
    try {
      lanesSnapshot = await lanes.stop()
    } finally {
      try {
        samplerSummary = sampler.stop()
      } finally {
        teardown = await tidyLanes({
          page,
          snapshot: lanesSnapshot,
          lightChatId,
          heavyChatId,
          callTimeoutMs: settings.callTimeoutMs
        })
      }
    }
  }

  const windows = windowsResult ? windowsResult.windows : []
  const verdict = windowsResult
    ? windowsResult.verdict
    : liveLaneWindowsVerdict([], expected, [startFailure])
  const samples =
    isPlainObject(samplerSummary) && Array.isArray(samplerSummary.samples)
      ? samplerSummary.samples
      : []
  const hostSampler = isPlainObject(samplerSummary) ? { ...samplerSummary } : null
  if (hostSampler) delete hostSampler.samples
  // Host lag per window from the same reads (T9c's fold, window bounds only).
  const hostLag =
    windows.length === 0
      ? null
      : aggregateHostWindowSamples({
          samples,
          windows: windows.map((window) => ({
            role: window.role,
            repetition: window.repetition,
            startedAtMs: window.startedAtMs,
            endedAtMs: window.endedAtMs,
            outcome: window.reasons.length === 0 ? 'eligible' : 'censored',
            reason: window.reasons.length === 0 ? null : window.reasons[0]
          }))
        })
  return {
    schemaVersion: 1,
    chats: { light: lightChatId, heavy: heavyChatId },
    models: { light: laneModels.light, heavy: laneModels.heavy },
    options: { ...settings },
    windows,
    hostLag: hostLag === null ? null : hostLag.ok ? hostLag.evidence : { error: hostLag.reason },
    lanes: lanesSnapshot,
    hostSampler,
    teardown,
    verdict
  }
}

/**
 * What the phase's teardown left undone, as cleanup failures: a lane round
 * it could not cancel, or an observer it could not remove. The windows were
 * judged before the teardown, so these never touch the verdict; they tell a
 * reader that what ran after the phase may have run beside them.
 */
function liveLanesTeardownFailures(lanes) {
  const teardown = isPlainObject(lanes) && isPlainObject(lanes.teardown) ? lanes.teardown : null
  if (teardown === null) return []
  const failures = []
  for (const lane of ['light', 'heavy']) {
    if (teardown[lane] === 'failed') {
      failures.push(`the ${lane} lane's round could not be cancelled`)
    }
  }
  if (teardown.observer === 'failed' || teardown.observer === 'invalid') {
    failures.push(`the lane observer could not be removed (${teardown.observer})`)
  }
  return failures
}

/**
 * The live-round verdict with the lanes' folded in, each lanes reason
 * prefixed; the lanes never ran when `lanes` is null.
 */
function withLiveLanesVerdict(roundsVerdict, lanes) {
  const base = isPlainObject(roundsVerdict) ? roundsVerdict : { ok: false, reasons: [] }
  const lanesVerdict = isPlainObject(lanes) && isPlainObject(lanes.verdict) ? lanes.verdict : null
  const reasons = [...base.reasons]
  if (lanesVerdict === null) reasons.push('lanes: not run')
  else reasons.push(...lanesVerdict.reasons.map((reason) => `lanes: ${reason}`))
  return {
    ok: base.ok === true && lanesVerdict !== null && lanesVerdict.ok === true,
    reasons
  }
}

module.exports = {
  DEFAULT_T2_LIVE_LANE_OPTIONS: DEFAULT_OPTIONS,
  clickRecentsRowExpression,
  liveLaneChatsOf,
  liveLanesTeardownFailures,
  openedChatExpression,
  readMainWorkSpanWindow,
  runT2LiveLanes,
  withLiveLanesVerdict
}

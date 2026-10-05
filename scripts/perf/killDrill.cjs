'use strict'

/**
 * The kill drill: what a crash of the app keeps of what it acknowledged.
 *
 * The harness launches its own isolated app on the many-agent workload and
 * keeps a round running on every thread. Once every thread has seen rounds
 * end, with rounds still running, it kills that app as a crash would:
 * SIGKILL to the exact process group it spawned and recorded, and to
 * nothing else. The app's Host is detached by design and lives on, as it
 * does when the app crashes, and so does the scripted model its seats talk
 * to. The harness then launches the app again on the same profile, writing
 * nothing to it first, and reads every thread back through the page's own
 * `window.api.getChat`. Everything the first launch acknowledged before the
 * kill must be there:
 *
 * - every user message whose send was acknowledged: `runEnsembleRound`
 *   answered `started`, which main does only once the round's first record
 *   is on disk;
 * - every round the page observer saw end, with its seats' runs final.
 *
 * What was lost that was never acknowledged is reported and allowed. A power
 * cut cannot be simulated this way: the kernel still writes out what the
 * killed app had handed it. The log lane's file-system tests cover that.
 *
 * Afterwards the drill stops the Host by the identity it recorded, through
 * the Host's own CLI scoped to the drill's profile and the recorded pid and
 * birth, stops the model, and lists what the run left in the temporary
 * folder and in its isolated home. It removes nothing in either.
 */

const { execFile, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const { TERMINAL_ROUND_STATUSES } = require('./liveLaneObserver.cjs')
const { liveRoundPrompt, startScriptedDaemonChild } = require('./liveRounds.cjs')
const { createManyAgentLanes, manyAgentPrompt } = require('./manyAgentRounds.cjs')
const { isolatedHomeEnvironment } = require('./isolatedHome.cjs')
const { resolveUnpackagedDevUserDataPath } = require('./devUserDataPath.cjs')

const KILLED_CODE = 'T2_KILL_DRILL_KILLED'
const DEFAULT_OPTIONS = Object.freeze({
  endedRoundsBeforeKill: 2,
  pollMs: 250,
  leadInTimeoutMs: 600_000,
  groupGoneTimeoutMs: 15_000,
  readyTimeoutMs: 120_000,
  readyPollMs: 500
})
/** A seat's run that is still going: never the state of a run in a round that ended. */
const NON_FINAL_RUN_STATUSES = Object.freeze(['running', 'sleeping'])
/** A lane's send that no answer of `started` followed, by what stopped the lane. */
const UNANSWERED_SEND_FAILURES = new Set(['send_failed', 'not_started'])
/** The only prompt texts a read-back carries back: the drill's own, never a user's. */
const LANE_PROMPT_PATTERN = '^Many agents, thread \\d+, round \\d+: answer briefly\\.$'
const LIVE_PROMPT_PATTERN = '^M1 live [a-z_]+ round: answer briefly\\.$'
/** Arguments the drill gives each launch itself. */
const DRILL_ARGUMENTS = [
  '--materialize-instance-userdata',
  '--reuse-instance-userdata',
  '--artifact-dir=',
  '--out-dir=',
  '--dry-run'
]

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function option(options, name) {
  const value = options[name] === undefined ? DEFAULT_OPTIONS[name] : options[name]
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`)
  }
  return value
}

/**
 * Whether the drill may kill now: every thread has seen at least
 * `endedRoundsBeforeKill` rounds end, a round is still running on at least
 * one, and no thread has failed.
 */
function killReadiness(snapshot, endedRoundsBeforeKill) {
  const threads = isPlainObject(snapshot) && Array.isArray(snapshot.threads) ? snapshot.threads : []
  const ended = threads.map(
    (thread) => thread.rounds.filter((round) => round.endedAtMs !== null).length
  )
  const running = threads.filter((thread) => {
    const last = thread.rounds[thread.rounds.length - 1]
    return last !== undefined && last.endedAtMs === null
  }).length
  const failures = threads
    .map((thread, place) => (thread.failure === null ? null : { place, failure: thread.failure }))
    .filter(Boolean)
  return {
    ready:
      failures.length === 0 &&
      ended.every((count) => count >= endedRoundsBeforeKill) &&
      running > 0,
    endedByThread: ended,
    threadsWithARoundRunning: running,
    failures
  }
}

/**
 * Every send the first launch made, by thread: the rounds the run sent
 * before the phase (its warm-up and smoke), then each lane's, in order.
 * A send is acknowledged when its answer was `started` with a round id, or
 * `steered`; it was seen to end when the observer saw its round end.
 *
 * A lane's rounds are its sends 1, 2, ... in order: a send that is not
 * answered `started` stops the lane, so only its last send can be one
 * without a round.
 */
function drillRecordOf({ threads, snapshot, priorRounds }) {
  const entries = threads.map((thread, place) => ({ place, chatId: thread.chatId, sends: [] }))
  const byChat = new Map(entries.map((entry) => [entry.chatId, entry]))
  for (const round of Array.isArray(priorRounds) ? priorRounds : []) {
    const entry = isPlainObject(round) ? byChat.get(round.chatId) : undefined
    if (entry === undefined || typeof round.purpose !== 'string') continue
    const acknowledged = round.status === 'started' && typeof round.roundId === 'string'
    entry.sends.push({
      source: round.purpose,
      prompt: liveRoundPrompt(round.purpose),
      acknowledged,
      roundId: acknowledged ? round.roundId : null,
      // The smoke's driver settles a round only once it has ended.
      seenToEnd: acknowledged && round.outcome === 'settled',
      endStatus: acknowledged ? (round.roundStatus ?? null) : null,
      ...(acknowledged ? {} : { unanswered: round.outcome ?? 'not_started' })
    })
  }
  const laneThreads =
    isPlainObject(snapshot) && Array.isArray(snapshot.threads) ? snapshot.threads : []
  // The lanes were made from the same threads, in the same order.
  for (const [place, thread] of laneThreads.entries()) {
    const entry = entries[place]
    for (const [at, round] of thread.rounds.entries()) {
      entry.sends.push({
        source: 'lane',
        index: at + 1,
        prompt: manyAgentPrompt(place, at + 1),
        acknowledged: true,
        roundId: round.roundId,
        seenToEnd: round.endedAtMs !== null,
        endStatus: round.status,
        acceptedAtMs: round.acceptedAtMs,
        endedAtMs: round.endedAtMs
      })
    }
    const next = thread.rounds.length + 1
    if (thread.failure === 'steered') {
      entry.sends.push({
        source: 'lane',
        index: next,
        prompt: manyAgentPrompt(place, next),
        acknowledged: true,
        steered: true,
        roundId: null,
        seenToEnd: false,
        endStatus: null
      })
    } else if (UNANSWERED_SEND_FAILURES.has(thread.failure)) {
      entry.sends.push({
        source: 'lane',
        index: next,
        prompt: manyAgentPrompt(place, next),
        acknowledged: false,
        roundId: null,
        seenToEnd: false,
        endStatus: null,
        unanswered: thread.failure
      })
    }
  }
  return entries
}

function error(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/**
 * The first launch's phase: rounds on every thread, then the kill once the
 * drill may make it. The lanes stop just before the kill, so the record is
 * exact: no send is made after it, and the app's rounds run on until the
 * kill takes them. The record goes to `onRecord` before the phase ends, so
 * a launch that unwinds by an error still leaves it. After the kill the
 * phase throws `T2_KILL_DRILL_KILLED`: nothing after it in the run can be
 * measured, and the run's own cleanup still runs.
 *
 * @param {{
 *   killChild: () => Promise<object>,
 *   onRecord: (record: object) => void,
 *   endedRoundsBeforeKill?: number, pollMs?: number,
 *   createLanes?: typeof createManyAgentLanes
 * }} options
 */
function createDriveAndKill(options) {
  if (!isPlainObject(options) || typeof options.killChild !== 'function') {
    throw new Error('the kill drill needs a way to kill the app it launched')
  }
  if (typeof options.onRecord !== 'function') throw new Error('the kill drill needs onRecord')
  const endedRoundsBeforeKill = option(options, 'endedRoundsBeforeKill')
  const pollMs = option(options, 'pollMs')
  const createLanes = options.createLanes || createManyAgentLanes
  return async function driveAndKill(input) {
    const threads = Array.isArray(input.threads) ? input.threads : []
    if (threads.length === 0) throw new Error('the kill drill needs the threads to drive')
    const nowMs = input.nowMs || Date.now
    const sleep = input.sleep || defaultSleep
    const leadInTimeoutMs = option(input, 'leadInTimeoutMs')
    const lanes = createLanes({
      page: input.page,
      chatIds: threads.map((thread) => thread.chatId),
      nowMs,
      sleep,
      ...(isPlainObject(input.laneOptions) ? input.laneOptions : {})
    })
    await lanes.install()
    lanes.start()
    const startedAtMs = nowMs()
    let outcome = null
    let readiness = null
    for (;;) {
      readiness = killReadiness(lanes.snapshot(), endedRoundsBeforeKill)
      if (readiness.failures.length > 0) outcome = 'thread_failed_before_kill'
      else if (readiness.ready) outcome = 'killed'
      else if (nowMs() - startedAtMs >= leadInTimeoutMs) outcome = 'kill_condition_not_reached'
      if (outcome !== null) break
      await sleep(pollMs)
    }
    const final = await lanes.stop()
    // The cut: what the lanes knew when they stopped is all the record holds.
    const atCut = killReadiness(final, endedRoundsBeforeKill)
    if (outcome === 'killed' && atCut.threadsWithARoundRunning === 0) {
      outcome = 'nothing_running_at_the_cut'
    }
    const kill = outcome === 'killed' ? await options.killChild() : null
    const record = {
      outcome,
      endedRoundsBeforeKill,
      startedAtMs,
      readiness,
      atCut,
      kill,
      observer: final.observer,
      threads: drillRecordOf({ threads, snapshot: final, priorRounds: input.priorRounds })
    }
    options.onRecord(record)
    if (kill !== null) {
      throw error(
        `the kill drill killed the app it launched (${kill.ok ? 'its process group is gone' : kill.reason})`,
        KILLED_CODE,
        { killDrill: record }
      )
    }
    return { verdict: { ok: false, reasons: [outcome] }, killDrill: record }
  }
}

/** One `ps` line of a process: its pid, group and command name, nothing else. */
function parseProcessLine(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
  if (match === null) return null
  return { pid: Number(match[1]), pgid: Number(match[2]), command: path.basename(match[3].trim()) }
}

/** The processes in one process group, by pid, group and command name only. */
function listProcessGroup(pgid) {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,pgid=,comm='],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (failure, stdout) => {
        if (failure) {
          reject(failure)
          return
        }
        resolve(
          String(stdout)
            .split('\n')
            .map(parseProcessLine)
            .filter((entry) => entry !== null && entry.pgid === pgid)
        )
      }
    )
  })
}

/**
 * Kill one recorded process group as a crash would: SIGKILL to the group,
 * then wait until no process is left in it. Refuses to signal unless the
 * group's leader is there under the recorded pid.
 */
async function killProcessGroupAsACrash(options) {
  const pgid = options.pgid
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    return { ok: false, reason: 'no_recorded_process_group', pgid: pgid ?? null }
  }
  const listGroup = options.listGroup || listProcessGroup
  const signal = options.signal || ((target, name) => process.kill(target, name))
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const timeoutMs = option(options, 'groupGoneTimeoutMs')
  const brief = (members) => members.map(({ pid, command }) => ({ pid, command }))
  const before = await listGroup(pgid)
  if (!before.some((member) => member.pid === pgid)) {
    return { ok: false, reason: 'leader_not_found', pgid, membersAtKill: brief(before) }
  }
  const signalledAtMs = nowMs()
  try {
    signal(-pgid, 'SIGKILL')
  } catch (failure) {
    return {
      ok: false,
      reason: `signal_failed_${failure && failure.code ? failure.code : 'unknown'}`,
      pgid,
      membersAtKill: brief(before)
    }
  }
  for (;;) {
    const left = await listGroup(pgid)
    if (left.length === 0) {
      return {
        ok: true,
        pgid,
        signal: 'SIGKILL',
        signalledAtMs,
        groupGoneAfterMs: nowMs() - signalledAtMs,
        membersAtKill: brief(before)
      }
    }
    if (nowMs() - signalledAtMs >= timeoutMs) {
      return {
        ok: false,
        reason: 'group_survived',
        pgid,
        signalledAtMs,
        membersAtKill: brief(before),
        survivors: brief(left)
      }
    }
    await sleep(25)
  }
}

/**
 * A page expression that reads each thread through `window.api.getChat` and
 * keeps of it only what the drill compares: user message ids, the drill's
 * own prompts (any other text stays in the page), the rounds the thread
 * records as ended, its active round, and each run's round and status.
 */
function readBackExpression(chatIds) {
  return (
    '(async function(){ var api = window.api; ' +
    "if (!api || typeof api.getChat !== 'function') return { notReady: true }; " +
    `var ids = ${JSON.stringify(chatIds)}; ` +
    `var own = [new RegExp(${JSON.stringify(LANE_PROMPT_PATTERN)}), new RegExp(${JSON.stringify(LIVE_PROMPT_PATTERN)})]; ` +
    'var str = function(v){ return typeof v === "string" ? v : null; }; ' +
    'var chats = []; ' +
    'for (var i = 0; i < ids.length; i += 1) { var chat = null; ' +
    'try { chat = await api.getChat(ids[i]); } catch (e) { chats.push({ chatId: ids[i], found: false, error: String(e && e.message || e).slice(0, 200) }); continue; } ' +
    'if (!chat || typeof chat !== "object") { chats.push({ chatId: ids[i], found: false }); continue; } ' +
    'var messages = Array.isArray(chat.messages) ? chat.messages : []; ' +
    'var runs = Array.isArray(chat.runs) ? chat.runs : []; ' +
    'var ensemble = chat.ensemble && typeof chat.ensemble === "object" ? chat.ensemble : {}; ' +
    'var ledger = ensemble.roundWallMsById && typeof ensemble.roundWallMsById === "object" ? Object.keys(ensemble.roundWallMsById) : []; ' +
    'var active = ensemble.activeRound && typeof ensemble.activeRound === "object" ? { roundId: str(ensemble.activeRound.roundId), status: str(ensemble.activeRound.status) } : null; ' +
    'chats.push({ chatId: ids[i], found: true, messageCount: messages.length, runCount: runs.length, ' +
    'userMessages: messages.filter(function(m){ return m && m.role === "user"; }).map(function(m){ ' +
    'var text = str(m.content); return { id: str(m.id), prompt: text !== null && own.some(function(p){ return p.test(text); }) ? text : null }; }), ' +
    'ledger: ledger, activeRound: active, ' +
    'runs: runs.map(function(r){ return { roundId: r ? str(r.ensembleRoundId) : null, status: r ? str(r.status) : null }; }) }); } ' +
    'return { chats: chats }; })()'
  )
}

const optionalString = (value) => value === null || typeof value === 'string'

/** Validate one read-back: `{ ok: true, chats }`, `{ ok: false, reason }`. */
function parseReadBack(value, chatIds) {
  if (!isPlainObject(value)) return { ok: false, reason: 'invalid' }
  if (value.notReady === true) return { ok: false, reason: 'page_not_ready' }
  if (!Array.isArray(value.chats) || value.chats.length !== chatIds.length) {
    return { ok: false, reason: 'invalid' }
  }
  const chats = []
  for (const [at, chat] of value.chats.entries()) {
    if (!isPlainObject(chat) || chat.chatId !== chatIds[at] || typeof chat.found !== 'boolean') {
      return { ok: false, reason: 'invalid' }
    }
    if (!chat.found) {
      chats.push({
        chatId: chat.chatId,
        found: false,
        ...(typeof chat.error === 'string' ? { error: chat.error } : {})
      })
      continue
    }
    if (
      !Number.isSafeInteger(chat.messageCount) ||
      !Number.isSafeInteger(chat.runCount) ||
      !Array.isArray(chat.userMessages) ||
      !chat.userMessages.every(
        (message) =>
          isPlainObject(message) && optionalString(message.id) && optionalString(message.prompt)
      ) ||
      !Array.isArray(chat.ledger) ||
      !chat.ledger.every((roundId) => typeof roundId === 'string') ||
      !(
        chat.activeRound === null ||
        (isPlainObject(chat.activeRound) &&
          optionalString(chat.activeRound.roundId) &&
          optionalString(chat.activeRound.status))
      ) ||
      !Array.isArray(chat.runs) ||
      !chat.runs.every(
        (run) => isPlainObject(run) && optionalString(run.roundId) && optionalString(run.status)
      )
    ) {
      return { ok: false, reason: 'invalid' }
    }
    chats.push({
      chatId: chat.chatId,
      found: true,
      messageCount: chat.messageCount,
      runCount: chat.runCount,
      userMessages: chat.userMessages.map(({ id, prompt }) => ({ id, prompt })),
      ledger: [...chat.ledger],
      activeRound: chat.activeRound === null ? null : { ...chat.activeRound },
      runs: chat.runs.map(({ roundId, status }) => ({ roundId, status }))
    })
  }
  return { ok: true, chats }
}

/**
 * Judge the read-back against the first launch's record. Fails on anything
 * acknowledged that is missing or changed, and on any round seen to end that
 * the thread no longer records as ended, or whose seats' runs are gone or
 * not final. What was never acknowledged, and what became of the rounds
 * still running at the kill, is reported and never fails the drill.
 */
function judgeKillDrill({ record, readBack }) {
  const reasons = []
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  const missing = []
  const changed = []
  const endsLost = []
  const unacknowledged = []
  const notSeenToEnd = []
  const counts = { acknowledged: 0, acknowledgedPresent: 0, seenToEnd: 0, seenToEndKept: 0 }
  if (!isPlainObject(record)) {
    return { ok: false, reasons: ['first_launch_unrecorded'], counts }
  }
  if (record.outcome !== 'killed') add(record.outcome)
  if (record.kill && record.kill.ok !== true) add(`kill_${record.kill.reason}`)
  if (!isPlainObject(readBack) || readBack.ok !== true) {
    add(`read_back_${isPlainObject(readBack) ? readBack.reason : 'missing'}`)
  }
  const chats = readBack && readBack.ok ? readBack.chats : []
  for (const thread of record.threads) {
    const chat = chats.find((entry) => entry.chatId === thread.chatId)
    if (readBack && readBack.ok && (!chat || !chat.found)) {
      add('thread_missing')
      for (const send of thread.sends.filter((entry) => entry.acknowledged)) {
        counts.acknowledged += 1
        missing.push({ chatId: thread.chatId, prompt: send.prompt, roundId: send.roundId })
      }
      continue
    }
    if (!chat) continue
    const runsOf = (roundId) => chat.runs.filter((run) => run.roundId === roundId)
    const endRecorded = (roundId) =>
      chat.ledger.includes(roundId) ||
      (chat.activeRound !== null &&
        chat.activeRound.roundId === roundId &&
        TERMINAL_ROUND_STATUSES.includes(chat.activeRound.status))
    for (const send of thread.sends) {
      const where = { chatId: thread.chatId, source: send.source, prompt: send.prompt }
      if (!send.acknowledged) {
        unacknowledged.push({
          ...where,
          unanswered: send.unanswered,
          kept: chat.userMessages.some((message) => message.prompt === send.prompt)
        })
        continue
      }
      counts.acknowledged += 1
      if (send.steered) {
        if (chat.userMessages.some((message) => message.prompt === send.prompt)) {
          counts.acknowledgedPresent += 1
        } else {
          add('acknowledged_message_missing')
          missing.push({ ...where, roundId: null, steered: true })
        }
        continue
      }
      const message = chat.userMessages.find(
        (entry) => entry.id === `ensemble-user-${send.roundId}`
      )
      if (message === undefined) {
        add('acknowledged_message_missing')
        missing.push({ ...where, roundId: send.roundId })
      } else if (message.prompt !== send.prompt) {
        add('acknowledged_message_changed')
        changed.push({ ...where, roundId: send.roundId })
      } else {
        counts.acknowledgedPresent += 1
      }
      const runs = runsOf(send.roundId)
      if (!send.seenToEnd) {
        notSeenToEnd.push({
          ...where,
          roundId: send.roundId,
          endRecordedAfter: endRecorded(send.roundId),
          runStatusesAfter: runs.map((run) => run.status)
        })
        continue
      }
      counts.seenToEnd += 1
      const lost = []
      if (!endRecorded(send.roundId)) lost.push('end_not_recorded')
      if (send.endStatus === 'completed' && runs.length === 0) lost.push('runs_missing')
      if (runs.some((run) => NON_FINAL_RUN_STATUSES.includes(run.status))) {
        lost.push('run_not_final')
      }
      if (lost.length === 0) counts.seenToEndKept += 1
      else {
        for (const kind of lost) add(`ended_round_${kind}`)
        endsLost.push({ ...where, roundId: send.roundId, endStatus: send.endStatus, lost })
      }
    }
  }
  if (counts.seenToEnd === 0 && reasons.length === 0) add('nothing_seen_to_end')
  return {
    ok: reasons.length === 0,
    reasons,
    counts,
    missing,
    changed,
    endsLost,
    unacknowledged,
    notSeenToEnd
  }
}

/**
 * The second launch's phase: wait until the page answers for every thread,
 * read them back, and judge. Its verdict is the run's.
 *
 * @param {{ record: object, onJudged?: (result: object) => void,
 *   readyTimeoutMs?: number, readyPollMs?: number }} options
 */
function createReadBack(options) {
  if (!isPlainObject(options) || !isPlainObject(options.record)) {
    throw new Error('the read-back needs the first launch’s record')
  }
  const readyTimeoutMs = option(options, 'readyTimeoutMs')
  const readyPollMs = option(options, 'readyPollMs')
  return async function readBack(input) {
    const threads = Array.isArray(input.threads) ? input.threads : []
    const chatIds = threads.map((thread) => thread.chatId)
    const nowMs = input.nowMs || Date.now
    const sleep = input.sleep || defaultSleep
    const startedAtMs = nowMs()
    let read = { ok: false, reason: 'not_read' }
    let attempts = 0
    for (;;) {
      attempts += 1
      try {
        read = parseReadBack(await input.page.evaluate(readBackExpression(chatIds)), chatIds)
      } catch {
        read = { ok: false, reason: 'read_failed' }
      }
      const complete = read.ok && read.chats.every((chat) => chat.found)
      if (complete || nowMs() - startedAtMs >= readyTimeoutMs) break
      await sleep(readyPollMs)
    }
    const judgement = judgeKillDrill({ record: options.record, readBack: read })
    const result = {
      readBack: { ...read, attempts, readAfterMs: nowMs() - startedAtMs },
      judgement
    }
    if (typeof options.onJudged === 'function') options.onJudged(result)
    return { verdict: { ok: judgement.ok, reasons: judgement.reasons }, killDrill: result }
  }
}

/**
 * One scripted model for both launches. The first launch's runner starts it;
 * the relaunch's gets the same one, so a profile that names the first
 * launch's model still reaches it and the Host's rounds can run on through
 * the kill, as they would against a real model. Each launch's own stop
 * leaves it running and says so; the drill stops it at the end.
 */
function createSharedDaemon(options = {}) {
  const start = options.start || startScriptedDaemonChild
  let daemon = null
  let config = null
  let starting = null
  async function starter(input) {
    if (starting === null) {
      config = input.config
      starting = start({ ...input, ...(options.dir ? { dir: options.dir } : {}) })
    } else if (!isDeepStrictEqual(input.config, config)) {
      throw new Error('the kill drill’s relaunch asked for a different scripted model')
    }
    daemon = await starting
    return {
      pid: daemon.pid,
      baseUrl: daemon.baseUrl,
      stop: async () => ({
        exit: null,
        forced: false,
        summary: { keptRunningForTheKillDrill: true },
        stderrTail: ''
      })
    }
  }
  return {
    start: starter,
    get pid() {
      return daemon ? daemon.pid : null
    },
    async stop() {
      if (starting === null) return null
      const started = await starting.catch(() => null)
      return started ? started.stop() : null
    }
  }
}

/** Run the Host's own CLI with the drill's isolated environment; never prints it. */
function runHostCli({ cliPath, nodePath, env, args, timeoutMs = 60_000 }) {
  const result = spawnSync(nodePath, [cliPath, ...args], {
    env,
    encoding: 'utf8',
    timeout: timeoutMs
  })
  let parsed = null
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = null
  }
  return {
    exit: result.status,
    signal: result.signal,
    parsed,
    stderr: String(result.stderr || '').slice(0, 600)
  }
}

/** A Host CLI report cut to what the drill states: each Host's pid, liveness and outcome. */
function briefHostReport(result) {
  const hosts =
    isPlainObject(result.parsed) && Array.isArray(result.parsed.hosts) ? result.parsed.hosts : null
  return {
    exit: result.exit,
    ...(result.signal ? { signal: result.signal } : {}),
    hosts:
      hosts === null
        ? null
        : hosts.map((host) => ({
            pid: host.pid ?? null,
            liveness: host.liveness ?? null,
            ...(host.outcome ? { outcome: host.outcome.kind ?? null } : {}),
            ...(host.outcome && Array.isArray(host.outcome.swept)
              ? { swept: host.outcome.swept }
              : {})
          })),
    ...(hosts === null && result.stderr ? { stderr: result.stderr } : {})
  }
}

/** Whether a pid names a live process, asked of `ps` by pid alone. */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  const probe = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' })
  return probe.status === 0 && String(probe.stdout).trim() !== ''
}

/**
 * Stop every Host the drill recorded, by its identity: for each recorded
 * Host still listed live on the drill's profile, the Host CLI's stop-all
 * confined to that profile, its pid and the birth its registry entry
 * records. Then the same stop on the profile alone, which leaves nothing on
 * it and sweeps the records a stopped Host left (its socket folder in the
 * temporary folder among them). Nothing outside the drill's profile is
 * named, and `--all` never is.
 */
function stopRecordedHosts(options) {
  const run = options.run || runHostCli
  const isAlive = options.isAlive || processAlive
  const profilePath = options.profilePath
  const call = (args) =>
    run({ cliPath: options.cliPath, nodePath: options.nodePath, env: options.env, args })
  const steps = []
  const before = call(['status', '--profile', profilePath, '--json'])
  steps.push({ step: 'status_before', ...briefHostReport(before) })
  const listed =
    isPlainObject(before.parsed) && Array.isArray(before.parsed.hosts) ? before.parsed.hosts : []
  const pids = [...new Set(options.hostPids.filter((pid) => Number.isSafeInteger(pid)))]
  for (const pid of pids) {
    const host = listed.find((entry) => entry.pid === pid)
    if (host === undefined) steps.push({ step: 'recorded_host_not_listed', pid })
    else if (host.liveness !== 'live') {
      steps.push({ step: 'recorded_host_not_live', pid, liveness: host.liveness ?? null })
    } else if (
      typeof host.birthIdentity !== 'string' ||
      !/^[0-9a-f]{64}$/.test(host.birthIdentity)
    ) {
      steps.push({ step: 'recorded_host_without_birth', pid })
    } else {
      const stopped = call([
        'stop-all',
        '--profile',
        profilePath,
        '--expect-pid',
        String(pid),
        '--expect-birth',
        host.birthIdentity,
        '--json'
      ])
      steps.push({ step: 'stop_recorded_host', pid, ...briefHostReport(stopped) })
    }
  }
  const swept = call(['stop-all', '--profile', profilePath, '--json'])
  steps.push({ step: 'stop_profile', ...briefHostReport(swept) })
  const after = call(['status', '--profile', profilePath, '--json'])
  steps.push({ step: 'status_after', ...briefHostReport(after) })
  const recorded = pids.map((pid) => ({ pid, aliveAfter: isAlive(pid) }))
  const leftListed =
    isPlainObject(after.parsed) && Array.isArray(after.parsed.hosts)
      ? after.parsed.hosts.length
      : null
  const ok =
    steps.every((step) => step.exit === undefined || step.exit === 0) &&
    leftListed === 0 &&
    recorded.every((host) => !host.aliveAfter)
  return { ok, steps, recorded }
}

/** Names directly in a folder; an unreadable folder gives null. */
function listNames(dir) {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return null
  }
}

/** Kibibytes a path takes on disk, by `du`; null when it cannot be measured. */
function diskKib(target) {
  if (!fs.existsSync(target)) return null
  const result = spawnSync('/usr/bin/du', ['-sk', target], { encoding: 'utf8' })
  const kib = Number(String(result.stdout).split(/\s+/)[0])
  return result.status === 0 && Number.isSafeInteger(kib) ? kib : null
}

function argumentValue(argv, name) {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit === undefined ? null : hit.slice(name.length + 3)
}

/** Why the drill came to no judgement. */
function whyNotJudged(record) {
  if (record === null) return 'first_launch_unrecorded'
  if (record.outcome !== 'killed') return record.outcome
  if (record.kill === null || record.kill.ok !== true) {
    return `kill_${record.kill ? record.kill.reason : 'not_made'}`
  }
  return 'read_back_not_run'
}

/** The drill's own failure, as the run's error would read. */
function messageOf(failure) {
  return String(failure && failure.message ? failure.message : failure).slice(0, 1000)
}

/**
 * Run the drill: the first launch driven and killed, the relaunch read back
 * and judged, then the Host and the model stopped and what the run left
 * listed. Writes `kill-drill-report.json` in `drillDir` and returns it.
 *
 * `argv` is the runner's, for both launches: the workload with --live-agents,
 * --launch and its acceptance, --home, --instance-id, the ports, and any
 * --flag. The drill adds what differs between the two launches.
 *
 * @param {{
 *   runner: (argv: string[], options: object) => Promise<object>,
 *   argv: string[], drillDir: string, repoRoot: string,
 *   runnerOptions?: object, nodePath?: string, tmpdir?: string, platform?: string,
 *   endedRoundsBeforeKill?: number, pollMs?: number,
 *   readyTimeoutMs?: number, readyPollMs?: number,
 *   createLanes?: Function, killChild?: (pgid: number) => Promise<object>,
 *   listGroup?: typeof listProcessGroup, stopHosts?: typeof stopRecordedHosts,
 *   startDaemon?: Function, nowIso?: () => string
 * }} options
 */
async function runKillDrill(options) {
  const argv = Array.isArray(options.argv) ? options.argv : []
  for (const name of DRILL_ARGUMENTS) {
    if (argv.some((arg) => (name.endsWith('=') ? arg.startsWith(name) : arg === name))) {
      throw new Error(`the kill drill gives each launch ${name.replace(/=$/, '')} itself`)
    }
  }
  const home = argumentValue(argv, 'home')
  const instanceId = argumentValue(argv, 'instance-id')
  if (!argv.includes('--live-agents') || home === null || instanceId === null) {
    throw new Error('the kill drill needs --live-agents, --home and --instance-id')
  }
  if (typeof options.runner !== 'function') throw new Error('the kill drill needs the runner')
  if (typeof options.repoRoot !== 'string' || !path.isAbsolute(options.repoRoot)) {
    throw new Error('the kill drill needs the absolute root of the tree it launches')
  }
  const drillDir = path.resolve(options.drillDir)
  if (fs.existsSync(drillDir))
    throw new Error(`the kill drill's folder already exists: ${drillDir}`)
  const nowIso = options.nowIso || (() => new Date().toISOString())
  const temporaryFolder = options.tmpdir || os.tmpdir()
  const profilePath = resolveUnpackagedDevUserDataPath({
    instanceId,
    home,
    platform: options.platform || process.platform,
    env: isolatedHomeEnvironment({ home })
  }).userDataPath
  const dirs = {
    first: path.join(drillDir, 'launch-1-drive-and-kill'),
    second: path.join(drillDir, 'launch-2-read-back'),
    model: path.join(drillDir, 'scripted-ollama')
  }
  fs.mkdirSync(drillDir, { recursive: true })
  const report = {
    schemaVersion: 1,
    kind: 'kill_drill',
    startedAt: nowIso(),
    endedAt: null,
    argv,
    dirs,
    home,
    profilePath,
    note: 'A crash of the app, not a power cut: the kernel still writes out what the killed app had handed it. Power cuts are the log lane’s file-system tests.'
  }
  const temporaryBefore = listNames(temporaryFolder)
  const daemon = createSharedDaemon({ start: options.startDaemon, dir: dirs.model })
  const seen = { first: null, second: null }
  let record = null
  let judged = null
  // The drill stops the Host itself, by its identity: no launch's cleanup may
  // reap it by its command line, or it would not outlive the first launch.
  const keepHost = { listPidsMatchingCommandNeedle: async () => [] }
  const runnerOptions = isPlainObject(options.runnerOptions) ? options.runnerOptions : {}
  const launchOptions = (name, runManyAgents) => ({
    // The drill measures no window: its launches skip the capture steps.
    maxCapturePhaseMs: 0,
    ...runnerOptions,
    startScriptedDaemon: daemon.start,
    onVerifiedCaptureSession: (session) => {
      seen[name] = session
    },
    terminateOptions: { ...(runnerOptions.terminateOptions || {}), ...keepHost },
    runManyAgents
  })
  try {
    try {
      const result = await options.runner(
        [...argv, '--materialize-instance-userdata', `--artifact-dir=${dirs.first}`],
        launchOptions(
          'first',
          createDriveAndKill({
            endedRoundsBeforeKill: options.endedRoundsBeforeKill,
            pollMs: options.pollMs,
            ...(options.createLanes ? { createLanes: options.createLanes } : {}),
            killChild: () =>
              (options.killChild || ((pgid) => killProcessGroupAsACrash({ pgid })))(
                seen.first ? seen.first.childPid : null
              ),
            onRecord: (made) => {
              record = made
            }
          })
        )
      )
      report.firstLaunch = { ended: 'returned', ok: result && result.ok === true }
    } catch (failure) {
      report.firstLaunch = {
        ended: failure && failure.code === KILLED_CODE ? 'killed_by_the_drill' : 'failed',
        ...(failure && failure.code === KILLED_CODE ? {} : { error: messageOf(failure) })
      }
    }
    report.firstLaunch.childPid = seen.first ? seen.first.childPid : null
    report.firstLaunch.host = seen.first ? seen.first.serverInstance : null
    report.record = record
    if (record !== null && record.kill !== null && record.kill.ok === true) {
      try {
        const result = await options.runner(
          [...argv, '--reuse-instance-userdata', `--artifact-dir=${dirs.second}`],
          launchOptions(
            'second',
            createReadBack({
              record,
              readyTimeoutMs: options.readyTimeoutMs,
              readyPollMs: options.readyPollMs,
              onJudged: (result) => {
                judged = result
              }
            })
          )
        )
        report.secondLaunch = { ended: 'returned', ok: result && result.ok === true }
      } catch (failure) {
        report.secondLaunch = { ended: 'failed', error: messageOf(failure) }
      }
      report.secondLaunch.childPid = seen.second ? seen.second.childPid : null
      report.secondLaunch.host = seen.second ? seen.second.serverInstance : null
    } else {
      report.secondLaunch = { ended: 'not_launched' }
    }
    report.readBack = judged ? judged.readBack : null
    report.judgement = judged ? judged.judgement : null
  } finally {
    const hostPids = [seen.first, seen.second]
      .map((session) => session?.serverInstance?.evidence?.hostPid)
      .filter((pid) => Number.isSafeInteger(pid))
    try {
      report.hostStop = (options.stopHosts || stopRecordedHosts)({
        cliPath: path.join(options.repoRoot, 'out', 'host', 'host-runtime', 'cli.js'),
        nodePath: options.nodePath || process.execPath,
        profilePath: fs.existsSync(profilePath) ? fs.realpathSync(profilePath) : profilePath,
        env: {
          ...isolatedHomeEnvironment({ home }),
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {})
        },
        hostPids
      })
    } catch (failure) {
      report.hostStop = { ok: false, error: messageOf(failure) }
    }
    const listGroup = options.listGroup || listProcessGroup
    report.processGroupsLeft = {}
    for (const name of ['first', 'second']) {
      const pgid = seen[name] ? seen[name].childPid : null
      try {
        report.processGroupsLeft[name] = Number.isSafeInteger(pgid)
          ? (await listGroup(pgid)).map(({ pid, command }) => ({ pid, command }))
          : null
      } catch (failure) {
        report.processGroupsLeft[name] = { error: messageOf(failure) }
      }
    }
    try {
      const stopped = await daemon.stop()
      report.modelStop = stopped
        ? {
            pid: daemon.pid,
            exit: stopped.exit,
            forced: stopped.forced,
            summary: Boolean(stopped.summary)
          }
        : null
    } catch (failure) {
      report.modelStop = { error: messageOf(failure) }
    }
    const temporaryAfter = listNames(temporaryFolder)
    const socketFolders = [
      ...new Set(
        [seen.first, seen.second]
          .map((session) => session?.serverInstance?.evidence?.socketNamespace)
          .filter((folder) => typeof folder === 'string')
          .map((folder) => path.basename(folder))
      )
    ]
    const created =
      temporaryBefore && temporaryAfter
        ? temporaryAfter.filter((name) => !temporaryBefore.includes(name))
        : null
    report.leftBehind = {
      temporaryFolder,
      // Every name new since the drill began; other processes on the machine
      // make names there too. Nothing here was removed by the drill.
      newInTemporaryFolder: created,
      hostSocketFolders: socketFolders.map((name) => ({
        name,
        presentAfter: temporaryAfter ? temporaryAfter.includes(name) : null
      })),
      home: listNames(home),
      profile: listNames(profilePath)
    }
    report.diskKib = {
      drillDir: diskKib(drillDir),
      firstLaunch: diskKib(dirs.first),
      secondLaunch: diskKib(dirs.second),
      model: diskKib(dirs.model),
      home: diskKib(home),
      profile: diskKib(profilePath)
    }
    report.endedAt = nowIso()
    report.verdict = report.judgement
      ? { ok: report.judgement.ok, reasons: report.judgement.reasons }
      : { ok: false, reasons: [whyNotJudged(record)] }
    const groupsEmpty = Object.values(report.processGroupsLeft).every(
      (left) => left === null || (Array.isArray(left) && left.length === 0)
    )
    const modelStopped =
      report.modelStop === null ||
      (report.modelStop.forced === false &&
        report.modelStop.exit !== null &&
        report.modelStop.exit.code === 0)
    report.cleanup = {
      ok: report.hostStop.ok === true && groupsEmpty && modelStopped,
      hostStopped: report.hostStop.ok === true,
      processGroupsEmpty: groupsEmpty,
      modelStopped
    }
    report.ok = report.verdict.ok && report.cleanup.ok
    fs.writeFileSync(
      path.join(drillDir, 'kill-drill-report.json'),
      `${JSON.stringify(report, null, 2)}\n`
    )
  }
  return report
}

module.exports = {
  DEFAULT_KILL_DRILL_OPTIONS: DEFAULT_OPTIONS,
  KILLED_CODE,
  createDriveAndKill,
  createReadBack,
  createSharedDaemon,
  drillRecordOf,
  judgeKillDrill,
  killProcessGroupAsACrash,
  killReadiness,
  listProcessGroup,
  parseProcessLine,
  parseReadBack,
  readBackExpression,
  runKillDrill,
  stopRecordedHosts
}

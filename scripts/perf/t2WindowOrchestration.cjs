'use strict'

/**
 * Wall 2 — T2 window orchestration (Independent Threads Programme, M1
 * measurement contract).
 *
 * T2 replays its fixture's single interleaved schedule SEQUENTIALLY, so its
 * descriptor can never observe sampling windows. The concurrent lanes driver
 * (`concurrentReplayLanes.cjs`) already runs fenced 120 s × 3 windows and
 * emits validator-shaped coverage; this module is the narrow adapter between
 * the two: it splits a T2 fixture into per-chat lane specs, runs them through
 * the lanes driver against the T2 page API, and returns the driver's observed
 * windows and signals unchanged for `buildT2RunEvidence`.
 *
 * Honesty rules, all pinned by `t2WindowOrchestration.test.ts`:
 *
 * - The split preserves per-chat event order and replicates the terminal
 *   `schedule_complete` sentinel (a pure no-op success in `applyReplayEvent`)
 *   to every lane, which the lanes validator explicitly permits. Events for
 *   chats absent from the fixture are refused: no lane could ever own them.
 * - Population mapping mirrors the descriptor builder: the FIRST fixture chat
 *   is the light population, the rest heavy. A chat with zero schedulable
 *   events is refused at build time — its lane could never record a measured
 *   sample, so running it would only manufacture an ineligible window.
 * - Driver outcomes pass through verbatim. Short windows, failed saves and
 *   missing overlap keep the run ineligible; the adapter never reshapes
 *   coverage to fit the validator.
 */

const { runConcurrentReplayLanes } = require('./concurrentReplayLanes.cjs')
const { FIXTURE_GENERATOR_VERSION } = require('./fixtureGenerator.cjs')

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function splitFixtureScheduleByChat(fixture) {
  if (!isPlainObject(fixture)) throw new Error('t2WindowOrchestration fixture required')
  const { chats, replaySchedule } = fixture
  if (!Array.isArray(chats) || chats.length === 0) {
    throw new Error('t2WindowOrchestration fixture needs at least one chat')
  }
  if (!Array.isArray(replaySchedule)) {
    throw new Error('t2WindowOrchestration fixture replaySchedule must be an array')
  }
  const chatIds = chats.map((chat) => chat?.appChatId)
  if (
    chatIds.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
    new Set(chatIds).size !== chatIds.length
  ) {
    throw new Error('t2WindowOrchestration fixture chats need unique non-empty appChatIds')
  }
  const split = Object.fromEntries(chatIds.map((id) => [id, []]))
  const terminal = []
  for (const event of replaySchedule) {
    if (!isPlainObject(event) || typeof event.kind !== 'string') {
      throw new Error('t2WindowOrchestration replay events must be objects with a kind')
    }
    if (event.appChatId === undefined) {
      if (event.kind !== 'schedule_complete') {
        throw new Error(`t2WindowOrchestration unowned event kind refused: ${event.kind}`)
      }
      terminal.push(event)
      continue
    }
    const lane = split[event.appChatId]
    if (!lane) {
      throw new Error(`t2WindowOrchestration event targets unknown chat: ${event.appChatId}`)
    }
    lane.push(event)
  }
  for (const events of Object.values(split)) events.push(...terminal)
  return split
}

function buildT2LaneSpecs(fixture) {
  if (!isPlainObject(fixture) || !Array.isArray(fixture.chats)) {
    throw new Error('t2WindowOrchestration fixture with chats[] required')
  }
  const split = splitFixtureScheduleByChat(fixture)
  return fixture.chats.map((chat, index) => {
    const schedule = split[chat.appChatId]
    const schedulable = schedule.filter((event) => event.kind !== 'schedule_complete')
    if (schedulable.length === 0) {
      throw new Error(`t2WindowOrchestration chat has zero schedulable events: ${chat.appChatId}`)
    }
    return {
      role: index === 0 ? 'light' : 'heavy',
      chatId: chat.appChatId,
      schedule,
      chats: [chat]
    }
  })
}

async function runT2WindowedReplay(options) {
  if (!isPlainObject(options)) throw new Error('t2WindowOrchestration options required')
  const lanes = buildT2LaneSpecs(options.fixture)
  const { fixture: _fixture, fixtureVersions, ...rest } = options
  return runConcurrentReplayLanes({
    ...rest,
    lanes,
    fixtureVersions: fixtureVersions ?? { fixtureGenerator: FIXTURE_GENERATOR_VERSION }
  })
}

module.exports = {
  buildT2LaneSpecs,
  runT2WindowedReplay,
  splitFixtureScheduleByChat
}

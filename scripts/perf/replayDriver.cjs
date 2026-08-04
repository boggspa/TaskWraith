'use strict'

/**
 * Deterministic renderer save-replay driver for T2.
 *
 * Uses window.api.getChat / window.api.saveChat via an injected page evaluator
 * (CDP Runtime.evaluate in attach mode). Never spawns providers.
 *
 * Applies ordered message prefixes / tail updates in bounded batches so HEAD
 * chat / index / IPC paths are exercised. Fields the fixture cannot supply are
 * recorded as explicit unsupported — never invented.
 */

const DEFAULT_BATCH_SIZE = 8

/**
 * Apply one replay event with an optional no-progress deadline.
 * The caller still owns transport teardown; this helper only makes a hung
 * save/get operation observable and rejects with the exact event identity.
 *
 * @param {object} ctx
 * @param {object} event
 * @param {{ eventNumber: number, totalEvents: number, startedAtMs: number }} meta
 * @param {object} options
 */
function applyReplayEventWithTimeout(ctx, event, meta, options) {
  const rawTimeout = options.eventTimeoutMs
  if (rawTimeout == null) return applyReplayEvent(ctx, event)

  const timeoutMs = Number(rawTimeout)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('eventTimeoutMs must be a positive finite number when provided')
  }

  const timers = options.timers || {
    setTimeout,
    clearTimeout
  }
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = timers.setTimeout(() => {
      if (settled) return
      settled = true
      const timedOutAtMs = nowMs()
      const error = new Error(
        `T2 replay made no progress for ${timeoutMs}ms at event ${meta.eventNumber}/${meta.totalEvents} (seq=${String(event.seq)}, kind=${String(event.kind)})`
      )
      error.code = 'T2_REPLAY_STALL_TIMEOUT'
      error.replayEvent = {
        eventNumber: meta.eventNumber,
        totalEvents: meta.totalEvents,
        seq: event.seq,
        kind: event.kind,
        timeoutMs,
        startedAtMs: meta.startedAtMs,
        timedOutAtMs
      }
      if (typeof options.onStall === 'function') {
        try {
          options.onStall({
            ...error.replayEvent,
            elapsedMs: Math.max(0, timedOutAtMs - meta.startedAtMs),
            error
          })
        } catch (callbackError) {
          error.progressCallbackError = String(
            callbackError && callbackError.message ? callbackError.message : callbackError
          )
        }
      }
      reject(error)
    }, timeoutMs)

    Promise.resolve()
      .then(() => applyReplayEvent(ctx, event))
      .then(
        (result) => {
          if (settled) return
          settled = true
          timers.clearTimeout(timer)
          resolve(result)
        },
        (error) => {
          if (settled) return
          settled = true
          timers.clearTimeout(timer)
          reject(error)
        }
      )
  })
}

/**
 * @typedef {object} PageApiAdapter
 * @property {(chatId: string) => Promise<object|null>} getChat
 * @property {(chat: object) => Promise<object|unknown>} saveChat
 */

/**
 * Build a page API adapter from a CDP-like evaluator.
 * @param {{ evaluate: (expression: string) => Promise<unknown> }} page
 * @returns {PageApiAdapter}
 */
function createCdpPageApiAdapter(page) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('page.evaluate adapter required')
  }
  return {
    async getChat(chatId) {
      const expr = `Promise.resolve(window.api.getChat(${JSON.stringify(chatId)}))`
      return /** @type {object|null} */ (await page.evaluate(expr))
    },
    async saveChat(chat) {
      // Pass chat via JSON to avoid expression injection; still bounded by CDP.
      const expr = `(function(){ const chat = ${JSON.stringify(chat)}; return Promise.resolve(window.api.saveChat(chat)); })()`
      return await page.evaluate(expr)
    }
  }
}

/**
 * Create a page evaluator bound to a CDP session.send.
 * @param {{ send: (method: string, params?: object) => Promise<unknown> }} cdpSession
 */
function createCdpEvaluateAdapter(cdpSession) {
  return {
    async evaluate(expression) {
      const result =
        /** @type {{ result?: { value?: unknown, unserializableValue?: string, subtype?: string } }} */ (
          await cdpSession.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false
          })
        )
      if (!result || !result.result) return null
      if (Object.prototype.hasOwnProperty.call(result.result, 'value')) {
        return result.result.value
      }
      return null
    }
  }
}

/**
 * Slice messages into prefix batches for progressive saveChat traffic.
 * @param {object} fullChat
 * @param {number} [batchSize]
 */
function buildMessagePrefixBatches(fullChat, batchSize = DEFAULT_BATCH_SIZE) {
  const messages = Array.isArray(fullChat.messages) ? fullChat.messages : []
  const batches = []
  for (let end = 0; end < messages.length;) {
    end = Math.min(messages.length, end + batchSize)
    batches.push({
      endIndex: end,
      messageCount: end,
      messages: messages.slice(0, end)
    })
    if (end >= messages.length) break
  }
  if (batches.length === 0) {
    batches.push({ endIndex: 0, messageCount: 0, messages: [] })
  }
  return batches
}

/**
 * Apply a single replay schedule event against in-memory chat + page API.
 * @param {object} ctx
 * @param {object} event
 */
async function applyReplayEvent(ctx, event) {
  const unsupported = ctx.unsupported
  switch (event.kind) {
    case 'seed_chat': {
      const chat = ctx.chatsById.get(event.appChatId)
      if (!chat) {
        unsupported.push({
          event: event.kind,
          appChatId: event.appChatId,
          reason: 'chat missing from fixture'
        })
        return { ok: false, unsupported: true }
      }
      // Seed: save full fixture chat once so subsequent prefix saves mutate HEAD paths.
      await ctx.api.saveChat(structuredCloneChat(chat))
      ctx.savedCounts.set(event.appChatId, (ctx.savedCounts.get(event.appChatId) || 0) + 1)
      return { ok: true, kind: event.kind }
    }
    case 'append_user':
    case 'append_assistant':
    case 'tool_batch_complete':
    case 'durability_soft_flush': {
      // Progressive prefix save — look up message index and save prefix through it.
      const chat = ctx.chatsById.get(event.appChatId)
      if (!chat) {
        unsupported.push({ event: event.kind, reason: 'chat missing' })
        return { ok: false, unsupported: true }
      }
      const idx = chat.messages.findIndex((m) => m.id === event.messageId)
      if (event.messageId && idx < 0) {
        unsupported.push({
          event: event.kind,
          messageId: event.messageId,
          reason: 'messageId not in fixture'
        })
        return { ok: false, unsupported: true }
      }
      const end = event.messageId
        ? idx + 1
        : Math.min(chat.messages.length, event.messageIndex || 0)
      const next = structuredCloneChat(chat)
      next.messages = chat.messages.slice(0, Math.max(end, 0))
      next.updatedAt = (chat.updatedAt || 0) + (event.seq || 1)
      next.persistenceRevision =
        (chat.persistenceRevision || 1) + (ctx.savedCounts.get(event.appChatId) || 0) + 1
      // Explicit unsupported: integrated orchestrator live ticks are not simulated.
      if (event.kind === 'durability_soft_flush') {
        unsupported.push({
          event: event.kind,
          field: 'integratedOrchestratorTick',
          reason:
            'fixture replay does not drive EnsembleOrchestrator; D1 soft flush approximated via saveChat only'
        })
      }
      await ctx.api.saveChat(next)
      ctx.savedCounts.set(event.appChatId, (ctx.savedCounts.get(event.appChatId) || 0) + 1)
      return { ok: true, kind: event.kind, messageCount: next.messages.length }
    }
    case 'run_still_running': {
      // Verify getChat still reports the running run — no invented status flip.
      const live = await ctx.api.getChat(event.appChatId)
      if (!live) {
        unsupported.push({ event: event.kind, reason: 'getChat returned null' })
        return { ok: false, unsupported: true }
      }
      const runs = Array.isArray(live.runs) ? live.runs : []
      const found = runs.find((r) => r && (r.id === event.runId || r.runId === event.runId))
      return {
        ok: true,
        kind: event.kind,
        runPresent: Boolean(found),
        runStatus: found ? found.status : null
      }
    }
    case 'schedule_complete':
      return { ok: true, kind: event.kind }
    case 'select_chat':
    case 'hydrate_chat':
    case 'demote_candidate':
    case 'dwell':
    case 'wall_clock_tick':
      // 60m schedule kinds — supported only when page adapter exposes navigation hooks.
      if (typeof ctx.api.selectChat !== 'function') {
        unsupported.push({
          event: event.kind,
          field: 'window.api.selectChat',
          reason:
            'select/hydrate/demote navigation not exposed on HEAD page API adapter; explicit unsupported'
        })
        return { ok: false, unsupported: true }
      }
      return { ok: true, kind: event.kind, delegated: true }
    default:
      unsupported.push({
        event: event.kind,
        reason: 'unknown replay event kind — not invented'
      })
      return { ok: false, unsupported: true }
  }
}

/**
 * @param {object} chat
 */
function structuredCloneChat(chat) {
  return JSON.parse(JSON.stringify(chat))
}

/**
 * Run deterministic replay.
 * @param {object} options
 * @param {object} options.fixture — generatePerfFixture result
 * @param {PageApiAdapter} options.api
 * @param {number} [options.batchSize]
 * @param {number} [options.maxEvents] — optional cap for smoke
 * @param {(info: object) => void} [options.onProgress]
 * @param {(info: object) => void} [options.onEventStart]
 * @param {(info: object) => void} [options.onStall]
 * @param {number} [options.eventTimeoutMs] — per-event no-progress deadline
 * @param {() => number} [options.nowMs]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
 */
async function runDeterministicReplay(options) {
  const fixture = options.fixture
  if (!fixture || !Array.isArray(fixture.chats) || !Array.isArray(fixture.replaySchedule)) {
    throw new Error('fixture with chats[] and replaySchedule[] required')
  }
  if (
    !options.api ||
    typeof options.api.getChat !== 'function' ||
    typeof options.api.saveChat !== 'function'
  ) {
    throw new Error('api.getChat and api.saveChat required')
  }

  /** @type {Map<string, object>} */
  const chatsById = new Map()
  for (const chat of fixture.chats) chatsById.set(chat.appChatId, chat)

  /** @type {object[]} */
  const unsupported = []
  /** @type {Map<string, number>} */
  const savedCounts = new Map()
  const ctx = { api: options.api, chatsById, unsupported, savedCounts }

  const maxEvents = options.maxEvents == null ? fixture.replaySchedule.length : options.maxEvents
  const events = fixture.replaySchedule.slice(0, maxEvents)
  /** @type {object[]} */
  const results = []

  // Optional: also emit prefix-batch plan metadata for reviewers (not executed twice).
  const prefixPlans = fixture.chats.map((chat) => ({
    appChatId: chat.appChatId,
    batches: buildMessagePrefixBatches(chat, options.batchSize || DEFAULT_BATCH_SIZE).map((b) => ({
      endIndex: b.endIndex,
      messageCount: b.messageCount
    }))
  }))

  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex]
    const eventNumber = eventIndex + 1
    const startedAtMs = nowMs()
    if (typeof options.onEventStart === 'function') {
      options.onEventStart({
        eventNumber,
        totalEvents: events.length,
        seq: event.seq,
        kind: event.kind,
        startedAtMs
      })
    }
    const result = await applyReplayEventWithTimeout(
      ctx,
      event,
      { eventNumber, totalEvents: events.length, startedAtMs },
      options
    )
    const completedAtMs = nowMs()
    results.push({ seq: event.seq, kind: event.kind, ...result })
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        eventNumber,
        completedEvents: eventNumber,
        totalEvents: events.length,
        seq: event.seq,
        kind: event.kind,
        startedAtMs,
        completedAtMs,
        elapsedMs: Math.max(0, completedAtMs - startedAtMs),
        result
      })
    }
  }

  return {
    ok: true,
    eventCount: events.length,
    saveCount: [...savedCounts.values()].reduce((a, b) => a + b, 0),
    savedCounts: Object.fromEntries(savedCounts),
    unsupported,
    prefixPlans,
    results
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  createCdpPageApiAdapter,
  createCdpEvaluateAdapter,
  buildMessagePrefixBatches,
  applyReplayEvent,
  runDeterministicReplay
}

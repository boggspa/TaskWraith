'use strict'

/**
 * Deterministic synthetic chat fixtures for the performance epic (T1 hardened).
 * Sanitized text only — no secrets, no live userData reads.
 *
 * Scale targets (mission-observed):
 *   30seat  ≥ ~6.8k messages / ~5.9k tool activities / ~16.4MB chat / ~10.9MB tools
 *   50seat  ≥ ~20k messages / ~15k tool activities
 *   455_soak = literal 455 provider-turn mutation schedule (not system hop markers)
 */

const crypto = require('crypto')

const PROVIDERS = Object.freeze([
  'codex',
  'claude',
  'kimi',
  'cursor',
  'grok',
  'ollama',
  'mistral',
  'pi'
])

const TOOL_NAMES = Object.freeze([
  'read_file',
  'write_file',
  'run_shell_command',
  'workspace_search',
  'apply_patch',
  'git_status'
])

/** Mission-observed sizes (bytes). */
const OBSERVED_30SEAT = Object.freeze({
  messageTarget: 6800,
  toolActivityTarget: 5900,
  chatSerializedTargetBytes: Math.round(16.4 * 1024 * 1024),
  toolSerializedTargetBytes: Math.round(10.9 * 1024 * 1024)
})

const OBSERVED_50SEAT = Object.freeze({
  messageTarget: 20000,
  toolActivityTarget: 15000,
  chatSerializedTargetBytes: Math.round(48 * 1024 * 1024),
  toolSerializedTargetBytes: Math.round(28 * 1024 * 1024)
})

/** @param {number} seed */
function createPrng(seed) {
  let state = seed >>> 0 || 1
  return function next() {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pad(n, width) {
  return String(n).padStart(width, '0')
}

/**
 * Precompute a repeating alphabet block so large blobs stay O(bytes) without per-char PRNG.
 * Determinism still depends only on seed via a short salt prefix.
 * @param {ReturnType<typeof createPrng>} rand
 * @param {number} bytes
 */
function syntheticBlob(rand, bytes) {
  if (bytes <= 0) return ''
  const salt = `${((rand() * 1e9) | 0).toString(36)}:`
  if (bytes <= salt.length) return salt.slice(0, bytes)
  const unit = 'abcdefghijklmnopqrstuvwxyz0123456789\n'
  const need = bytes - salt.length
  const reps = Math.ceil(need / unit.length)
  return (salt + unit.repeat(reps)).slice(0, bytes)
}

/**
 * Derive per-tool param/raw budgets so tool payloads approach a serialized-size target.
 * Accounts for rawUseEvent.input duplicating `parameters` (≈2× paramBytes) plus raw padding.
 * @param {number} toolCount
 * @param {number} toolSerializedTargetBytes
 */
function deriveToolByteBudgets(toolCount, toolSerializedTargetBytes) {
  if (toolCount <= 0) return { paramBytes: 0, rawBytes: 0 }
  // JSON envelope + triple summary fields ≈ 1.25×; param duplication in rawUse ≈ 2× param.
  const perToolBudget = Math.max(160, Math.floor(toolSerializedTargetBytes / toolCount / 1.25))
  // Solve approx: 2*param + 1.5*raw ≈ perToolBudget with param:raw ≈ 1:2
  const paramBytes = Math.max(32, Math.floor(perToolBudget * 0.18))
  const rawBytes = Math.max(48, Math.floor(perToolBudget * 0.42))
  return { paramBytes, rawBytes }
}

/**
 * @param {object} options
 * @param {'30seat'|'50seat'|'dual_run'|'455_soak'|'50_chat_switch'} options.workload
 */
function resolveWorkloadShape(options) {
  const workload = options.workload
  switch (workload) {
    case '30seat': {
      const seatCount = 30
      const messageTarget = OBSERVED_30SEAT.messageTarget
      const toolActivityTarget = OBSERVED_30SEAT.toolActivityTarget
      // 1 opening user + seat×turns assistants
      const assistantTarget = messageTarget - 1
      const turnsPerSeat = Math.ceil(assistantTarget / seatCount)
      const expectedAssistants = turnsPerSeat * seatCount
      const toolsPerAssistant = Math.max(1, Math.round(toolActivityTarget / expectedAssistants))
      return {
        workload,
        seatCount,
        chatCount: 1,
        turnsPerSeat,
        toolsPerAssistant,
        dualConcurrentRuns: true,
        messageTarget,
        toolActivityTarget,
        chatSerializedTargetBytes: OBSERVED_30SEAT.chatSerializedTargetBytes,
        toolSerializedTargetBytes: OBSERVED_30SEAT.toolSerializedTargetBytes,
        soakTurns: 0,
        messageTargetHint: 1 + expectedAssistants
      }
    }
    case '50seat': {
      const seatCount = 50
      const messageTarget = OBSERVED_50SEAT.messageTarget
      const toolActivityTarget = OBSERVED_50SEAT.toolActivityTarget
      const assistantTarget = messageTarget - 1
      const turnsPerSeat = Math.ceil(assistantTarget / seatCount)
      const expectedAssistants = turnsPerSeat * seatCount
      const toolsPerAssistant = Math.max(1, Math.round(toolActivityTarget / expectedAssistants))
      return {
        workload,
        seatCount,
        chatCount: 1,
        turnsPerSeat,
        toolsPerAssistant,
        dualConcurrentRuns: true,
        messageTarget,
        toolActivityTarget,
        chatSerializedTargetBytes: OBSERVED_50SEAT.chatSerializedTargetBytes,
        toolSerializedTargetBytes: OBSERVED_50SEAT.toolSerializedTargetBytes,
        soakTurns: 0,
        messageTargetHint: 1 + expectedAssistants
      }
    }
    case 'dual_run':
      return {
        workload,
        seatCount: 8,
        chatCount: 2,
        turnsPerSeat: 40,
        toolsPerAssistant: 3,
        dualConcurrentRuns: true,
        messageTarget: 2 * (1 + 8 * 40),
        toolActivityTarget: 2 * 8 * 40 * 3,
        chatSerializedTargetBytes: Math.round(8 * 1024 * 1024),
        toolSerializedTargetBytes: Math.round(5 * 1024 * 1024),
        soakTurns: 0,
        messageTargetHint: 2 * (1 + 8 * 40)
      }
    case '455_soak': {
      // Literal 455 provider turns: each turn = one assistant mutation from a rotating seat.
      const seatCount = 30
      const soakTurns = 455
      const toolsPerAssistant = 2
      return {
        workload,
        seatCount,
        chatCount: 1,
        turnsPerSeat: 0, // unused — soak uses soakTurns schedule
        toolsPerAssistant,
        dualConcurrentRuns: true,
        messageTarget: 1 + soakTurns,
        toolActivityTarget: soakTurns * toolsPerAssistant,
        chatSerializedTargetBytes: Math.round(12 * 1024 * 1024),
        toolSerializedTargetBytes: Math.round(8 * 1024 * 1024),
        soakTurns,
        messageTargetHint: 1 + soakTurns
      }
    }
    case '50_chat_switch':
      return {
        workload,
        seatCount: 4,
        chatCount: 50,
        turnsPerSeat: 8,
        toolsPerAssistant: 2,
        dualConcurrentRuns: false,
        messageTarget: 50 * (1 + 4 * 8),
        toolActivityTarget: 50 * 4 * 8 * 2,
        chatSerializedTargetBytes: Math.round(2 * 1024 * 1024),
        toolSerializedTargetBytes: Math.round(1.2 * 1024 * 1024),
        soakTurns: 0,
        messageTargetHint: 50 * (1 + 4 * 8)
      }
    default: {
      const err = new Error(`Unknown workload: ${workload}`)
      throw err
    }
  }
}

/**
 * @param {object} input
 */
function buildToolActivity(input) {
  const {
    id,
    toolName,
    provider,
    participantId,
    startedAt,
    includeRaw,
    paramBytes,
    rawBytes,
    rand
  } = input
  const content = syntheticBlob(rand, paramBytes)
  const parameters =
    toolName === 'write_file'
      ? { path: `fixture/${id}.txt`, content }
      : toolName === 'run_shell_command'
        ? { command: `echo ${content.slice(0, 40)}`, cwd: '/tmp/taskwraith-perf-fixture' }
        : { query: content.slice(0, Math.min(200, content.length)) }

  const summary = `fixture ${toolName} ok`.slice(0, 500)
  /** @type {Record<string, unknown>} */
  const activity = {
    id,
    toolName,
    displayName: toolName,
    category:
      toolName === 'write_file' || toolName === 'apply_patch'
        ? 'write'
        : toolName === 'run_shell_command'
          ? 'shell'
          : toolName === 'workspace_search' || toolName === 'read_file'
            ? toolName === 'read_file'
              ? 'read'
              : 'search'
            : 'task',
    status: 'completed',
    startedAt,
    endedAt: startedAt,
    durationMs: 12,
    parameters,
    resultSummary: summary,
    outputPreview: summary,
    outputSummary: summary,
    metadata: {
      provider,
      ensembleProvider: provider,
      ensembleParticipantId: participantId
    }
  }
  if (includeRaw) {
    activity.rawUseEvent = {
      type: 'tool_use',
      id,
      name: toolName,
      input: parameters,
      padding: syntheticBlob(rand, rawBytes)
    }
    activity.rawResultEvent = {
      type: 'tool_result',
      tool_use_id: id,
      content: syntheticBlob(rand, Math.max(64, Math.floor(rawBytes / 2)))
    }
  }
  return activity
}

/**
 * Measure serialized tool-activity bytes inside a chat (approx mission "tool rows" mass).
 * @param {object} chat
 */
function measureToolSerializedBytes(chat) {
  let total = 0
  for (const msg of chat.messages) {
    if (!Array.isArray(msg.toolActivities)) continue
    for (const activity of msg.toolActivities) {
      total += Buffer.byteLength(JSON.stringify(activity), 'utf8')
    }
  }
  return total
}

/**
 * Build a deterministic replay event schedule from the fixture construction order.
 * Events are mutation ops a T2 driver can apply; static files alone are insufficient.
 * @param {object} fixture
 */
function buildReplaySchedule(fixture) {
  /** @type {object[]} */
  const events = []
  let seq = 0
  for (const chat of fixture.chats) {
    events.push({
      seq: ++seq,
      t: 0,
      kind: 'seed_chat',
      appChatId: chat.appChatId,
      messageCount: chat.messages.length,
      runIds: chat.runs.map((r) => r.id)
    })
    let t = 0
    for (let i = 0; i < chat.messages.length; i++) {
      const msg = chat.messages[i]
      t += 1
      if (msg.role === 'user') {
        events.push({
          seq: ++seq,
          t,
          kind: 'append_user',
          appChatId: chat.appChatId,
          messageId: msg.id,
          turn: msg.metadata && msg.metadata.soakTurn ? msg.metadata.soakTurn : null
        })
      } else if (msg.role === 'assistant') {
        events.push({
          seq: ++seq,
          t,
          kind: 'append_assistant',
          appChatId: chat.appChatId,
          messageId: msg.id,
          runId: msg.runId || null,
          participantId:
            msg.metadata && msg.metadata.ensembleParticipantId
              ? msg.metadata.ensembleParticipantId
              : null,
          toolCount: Array.isArray(msg.toolActivities) ? msg.toolActivities.length : 0,
          soakTurn: msg.metadata && msg.metadata.soakTurn ? msg.metadata.soakTurn : null
        })
        if (Array.isArray(msg.toolActivities) && msg.toolActivities.length > 0) {
          events.push({
            seq: ++seq,
            t: t + 0.5,
            kind: 'tool_batch_complete',
            appChatId: chat.appChatId,
            messageId: msg.id,
            toolIds: msg.toolActivities.map((a) => a.id)
          })
        }
      }
      if (i > 0 && i % 25 === 0) {
        events.push({
          seq: ++seq,
          t: t + 0.75,
          kind: 'durability_soft_flush',
          appChatId: chat.appChatId,
          durabilityClass: 'D1',
          messageIndex: i
        })
      }
    }
    for (const run of chat.runs) {
      if (run.status === 'running') {
        events.push({
          seq: ++seq,
          t: t + 1,
          kind: 'run_still_running',
          appChatId: chat.appChatId,
          runId: run.id
        })
      }
    }
  }
  events.push({
    seq: ++seq,
    t: 1e9,
    kind: 'schedule_complete',
    eventCount: events.length + 1,
    workload: fixture.workload,
    seed: fixture.seed
  })
  return events
}

/**
 * @param {object} options
 * @param {'30seat'|'50seat'|'dual_run'|'455_soak'|'50_chat_switch'} options.workload
 * @param {number} [options.seed=42]
 * @param {number} [options.baseTimestamp]
 * @param {boolean} [options.includeHotRaw=true]
 * @param {number} [options.paramBytes] — override; default derived from size targets
 * @param {number} [options.rawBytes]
 * @param {boolean} [options.lean=false] — tiny blobs for fast unit tests (counts still full-scale unless scaleDown)
 * @param {number} [options.scaleDown] — divide turn/message targets (test-only)
 */
function generatePerfFixture(options) {
  const seed = options.seed == null ? 42 : options.seed
  const shape = resolveWorkloadShape({ workload: options.workload })
  const scaleDown = options.scaleDown && options.scaleDown > 1 ? options.scaleDown : 1
  const scaledShape = { ...shape }
  if (scaleDown > 1) {
    scaledShape.turnsPerSeat = Math.max(1, Math.ceil(shape.turnsPerSeat / scaleDown))
    scaledShape.soakTurns = shape.soakTurns
      ? Math.max(1, Math.ceil(shape.soakTurns / scaleDown))
      : 0
    scaledShape.messageTarget = Math.max(
      2,
      Math.ceil((shape.messageTarget || shape.messageTargetHint) / scaleDown)
    )
    scaledShape.toolActivityTarget = Math.max(
      1,
      Math.ceil((shape.toolActivityTarget || 1) / scaleDown)
    )
    scaledShape.chatSerializedTargetBytes = Math.max(
      64 * 1024,
      Math.floor(shape.chatSerializedTargetBytes / scaleDown)
    )
    scaledShape.toolSerializedTargetBytes = Math.max(
      32 * 1024,
      Math.floor(shape.toolSerializedTargetBytes / scaleDown)
    )
  }

  const rand = createPrng(seed)
  const baseTs =
    options.baseTimestamp == null ? Date.UTC(2026, 7, 3, 12, 0, 0) : options.baseTimestamp
  const includeHotRaw = options.includeHotRaw !== false

  const expectedAssistants =
    scaledShape.soakTurns > 0
      ? scaledShape.soakTurns
      : scaledShape.turnsPerSeat * scaledShape.seatCount
  const expectedTools = expectedAssistants * scaledShape.toolsPerAssistant
  const derived = deriveToolByteBudgets(
    Math.max(1, expectedTools),
    scaledShape.toolSerializedTargetBytes
  )
  const lean = options.lean === true
  const paramBytes = lean
    ? 24
    : options.paramBytes == null
      ? derived.paramBytes
      : options.paramBytes
  const rawBytes = lean ? 32 : options.rawBytes == null ? derived.rawBytes : options.rawBytes

  const participants = []
  for (let i = 0; i < scaledShape.seatCount; i++) {
    const provider = PROVIDERS[i % PROVIDERS.length]
    participants.push({
      id: `perf-seat-${pad(i + 1, 2)}`,
      provider,
      model: `${provider}-perf-model`,
      role: i === 0 ? 'Boss' : i === 1 ? 'Captain' : `Seat${i + 1}`,
      order: i,
      enabled: true
    })
  }

  /** @type {object[]} */
  const chats = []
  for (let c = 0; c < scaledShape.chatCount; c++) {
    const appChatId = `perf-${scaledShape.workload}-chat-${pad(c + 1, 2)}`
    /** @type {object[]} */
    const messages = []
    /** @type {object[]} */
    const runs = []
    let msgIndex = 0
    let toolIndex = 0
    let t = baseTs

    messages.push({
      id: `${appChatId}-m-${pad(++msgIndex, 5)}`,
      role: 'user',
      content: `PERF_FIXTURE workload=${scaledShape.workload} seed=${seed} chat=${c + 1}`,
      timestamp: new Date(t).toISOString()
    })
    t += 1000

    const runA = {
      id: `${appChatId}-run-a`,
      status: scaledShape.dualConcurrentRuns ? 'running' : 'done',
      provider: participants[0].provider,
      startedAt: new Date(t).toISOString()
    }
    runs.push(runA)
    let runB = null
    if (scaledShape.dualConcurrentRuns) {
      runB = {
        id: `${appChatId}-run-b`,
        status: 'running',
        provider: participants[1] ? participants[1].provider : participants[0].provider,
        startedAt: new Date(t + 50).toISOString()
      }
      runs.push(runB)
    }

    /**
     * @param {object} seat
     * @param {number} turnLabel
     * @param {object} [extraMeta]
     */
    function pushAssistant(seat, turnLabel, extraMeta) {
      const runId = runB && seat.order % 2 === 1 ? runB.id : runA.id
      const assistantId = `${appChatId}-m-${pad(++msgIndex, 5)}`
      const toolActivities = []
      for (let k = 0; k < scaledShape.toolsPerAssistant; k++) {
        const toolName = TOOL_NAMES[(seat.order + turnLabel + k) % TOOL_NAMES.length]
        toolActivities.push(
          buildToolActivity({
            id: `${appChatId}-tool-${pad(++toolIndex, 5)}`,
            toolName,
            provider: seat.provider,
            participantId: seat.id,
            startedAt: new Date(t).toISOString(),
            includeRaw: includeHotRaw,
            paramBytes,
            rawBytes,
            rand
          })
        )
        t += 15
      }
      messages.push({
        id: assistantId,
        role: 'assistant',
        content: `Seat ${seat.role} turn ${turnLabel} synthetic reply.`,
        timestamp: new Date(t).toISOString(),
        runId,
        toolActivities,
        metadata: {
          ensembleProvider: seat.provider,
          ensembleParticipantId: seat.id,
          ensembleRole: seat.role,
          ensembleModel: seat.model,
          ...(extraMeta || {})
        }
      })
      t += 40
    }

    if (scaledShape.soakTurns > 0) {
      // Literal 455-turn (or scaled) mutation schedule: one assistant turn per soak index.
      for (let turn = 1; turn <= scaledShape.soakTurns; turn++) {
        const seat = participants[(turn - 1) % participants.length]
        pushAssistant(seat, turn, { soakTurn: turn, kind: 'perfSoakTurn' })
      }
    } else {
      for (let turn = 0; turn < scaledShape.turnsPerSeat; turn++) {
        for (let s = 0; s < scaledShape.seatCount; s++) {
          pushAssistant(participants[s], turn + 1)
        }
      }
    }

    const chat = {
      appChatId,
      title: `Perf fixture ${scaledShape.workload} #${c + 1}`,
      provider: participants[0].provider,
      createdAt: baseTs,
      updatedAt: t,
      persistenceRevision: 1,
      archived: false,
      messages,
      runs,
      ensemble: {
        enabled: true,
        orchestrationMode: 'continuous',
        participants,
        activeRound: {
          id: `${appChatId}-round-1`,
          status: 'running',
          startedAt: new Date(baseTs + 500).toISOString(),
          participants: participants.map((p) => ({
            ...p,
            status: 'working'
          }))
        }
      },
      _perfMeta: {
        workload: scaledShape.workload,
        seed,
        seatCount: scaledShape.seatCount,
        messageCount: messages.length,
        toolActivityCount: toolIndex,
        dualConcurrentRuns: Boolean(scaledShape.dualConcurrentRuns),
        soakTurns: scaledShape.soakTurns || 0,
        paramBytes,
        rawBytes,
        lean,
        scaleDown
      }
    }
    chats.push(chat)
  }

  const fixture = {
    schemaVersion: 1,
    workload: shape.workload,
    seed,
    generatedAt: new Date(baseTs).toISOString(),
    shape: scaledShape,
    unscaledShape: shape,
    chats,
    totals: {
      chatCount: chats.length,
      messageCount: chats.reduce((n, chat) => n + chat.messages.length, 0),
      toolActivityCount: chats.reduce((n, chat) => n + chat._perfMeta.toolActivityCount, 0),
      seatCount: scaledShape.seatCount,
      chatSerializedBytes: 0,
      toolSerializedBytes: 0
    }
  }

  let chatBytes = 0
  let toolBytes = 0
  for (const chat of chats) {
    const { _perfMeta, ...persisted } = chat
    void _perfMeta
    const serialized = Buffer.byteLength(JSON.stringify(persisted), 'utf8')
    chatBytes += serialized
    toolBytes += measureToolSerializedBytes(chat)
    chat._perfMeta.chatSerializedBytes = serialized
    chat._perfMeta.toolSerializedBytes = measureToolSerializedBytes(chat)
  }
  fixture.totals.chatSerializedBytes = chatBytes
  fixture.totals.toolSerializedBytes = toolBytes
  fixture.replaySchedule = buildReplaySchedule(fixture)
  return fixture
}

/**
 * Stable fingerprint for before/after pairing (excludes wall-clock).
 * @param {ReturnType<typeof generatePerfFixture>} fixture
 */
function fixtureFingerprint(fixture) {
  const lean = {
    schemaVersion: fixture.schemaVersion,
    workload: fixture.workload,
    seed: fixture.seed,
    totals: {
      chatCount: fixture.totals.chatCount,
      messageCount: fixture.totals.messageCount,
      toolActivityCount: fixture.totals.toolActivityCount,
      seatCount: fixture.totals.seatCount
    },
    shape: {
      turnsPerSeat: fixture.shape.turnsPerSeat,
      toolsPerAssistant: fixture.shape.toolsPerAssistant,
      soakTurns: fixture.shape.soakTurns || 0,
      dualConcurrentRuns: fixture.shape.dualConcurrentRuns,
      messageTarget: fixture.shape.messageTarget,
      toolActivityTarget: fixture.shape.toolActivityTarget
    },
    chatIds: fixture.chats.map((c) => c.appChatId),
    firstMessageId:
      fixture.chats[0] && fixture.chats[0].messages[0] ? fixture.chats[0].messages[0].id : null,
    lastMessageId: fixture.chats[0]
      ? fixture.chats[0].messages[fixture.chats[0].messages.length - 1].id
      : null,
    replayEventCount: Array.isArray(fixture.replaySchedule) ? fixture.replaySchedule.length : 0
  }
  return crypto.createHash('sha256').update(JSON.stringify(lean)).digest('hex')
}

module.exports = {
  PROVIDERS,
  TOOL_NAMES,
  OBSERVED_30SEAT,
  OBSERVED_50SEAT,
  createPrng,
  resolveWorkloadShape,
  deriveToolByteBudgets,
  generatePerfFixture,
  fixtureFingerprint,
  buildReplaySchedule,
  measureToolSerializedBytes
}

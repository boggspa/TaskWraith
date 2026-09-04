/**
 * Bench for the many-seat fan-out main-thread chonk (perf goal
 * goal-1788376559879).
 *
 * WHAT THIS BENCH PROVES:
 * `runParallelFanoutPass` originally built EVERY lane's dispatch payload
 * synchronously inside one `laneRuns.map(...)` body — roster stamp,
 * dynamic-state snapshot, full tagged-transcript projection, routing prompts,
 * project appendix and posture signature per lane — with ZERO event-loop
 * yields, so an N-seat wave landed as one uninterrupted main-thread burst
 * before any provider dispatch fired.
 *
 * MEASUREMENT HISTORY (20-seat wave, ~400 messages, ~2.6 KB each):
 *   - Pre-fix (original synchronous mapper): 85.6 ms longest block
 *   - RED re-proof (yield line commented out): 72.4 ms longest block
 *   - Post-fix (hoisted invariants + setImmediate yields, no warm-up):
 *     34–42 ms (lane 0 JIT-cold, fused to pre-loop section)
 *   - Post-fix + warm-up: see FANOUT_BURST lines below
 *
 * WARM-UP APPROACH:
 * The first call to `buildEnsembleParticipantPromptProjection` pays V8
 * interpreter startup + IC warm-up (~5–10× steady-state cost). Production
 * warms these paths during the Boss's serial dispatch before any fan-out
 * wave. The bench replicates this by calling the real projection function
 * 5× for 3 different participants before the measured wave, then resetting
 * counters. This isolates the steady-state per-lane cost from JIT cold-start.
 *
 * MEASUREMENT CAVEAT:
 * `monitorEventLoopDelay` under-reports inside the vitest worker pool
 * (~2.5 ms for the same 85 ms block; verified in plain node where both
 * probes agree). The bench takes `max(histogram, setImmediate tick-gap
 * probe)` as the primary number — keep that when verifying GREEN, and use
 * `blockEndOffsetMs` to confirm the measured block is still the mapper.
 *
 * STRUCTURAL YIELD PROOF (machine-independent):
 * The setImmediate probe fires a callback on every event-loop turn. Without
 * yields, the entire wave is one macrotask and the probe sees ~1–2 ticks.
 * With yields between lanes, the probe sees >= N-1 ticks (or >= N when the
 * yield is unconditional including lane 0). This assertion is the PRIMARY
 * proof that yields are working — it does not depend on absolute timing.
 *
 * OUTPUT FORMAT (one `FANOUT_BURST` line for CI scraping):
 *   lanes, dispatched, maxEventLoopDelayMs, histogramMaxMs, tickGapMaxMs,
 *   blockEndOffsetMs, waveMs, projectionCount, projectionTotalMs,
 *   snapshotCount, snapshotTotalMs, saveChatCount,
 *   gcCount, gcMaxMs, gcTotalMs, gcKindMax, blockStartOffsetMs,
 *   probeTicksDuringWave
 */
import { describe, expect, it, vi } from 'vitest'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import { EnsembleHostAdmissionRuntime } from './EnsembleHostAdmissionRuntime'
import { buildEnsembleParticipantPromptProjection } from '../EnsemblePrompt'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type {
  AppSettings,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleParticipant,
  ToolActivity
} from '../store/types'

// ---------------------------------------------------------------------------
// Instrumentation: count + time the two per-lane EnsemblePrompt builders.
// vi.hoisted so the vi.mock factory (hoisted above imports) can reach them.
// ---------------------------------------------------------------------------
const burstCounters = vi.hoisted(() => ({
  projection: { count: 0, totalMs: 0 },
  snapshot: { count: 0, totalMs: 0 },
  shellStamp: { count: 0, totalMs: 0 }
}))
const buildTurnState = vi.hoisted(() => ({ ordinal: 0 }))

// Timeline events recorded during the wave window. Each entry is
// { offsetMs, kind, detail? } where offsetMs is ms since waveStart.
const timelineEvents = vi.hoisted(
  () =>
    [] as Array<{
      offsetMs: number
      kind: string
      detail?: string
    }>
)

// Per-projection timing recorded during the wave window.
// Used to identify which participant's projection is the slowest.
const projectionTimings = vi.hoisted(
  () =>
    [] as Array<{
      participantId: string
      provider: string
      role: string
      durationMs: number
      buildTurnOrdinal: number
    }>
)

vi.mock('../EnsemblePrompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../EnsemblePrompt')>()
  const now = (): number => globalThis.performance?.now() ?? Date.now()
  return {
    ...actual,
    buildEnsembleParticipantPromptProjection: (
      input: Parameters<typeof actual.buildEnsembleParticipantPromptProjection>[0]
    ): ReturnType<typeof actual.buildEnsembleParticipantPromptProjection> => {
      const t0 = now()
      const result = actual.buildEnsembleParticipantPromptProjection(input)
      const elapsed = now() - t0
      burstCounters.projection.totalMs += elapsed
      burstCounters.projection.count += 1
      // Record per-projection timing with participant identity for
      // pass-3d Ollama warm-up analysis.
      projectionTimings.push({
        participantId: input.participant.id,
        provider: input.participant.provider,
        role: input.participant.role,
        durationMs: elapsed,
        buildTurnOrdinal: buildTurnState.ordinal
      })
      return result
    },
    buildEnsembleDynamicStateSnapshot: (
      chat: Parameters<typeof actual.buildEnsembleDynamicStateSnapshot>[0],
      config: Parameters<typeof actual.buildEnsembleDynamicStateSnapshot>[1]
    ): ReturnType<typeof actual.buildEnsembleDynamicStateSnapshot> => {
      const t0 = now()
      const result = actual.buildEnsembleDynamicStateSnapshot(chat, config)
      burstCounters.snapshot.totalMs += now() - t0
      burstCounters.snapshot.count += 1
      return result
    },
    computeEnsemblePromptShellStamp: (
      config: Parameters<typeof actual.computeEnsemblePromptShellStamp>[0],
      options?: Parameters<typeof actual.computeEnsemblePromptShellStamp>[1]
    ): ReturnType<typeof actual.computeEnsemblePromptShellStamp> => {
      const t0 = now()
      const result = actual.computeEnsemblePromptShellStamp(config, options)
      burstCounters.shellStamp.totalMs += now() - t0
      burstCounters.shellStamp.count += 1
      return result
    }
  }
})

// ---------------------------------------------------------------------------
// Deterministic transcript fixtures (~400 messages, ~2 KB each, realistic
// ensemble metadata + tool activities so the tagged-transcript projection
// does its real walks: tool-activity indexing, filtering, per-seat windowing).
// ---------------------------------------------------------------------------
const LANE_COUNT = 20
const MESSAGE_COUNT = 400
const RUN_COUNT = 50

const SENTENCES = [
  'The fan-out wave dispatched every seat before any provider event landed.',
  'Recon shows the synchronous mapper recomputes identical values per lane.',
  'Save batching coalesced the seeds into one composed save as designed.',
  'Event-loop lag correlates with the seat count at dispatch time.',
  'The tagged transcript projection walks the full history for every seat.',
  'Dispatch closures chain by microtasks, so no timer or IPC can run between lanes.',
  'The dynamic-state snapshot hashes goal, authority, session events and plan.',
  'Posture signing HMACs the entire composed prompt string per lane.',
  'Renderer patches stayed under the 10 Hz delivery ceiling during the burst.',
  'Local admission resolved immediately for every hosted provider lane.',
  'The composed seed save carried every lane run row and lane record.',
  'Bench numbers belong on one prefixed line so CI can scrape them.'
]

function makeContent(index: number): string {
  const parts: string[] = []
  let total = 0
  let cursor = index
  // ~2.6 KB of plausible panel prose per message (top of the 1.5-3 KB range,
  // so per-lane scans exercise realistic string work).
  while (total < 2600) {
    const sentence = SENTENCES[cursor % SENTENCES.length]
    parts.push(`[m${index}] ${sentence}`)
    total += sentence.length
    cursor += 7
  }
  return parts.join(' ')
}

function makeToolActivities(index: number): ToolActivity[] {
  const tools = [
    { name: 'read', display: 'Read file', category: 'read' },
    { name: 'run_shell_command', display: 'Run command', category: 'shell' },
    { name: 'grep', display: 'Search file contents', category: 'search' }
  ] as const
  return [0, 1, 2].map((k) => ({
    id: `act-${index}-${k}`,
    toolName: tools[k].name,
    displayName: tools[k].display,
    category: tools[k].category,
    status: 'success',
    startedAt: `2026-09-02T10:00:0${index % 10}.000Z`,
    endedAt: `2026-09-02T10:00:0${(index + 1) % 10}.000Z`,
    durationMs: 12 + index,
    parameters: { path: `src/bench/file-${index}-${k}.ts` },
    resultSummary: `ok ${index}-${k}`
  })) as ToolActivity[]
}

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model: `${provider}-model`,
    permissionPresetId: 'workspace_write'
  }
}

function makeParticipants(): EnsembleParticipant[] {
  const providers: EnsembleParticipant['provider'][] = ['claude', 'kimi', 'pi', 'ollama', 'codex']
  const targets = Array.from({ length: LANE_COUNT }, (_, i) =>
    participant(`seat-${i + 1}`, providers[i % providers.length], `Seat${i + 1}`, i + 2)
  )
  return [participant('codex', 'codex', 'Lead', 1), ...targets]
}

function makeMessages(participants: EnsembleParticipant[]): ChatMessage[] {
  const seats = participants.filter((p) => p.id !== 'codex')
  const messages: ChatMessage[] = []
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const isUser = i % 4 === 0
    const seat = seats[i % seats.length]
    const roundId = `round-${i % 7}`
    const base: ChatMessage = {
      id: `msg-${i}`,
      role: isUser ? 'user' : 'assistant',
      content: makeContent(i),
      timestamp: `2026-09-02T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
    }
    if (isUser) {
      if (i === 0) {
        base.metadata = { kind: 'ensembleRoundPrompt', ensembleRoundId: roundId }
      }
    } else {
      base.metadata = { ensembleParticipantId: seat.id, ensembleRoundId: roundId }
      base.runId = `hist-run-${i % RUN_COUNT}`
      // Assistant-only: the projection indexes tool activities by runId, and
      // only rows that carry both participate.
      if (i % 8 === 1 || i % 8 === 3) {
        base.toolActivities = makeToolActivities(i)
      }
    }
    messages.push(base)
  }
  return messages
}

function makeRuns(): ChatRun[] {
  return Array.from({ length: RUN_COUNT }, (_, i) => ({
    runId: `hist-run-${i}`,
    provider: 'claude',
    startedAt: `2026-09-02T09:00:${String(i % 60).padStart(2, '0')}.000Z`,
    endedAt: `2026-09-02T09:01:${String(i % 60).padStart(2, '0')}.000Z`,
    status: 'completed',
    ensembleRoundId: `round-${i % 7}`,
    ensembleParticipantId: `seat-${(i % LANE_COUNT) + 1}`
  })) as unknown as ChatRun[]
}

function makeChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Fan-out main-thread burst bench',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: makeMessages(participants),
    runs: makeRuns(),
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      fanoutPolicy: 'read_only',
      // Assigned Boss keeps the opening writer pass serial, matching the
      // shape every other fan-out test drives (and production Continuous
      // rounds run under).
      bossmanParticipantId: 'codex',
      participants
    }
  } as unknown as ChatRecord
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as unknown as AppSettings
}

describe('fan-out main-thread burst (RED bench)', () => {
  it(
    'measures the synchronous per-lane build burst of a 20-seat wave',
    { timeout: 120_000 },
    async () => {
      const participants = makeParticipants()
      let chat = makeChat(participants)
      let counter = 0
      let saveCount = 0
      const dispatched: AgentRunPayload[] = []
      let resolveWaveDispatches!: () => void
      const waveDispatchesDone = new Promise<void>((resolve) => {
        resolveWaveDispatches = resolve
      })
      const waveStartRef = { current: 0 }
      const inWaveRef = { current: false }
      const recordTimeline = (kind: string, detail?: string): void => {
        if (!inWaveRef.current) return
        timelineEvents.push({ offsetMs: performance.now() - waveStartRef.current, kind, detail })
      }
      const orchestrator = new EnsembleOrchestrator({
        getChat: () => {
          recordTimeline('getChat')
          return chat
        },
        saveChat: (next: ChatRecord) => {
          chat = next
          saveCount += 1
          // Label the save by inspecting the last message's metadata.
          const lastMsg = next.messages[next.messages.length - 1]
          const isStatus = lastMsg?.metadata?.kind === 'ensembleRoundStatus'
          const statusPreview = isStatus ? String(lastMsg.content || '').slice(0, 40) : undefined
          const runDelta = next.runs.length - (chat?.runs?.length ?? next.runs.length)
          recordTimeline(
            'saveChat',
            isStatus
              ? `status: ${statusPreview}…`
              : runDelta > 0
                ? `seed-batch (runs+${runDelta})`
                : `other (runs=${next.runs.length})`
          )
        },
        getSettings: makeSettings,
        hostAdmissionRuntime: new EnsembleHostAdmissionRuntime({
          scheduleBuildTurn: (task) => {
            setImmediate(() => {
              buildTurnState.ordinal += 1
              task()
            })
          }
        }),
        dispatch: vi.fn(async (payload: AgentRunPayload) => {
          dispatched.push(payload)
          recordTimeline('dispatch', payload.appRunId)
          if (dispatched.length === LANE_COUNT + 1) resolveWaveDispatches()
          return { dispatched: true, appRunId: payload.appRunId || '' }
        }),
        cancelRun: vi.fn(async () => true),
        createRunId: (provider) => `${provider}-run-${++counter}`,
        now: () => counter,
        nowIso: () => `2026-09-02T10:00:0${counter % 10}.000Z`,
        // Payload-shape fidelity only: production signs the full prompt here;
        // the signature itself is main-built in index.ts, not in this seam.
        signRunPermissionPosture: () => 'bench-posture-sig'
      } as unknown as ConstructorParameters<typeof EnsembleOrchestrator>[0])

      // Opening serial pass dispatches exactly the Boss (bossmanParticipantId set).
      orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead dispatches one twenty-lane wave.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(dispatched).toHaveLength(1), { timeout: 15_000 })
      const bossRunId = dispatched[0].appRunId

      // --- WARM-UP: warm V8 JIT for the hot projection path -----------
      // Production warms these paths during the Boss's serial dispatch
      // before any fan-out wave. We replicate by calling the real
      // projection function 5× for 4 different participants (one per
      // provider family: claude, kimi, pi, ollama), then reset counters.
      // This isolates steady-state per-lane cost from JIT cold-start
      // (first call is typically 5–10× slower) and tests whether the
      // first Ollama seat's projection is once-per-process JIT or
      // per-wave cost (pass-3d analysis).
      const warmupChat = makeChat(participants)
      const warmupConfig = warmupChat.ensemble!
      for (let p = 1; p <= 4; p++) {
        const warmupParticipant = participants[p]
        for (let r = 0; r < 5; r++) {
          buildEnsembleParticipantPromptProjection({
            chat: warmupChat,
            config: warmupConfig,
            participant: warmupParticipant,
            currentPrompt: `warm-up prompt ${r} for ${warmupParticipant.role}`,
            roundId: `warm-up-round-${p}`,
            chatContextTurns: 8
          })
        }
      }
      // Reset counters after warm-up so the measured wave starts clean.
      burstCounters.projection.count = 0
      burstCounters.projection.totalMs = 0
      burstCounters.snapshot.count = 0
      burstCounters.snapshot.totalMs = 0
      burstCounters.shellStamp.count = 0
      burstCounters.shellStamp.totalMs = 0
      timelineEvents.length = 0
      projectionTimings.length = 0
      buildTurnState.ordinal = 0

      // The Boss's own serial prompt build already happened; measure ONLY the
      // fan-out wave window from here.
      const savesBeforeWave = saveCount

      // Longest synchronous block, measured two ways:
      // 1. perf_hooks event-loop-delay histogram (the production metric).
      const histogram = monitorEventLoopDelay({ resolution: 1 })
      histogram.enable()
      // 2. Cross-check probe: consecutive setImmediate callbacks stop dead
      //    while the event loop is blocked, so the max inter-callback gap
      //    tracks the longest synchronous stretch. This one is immune to the
      //    vitest worker-pool blind spot where monitorEventLoopDelay can
      //    sample a different loop context than the one running the test
      //    (observed: histogram ~3 ms vs probe ~70-90 ms for the SAME block;
      //    verified in plain node that both agree outside the pool).
      //
      //    The probe also counts ticks during the wave window — this is the
      //    STRUCTURAL YIELD PROOF: without yields the wave is one macrotask
      //    and the probe sees ~1–2 ticks; with yields between lanes it sees
      //    >= N-1 ticks (or >= N when yield is unconditional including lane 0).
      let probing = true
      let lastTickAt = performance.now()
      let maxTickGapMs = 0
      let maxTickGapEndAt = lastTickAt
      let inWaveWindow = false
      let probeTicksDuringWave = 0
      const tick = (): void => {
        const at = performance.now()
        const gap = at - lastTickAt
        if (gap > maxTickGapMs) {
          maxTickGapMs = gap
          maxTickGapEndAt = at
        }
        lastTickAt = at
        if (inWaveWindow) {
          probeTicksDuringWave += 1
          recordTimeline('tick', `#${probeTicksDuringWave}`)
        }
        if (probing) setImmediate(tick)
      }
      setImmediate(tick)

      // GC attribution: observe major GC pauses during the wave window.
      let gcCount = 0
      let gcMaxMs = 0
      let gcTotalMs = 0
      let gcKindMax = 'unknown'
      const gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          gcCount += 1
          gcTotalMs += entry.duration
          if (entry.duration > gcMaxMs) {
            gcMaxMs = entry.duration
            // Node ≥ 16 exposes detail.kind; fall back to entry.entryType.
            gcKindMax =
              (entry as unknown as { detail?: { kind?: string } }).detail?.kind ?? entry.entryType
          }
        }
      })
      gcObserver.observe({ entryTypes: ['gc'] })

      const waveStart = performance.now()
      waveStartRef.current = waveStart
      inWaveRef.current = true
      inWaveWindow = true
      const wave = await orchestrator.fanoutForRun(bossRunId, {
        targets: participants.slice(1).map((p) => p.role),
        prompt: 'One wave, twenty lanes — bench the build burst.'
      })
      const receiptMs = performance.now() - waveStart
      const dispatchedAtReceipt = dispatched.length
      const projectionsAtReceipt = burstCounters.projection.count
      // Keep the measurement window open through the queued tail. The original
      // structural and relative gates measure the whole wave, not merely the
      // now-early admission receipt.
      await Promise.race([
        waveDispatchesDone,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('fan-out dispatch drain timed out')),
            15_000
          )
          timer.unref?.()
        })
      ])
      inWaveWindow = false
      inWaveRef.current = false
      const waveMs = performance.now() - waveStart

      gcObserver.disconnect()
      probing = false
      histogram.disable()
      const histogramMaxMs = histogram.max / 1e6
      // Primary number: worst of both probes (see blind-spot note above).
      const maxEventLoopDelayMs = Math.max(histogramMaxMs, maxTickGapMs)
      const blockEndOffsetMs = maxTickGapEndAt - waveStart
      const blockStartOffsetMs = blockEndOffsetMs - maxEventLoopDelayMs
      const waveSaves = saveCount - savesBeforeWave

      console.info(
        `FANOUT_BURST lanes=${LANE_COUNT} dispatched=${dispatched.length} ` +
          `maxEventLoopDelayMs=${maxEventLoopDelayMs.toFixed(1)} ` +
          `histogramMaxMs=${histogramMaxMs.toFixed(1)} ` +
          `tickGapMaxMs=${maxTickGapMs.toFixed(1)} ` +
          `blockEndOffsetMs=${blockEndOffsetMs.toFixed(1)} ` +
          `receiptMs=${receiptMs.toFixed(1)} ` +
          `dispatchedAtReceipt=${dispatchedAtReceipt} ` +
          `projectionsAtReceipt=${projectionsAtReceipt} ` +
          `waveMs=${waveMs.toFixed(1)} ` +
          `projectionCount=${burstCounters.projection.count} ` +
          `projectionTotalMs=${burstCounters.projection.totalMs.toFixed(1)} ` +
          `snapshotCount=${burstCounters.snapshot.count} ` +
          `snapshotTotalMs=${burstCounters.snapshot.totalMs.toFixed(1)} ` +
          `shellStampCount=${burstCounters.shellStamp.count} ` +
          `shellStampTotalMs=${burstCounters.shellStamp.totalMs.toFixed(1)} ` +
          `saveChatCount=${waveSaves} ` +
          `gcCount=${gcCount} ` +
          `gcMaxMs=${gcMaxMs.toFixed(1)} ` +
          `gcTotalMs=${gcTotalMs.toFixed(1)} ` +
          `gcKindMax=${gcKindMax} ` +
          `blockStartOffsetMs=${blockStartOffsetMs.toFixed(1)} ` +
          `probeTicksDuringWave=${probeTicksDuringWave}`
      )

      // --- FANOUT_TIMELINE: compact event timeline for the wave window ---
      // Sort by offset, then collapse runs of identical kinds into
      // "kind×N [first..last]" notation. Bracket the measured block by
      // the nearest named events before and after it.
      const sorted = [...timelineEvents].sort((a, b) => a.offsetMs - b.offsetMs)
      const compacted: string[] = []
      let i = 0
      while (i < sorted.length) {
        const kind = sorted[i].kind
        let j = i + 1
        while (j < sorted.length && sorted[j].kind === kind) j += 1
        const count = j - i
        if (count === 1) {
          const detail = sorted[i].detail ? `(${sorted[i].detail})` : ''
          compacted.push(`${sorted[i].offsetMs.toFixed(1)}ms:${kind}${detail}`)
        } else {
          compacted.push(
            `${sorted[i].offsetMs.toFixed(1)}ms:${kind}×${count} [${sorted[i].offsetMs.toFixed(1)}..${sorted[j - 1].offsetMs.toFixed(1)}]`
          )
        }
        i = j
      }

      // Find the nearest named events bracketing the block.
      const blockStart = blockStartOffsetMs
      const blockEnd = blockEndOffsetMs
      const beforeBlock = sorted.filter((e) => e.offsetMs <= blockStart)
      const afterBlock = sorted.filter((e) => e.offsetMs >= blockEnd)
      const bracketBefore = beforeBlock.length > 0 ? beforeBlock[beforeBlock.length - 1] : null
      const bracketAfter = afterBlock.length > 0 ? afterBlock[0] : null

      console.info(
        `FANOUT_TIMELINE block=${blockStart.toFixed(1)}..${blockEnd.toFixed(1)}ms ` +
          `events=${compacted.join(' | ')} ` +
          `bracket=[${bracketBefore ? `${bracketBefore.offsetMs.toFixed(1)}ms:${bracketBefore.kind}` : 'start'} .. ${bracketAfter ? `${bracketAfter.offsetMs.toFixed(1)}ms:${bracketAfter.kind}` : 'end'}]`
      )

      // --- FANOUT_PROJECTIONS: top-3 slowest per-projection timings ---
      // Identifies which participant's projection is the outlier (pass-3d
      // Ollama warm-up analysis).
      const sortedProjections = [...projectionTimings].sort((a, b) => b.durationMs - a.durationMs)
      const top3 = sortedProjections.slice(0, 3)
      const projectionEntries = top3.map(
        (p) => `${p.provider}:${p.role}=${p.durationMs.toFixed(1)}ms`
      )
      console.info(
        `FANOUT_PROJECTIONS count=${projectionTimings.length} ` +
          `totalMs=${burstCounters.projection.totalMs.toFixed(1)} ` +
          `top3=${projectionEntries.join(', ')}`
      )

      // --- Structural facts that are TRUE today -------------------------
      expect(wave.ok).toBe(true)
      expect(wave.laneIds).toHaveLength(LANE_COUNT)
      expect(wave.hostAdmission).toMatchObject({ admitted: 3, queued: 17, capacity: 8 })
      // The receipt records a real queued tail instead of waiting for all 20
      // lanes. Immediately admitted mocks may already settle and release more
      // slots while the receipt is forming, so only the strict "not all built"
      // boundary is deterministic here; the held-adapter integration test pins
      // the exact active cap.
      expect(dispatchedAtReceipt).toBeLessThan(LANE_COUNT + 1)
      expect(projectionsAtReceipt).toBeLessThan(LANE_COUNT)
      // Authority-bearing state is read once per admitted lane, after any
      // compaction suspension, so mid-wait revocations cannot be missed.
      expect(burstCounters.snapshot.count).toBe(LANE_COUNT)
      // The wave's save count is BOUNDED (dispatch status + composed seed +
      // a small fixed number of owner/status saves) — never one save per
      // lane; that multiplier was already removed by the T3a seed overlay.
      expect(waveSaves).toBeLessThanOrEqual(6)
      expect(burstCounters.projection.count).toBe(LANE_COUNT)
      const projectionBuildTurns = projectionTimings.map((entry) => entry.buildTurnOrdinal)
      expect(new Set(projectionBuildTurns).size).toBe(LANE_COUNT)
      for (let index = 1; index < projectionBuildTurns.length; index += 1) {
        expect(projectionBuildTurns[index]).toBeGreaterThan(projectionBuildTurns[index - 1])
      }

      // --- Structural yield proof (machine-independent) -----------------
      // One admitted build per macrotask means the probe runs between every
      // lane. A concurrent setImmediate batch would collapse this below N-1.
      expect(probeTicksDuringWave).toBeGreaterThanOrEqual(LANE_COUNT - 1)

      // --- Budget assertions -------------------------------------------
      // No single synchronous block may dominate the fully drained wave.
      expect(maxEventLoopDelayMs).toBeLessThan(0.5 * waveMs)
      // Absolute CI guard: generous enough for 2–3× slower CI runners.
      // Lazy host admission above is the structural proof; this remains a
      // safety net for pathological work inside the admitted prefix.
      expect(maxEventLoopDelayMs).toBeLessThan(100)
    }
  )
})

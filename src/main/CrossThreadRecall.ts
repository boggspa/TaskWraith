/*
 * CrossThreadRecall — pure resolver for the cross-thread retrospection
 * MCP tools (`tw_recall_find` / `tw_recall_read`).
 *
 * An in-thread agent can ask, in natural language, "how far did Ollama get
 * with the auth-refactor yesterday ~6pm in Payments?". The host normalizes
 * the (deliberately vague) {provider, workspace, time, task} references and
 * resolves them against the run-queue index to a ranked, BOUNDED set of
 * candidate past runs — without loading transcripts in the hot path and
 * without ever returning the user's prompt bytes.
 *
 * This module is PURE: no Electron, no AppStore, no fs, no Date.now() of its
 * own (the caller injects `now`). The executor injects the workspace list,
 * the current time, a full-text loader for the top-K (so topic scoring sees
 * more than the shallow `searchText`), and a forensics-availability predicate
 * (so deleted/tombstoned runs are excluded rather than returned as hollow
 * shells). That keeps every correctness trap the adversarial review flagged
 * — canonicalize-both-sides workspace matching, timezone-explicit time
 * windows, tombstone exclusion, and a conservative 0/1/many classifier that
 * never emits 'one' on a topic match alone — unit-testable in isolation.
 *
 * Time resolution uses host-LOCAL day boundaries (the same basis as
 * DailyTokenSeries). v1 only resolves recall issued from the host, so the
 * host wall-clock is correct; remote/iOS-issued recall is blocked upstream
 * until phone-tz propagation lands. DST correctness is delegated to platform
 * `Date` arithmetic.
 */

import type { ProviderId, RunQueueJob, WorkspaceRecord } from './store/types'
import { resolveCanonicalWorkspaceId } from './WorkspaceIdentity'

/** Raw, deliberately-vague references as the model passes them. Every field
 * is optional — the agent may give only a task description, or all four. */
export interface RecallCriteria {
  provider?: string | null
  workspace?: string | null
  timeApprox?: string | null
  taskQuery?: string | null
  freeText?: string | null
}

export interface RecallTimeWindow {
  startMs: number
  endMs: number
  /** A specific instant the user pointed at ("~6pm"), used for proximity
   * scoring within the window. Absent for whole-day / range references. */
  focalMs?: number
  /** Human-readable echo, e.g. "yesterday around 18:00 (16:00–20:00, 14 Jun)". */
  label: string
}

/** The host's interpretation of the vague criteria, echoed back so a wrong
 * assumption (a misread workspace, the wrong day) is legible to the user. */
export interface RecallInterpretation {
  provider: ProviderId | null
  providerLabel: string | null
  workspaceId: string | null
  workspaceLabel: string | null
  timeWindow: RecallTimeWindow | null
  /** IANA tz name the time window was resolved in ("America/Los_Angeles"). */
  timeZone: string
  taskQuery: string | null
  /** Notes about anything that could not be resolved (unknown workspace,
   * unparseable time, unrecognized provider) — surfaced to the agent. */
  notes: string[]
}

export type RecallMatchKind = 'one' | 'many' | 'none'

/** A candidate past run. STRUCTURAL FIELDS ONLY — never carries the user's
 * prompt bytes (`promptPreview`) or any transcript content; those are
 * sensitive and gated behind `tw_recall_read`. */
export interface RecallCandidate {
  runId: string
  jobId: string
  chatId: string | null
  provider: ProviderId
  workspaceId: string | null
  workspaceLabel: string | null
  status: string
  startedAtIso: string | null
  startedAtMs: number | null
  /** 0..1 confidence this candidate is the one the user meant. */
  matchScore: number
  /** Per-facet explanation ("provider ollama", "workspace Payments",
   * "~18:02 near 18:00", "task match 67%") — never includes prompt text. */
  why: string[]
}

export interface RecallResolution {
  interpretation: RecallInterpretation
  matchKind: RecallMatchKind
  candidates: RecallCandidate[]
}

export interface RecallResolverContext {
  workspaces: readonly WorkspaceRecord[]
  /** Injected current time in ms (executor passes Date.now()). */
  now: number
  /** Echoed in the interpretation; defaults to the host's resolved tz. */
  timeZone?: string
  /** Path normalizer for legacy path-form workspace ids (see WorkspaceIdentity). */
  normalizePath?: (value: string) => string
  /** Full-text loader for the BOUNDED top-K only — title + message text — so
   * topic scoring beats the shallow run-queue preview without sweeping every
   * chat. Returns null when the chat is unreadable. Never called in the
   * metadata pre-rank. */
  loadTopicText?: (job: RunQueueJob) => string | null
  /** Returns false for deleted/tombstoned runs whose forensic `.jsonl` is
   * gone, so they are excluded rather than ranked as an empty-but-plausible
   * shell. When omitted, all jobs are assumed available. */
  isForensicsAvailable?: (job: RunQueueJob) => boolean
}

/** Maximum candidates returned — a hard ceiling on the read-amplification a
 * single recall call can cause, and on the disambiguation list size. */
export const RECALL_TOP_K = 10

// Scoring weights (the score is the sum of the facets that fired, capped at 1).
const WEIGHT_PROVIDER = 0.25
const WEIGHT_WORKSPACE = 0.25
const WEIGHT_TIME = 0.2
const WEIGHT_TIME_PROXIMITY = 0.1
const WEIGHT_TOPIC = 0.3

// Classification thresholds for declaring a single confident match.
const SCORE_FLOOR = 0.45
const SCORE_MARGIN = 0.15
const TOPIC_CONFIRM = 0.2

// ± window placed around a focal time ("~6pm"), clamped to the anchored day.
const FOCAL_TOLERANCE_MS = 2 * 60 * 60 * 1000
// Scale for the gaussian-ish time-proximity bonus (closer than this → bonus).
const FOCAL_PROXIMITY_SCALE_MS = 3 * 60 * 60 * 1000

// ── Provider normalization ──────────────────────────────────────────────

// Alias → canonical ProviderId. `gemini` is retained for READING historical
// runs (history is preserved post-retirement); resolution uses assertProviderId
// semantics, not the live-dispatch set.
const PROVIDER_ALIASES: Record<string, ProviderId> = {
  ollama: 'ollama',
  local: 'ollama',
  'local model': 'ollama',
  'local llm': 'ollama',
  llama: 'ollama',
  codex: 'codex',
  gpt: 'codex',
  openai: 'codex',
  chatgpt: 'codex',
  claude: 'claude',
  anthropic: 'claude',
  sonnet: 'claude',
  opus: 'claude',
  haiku: 'claude',
  kimi: 'kimi',
  moonshot: 'kimi',
  grok: 'grok',
  xai: 'grok',
  cursor: 'cursor',
  gemini: 'gemini',
  google: 'gemini'
}

// Longest-first so "local model" wins over "local" in the substring pass.
const PROVIDER_ALIAS_KEYS = Object.keys(PROVIDER_ALIASES).sort((a, b) => b.length - a.length)

/** Map a free-text provider reference ("the local model", "GPT", "Claude") to
 * a ProviderId, or null when nothing matches. */
export function normalizeProviderQuery(raw: string | null | undefined): ProviderId | null {
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  if (!key) return null
  if (PROVIDER_ALIASES[key]) return PROVIDER_ALIASES[key]
  for (const alias of PROVIDER_ALIAS_KEYS) {
    if (key.includes(alias)) return PROVIDER_ALIASES[alias]
  }
  return null
}

// ── Topic scoring ───────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'was',
  'were',
  'did',
  'does',
  'done',
  'got',
  'get',
  'far',
  'how',
  'what',
  'when',
  'where',
  'task',
  'run',
  'runs',
  'agent',
  'yesterday',
  'today',
  'about',
  'from',
  'into',
  'over',
  'around',
  'evening',
  'morning',
  'afternoon',
  'night',
  'workspace',
  'project'
])

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t)
  )
}

/** Fraction of the query tokens present in `text` (0..1). */
function topicOverlap(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0
  const haystack = new Set(tokenize(text))
  if (haystack.size === 0) return 0
  let hits = 0
  for (const token of queryTokens) {
    if (haystack.has(token)) hits += 1
  }
  return hits / queryTokens.length
}

// ── Time resolution (host-local) ────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (n: number): string => String(n).padStart(2, '0')
const fmtClock = (ms: number): string => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const fmtDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

function localTimeZoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'host-local'
  } catch {
    return 'host-local'
  }
}

function startOfLocalDay(now: number, dayOffset: number): Date {
  const d = new Date(now)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(0, 0, 0, 0)
  return d
}

interface PartOfDay {
  startHour: number
  endHour: number
  centerHour: number
}

function parsePartOfDay(text: string): PartOfDay | null {
  if (/\bnoon\b/.test(text)) return { startHour: 11, endHour: 13, centerHour: 12 }
  if (/\bmidnight\b/.test(text)) return { startHour: 0, endHour: 1, centerHour: 0 }
  if (/\bmorning\b/.test(text)) return { startHour: 5, endHour: 12, centerHour: 9 }
  if (/\bafternoon\b/.test(text)) return { startHour: 12, endHour: 17, centerHour: 14 }
  if (/\b(evening|tonight)\b/.test(text)) return { startHour: 17, endHour: 22, centerHour: 19 }
  if (/\bnight\b/.test(text)) return { startHour: 20, endHour: 24, centerHour: 22 }
  return null
}

/** Extract an explicit clock hour from "6pm", "6:30pm", "18:00", or a bare
 * "6" disambiguated by a part-of-day hint ("evening … around 6" → 18:00). */
function parseClock(text: string, part: PartOfDay | null): { hour: number; minute: number } | null {
  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/)
  if (ampm) {
    let hour = parseInt(ampm[1], 10) % 12
    if (ampm[3] === 'pm') hour += 12
    return { hour, minute: ampm[2] ? parseInt(ampm[2], 10) : 0 }
  }
  const h24 = text.match(/\b(\d{1,2}):(\d{2})\b/)
  if (h24) {
    const hour = parseInt(h24[1], 10)
    if (hour <= 23) return { hour, minute: parseInt(h24[2], 10) }
  }
  // Bare hour ("around 6") only resolves with a part-of-day to fix am/pm.
  const bare = text.match(/\b(?:around|about|~|at)\s*(\d{1,2})\b/)
  if (bare && part) {
    let hour = parseInt(bare[1], 10)
    if (hour <= 12 && part.centerHour >= 12 && hour !== 12) hour += 12
    if (hour <= 23) return { hour, minute: 0 }
  }
  return null
}

/** Resolve a vague time reference to an absolute [start,end] interval in
 * host-local time, plus an optional focal instant. Returns null when nothing
 * recognizable is present (caller then applies no time filter + notes it). */
export function resolveTimeWindow(
  timeApprox: string | null | undefined,
  now: number,
  timeZone: string = localTimeZoneLabel()
): RecallTimeWindow | null {
  if (!timeApprox) return null
  const text = timeApprox.trim().toLowerCase()
  if (!text) return null

  // Multi-day ranges first (they don't anchor to a single day).
  const lastN = text.match(/\b(?:last|past|previous)\s+(\d+)\s+days?\b/)
  if (lastN) {
    const n = Math.max(1, parseInt(lastN[1], 10))
    const start = startOfLocalDay(now, -(n - 1))
    return {
      startMs: start.getTime(),
      endMs: now,
      label: `the last ${n} days (since ${fmtDay(start.getTime())}, ${timeZone})`
    }
  }
  if (/\b(last|past|previous)\s+week\b/.test(text)) {
    const start = startOfLocalDay(now, -7)
    return {
      startMs: start.getTime(),
      endMs: now,
      label: `the past week (since ${fmtDay(start.getTime())}, ${timeZone})`
    }
  }
  if (/\bthis\s+week\b/.test(text)) {
    const start = startOfLocalDay(now, -6)
    return {
      startMs: start.getTime(),
      endMs: now,
      label: `this week (since ${fmtDay(start.getTime())}, ${timeZone})`
    }
  }

  // Single-day anchor.
  let dayOffset: number | null = null
  if (/\b(the day before yesterday)\b/.test(text)) dayOffset = -2
  else if (/\b(yesterday|last night)\b/.test(text)) dayOffset = -1
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(text)) dayOffset = 0
  else {
    const nAgo = text.match(/\b(\d+)\s+days?\s+ago\b/)
    if (nAgo) dayOffset = -Math.abs(parseInt(nAgo[1], 10))
  }
  // A bare time-of-day with no day word defaults to today.
  if (dayOffset === null) {
    if (/\d|noon|midnight|morning|afternoon|evening|night/.test(text)) dayOffset = 0
    else return null
  }

  const dayStart = startOfLocalDay(now, dayOffset)
  const dayStartMs = dayStart.getTime()
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000 - 1
  const part = parsePartOfDay(text)
  const clock = parseClock(text, part)

  if (clock) {
    const focal = new Date(dayStart)
    focal.setHours(clock.hour, clock.minute, 0, 0)
    const focalMs = focal.getTime()
    const startMs = Math.max(dayStartMs, focalMs - FOCAL_TOLERANCE_MS)
    const endMs = Math.min(dayEndMs, focalMs + FOCAL_TOLERANCE_MS)
    return {
      startMs,
      endMs,
      focalMs,
      label: `${dayLabelFor(dayOffset)} around ${fmtClock(focalMs)} (${fmtClock(startMs)}–${fmtClock(
        endMs
      )}, ${fmtDay(dayStartMs)}, ${timeZone})`
    }
  }

  if (part) {
    const start = new Date(dayStart)
    start.setHours(part.startHour, 0, 0, 0)
    const end = new Date(dayStart)
    end.setHours(
      part.endHour === 24 ? 23 : part.endHour,
      part.endHour === 24 ? 59 : 0,
      part.endHour === 24 ? 59 : 0,
      part.endHour === 24 ? 999 : 0
    )
    const center = new Date(dayStart)
    center.setHours(part.centerHour, 0, 0, 0)
    return {
      startMs: start.getTime(),
      endMs: Math.min(dayEndMs, end.getTime()),
      focalMs: center.getTime(),
      label: `${dayLabelFor(dayOffset)} ${partLabel(part)} (${fmtClock(start.getTime())}–${fmtClock(
        Math.min(dayEndMs, end.getTime())
      )}, ${fmtDay(dayStartMs)}, ${timeZone})`
    }
  }

  // Whole day.
  return {
    startMs: dayStartMs,
    endMs: dayEndMs,
    label: `${dayLabelFor(dayOffset)} (all of ${fmtDay(dayStartMs)}, ${timeZone})`
  }
}

function dayLabelFor(dayOffset: number): string {
  if (dayOffset === 0) return 'today'
  if (dayOffset === -1) return 'yesterday'
  if (dayOffset === -2) return 'the day before yesterday'
  return `${Math.abs(dayOffset)} days ago`
}

function partLabel(part: PartOfDay): string {
  if (part.centerHour === 9) return 'morning'
  if (part.centerHour === 14) return 'afternoon'
  if (part.centerHour === 19) return 'evening'
  if (part.centerHour === 22) return 'night'
  if (part.centerHour === 12) return 'around noon'
  return 'around midnight'
}

// ── Job helpers ─────────────────────────────────────────────────────────

/** The instant a run "happened", preferring when it actually started. */
function jobAnchorMs(job: RunQueueJob): number | null {
  const iso = job.startedAt || job.enqueuedAt || job.createdAt
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** Internal-only topic signal from cheap run-queue metadata. `promptPreview`
 * is the user's prompt and is used here for RANKING only — it is never copied
 * into a returned candidate. */
function metadataTopicText(job: RunQueueJob): string {
  return [job.promptPreview, job.statusReason, job.lastError].filter(Boolean).join(' ')
}

// ── Resolution ──────────────────────────────────────────────────────────

interface Interpreted {
  interpretation: RecallInterpretation
  /** A named workspace that could not be resolved — we refuse to guess (a
   * privacy boundary), so resolution returns 'none'. */
  workspaceUnresolved: boolean
}

function interpret(criteria: RecallCriteria, ctx: RecallResolverContext): Interpreted {
  const timeZone = ctx.timeZone || localTimeZoneLabel()
  const notes: string[] = []

  const providerRaw = criteria.provider?.trim() || null
  const provider = normalizeProviderQuery(providerRaw)
  if (providerRaw && !provider) {
    notes.push(`Provider "${providerRaw}" wasn't recognized — searching all providers.`)
  }

  const workspaceRaw = criteria.workspace?.trim() || null
  let workspaceId: string | null = null
  let workspaceLabel: string | null = null
  let workspaceUnresolved = false
  if (workspaceRaw) {
    workspaceId = resolveCanonicalWorkspaceId(workspaceRaw, ctx.workspaces, ctx.normalizePath)
    if (workspaceId) {
      workspaceLabel = ctx.workspaces.find((w) => w.id === workspaceId)?.displayName || workspaceRaw
    } else {
      workspaceUnresolved = true
      notes.push(`Workspace "${workspaceRaw}" didn't match any known workspace.`)
    }
  }

  const timeApprox = criteria.timeApprox?.trim() || null
  const timeWindow = resolveTimeWindow(timeApprox, ctx.now, timeZone)
  if (timeApprox && !timeWindow) {
    notes.push(
      `Couldn't pin down "${timeApprox}" to a time window — searching without a time filter.`
    )
  }

  const taskQuery = criteria.taskQuery?.trim() || null

  return {
    interpretation: {
      provider,
      providerLabel: providerRaw,
      workspaceId,
      workspaceLabel,
      timeWindow,
      timeZone,
      taskQuery,
      notes
    },
    workspaceUnresolved
  }
}

interface ScoredCandidate extends RecallCandidate {
  topicScore: number
}

function scoreJob(
  job: RunQueueJob,
  interp: RecallInterpretation,
  queryTokens: string[],
  topicText: string,
  wsLabelById: Map<string, string>,
  ctx: RecallResolverContext
): ScoredCandidate {
  const why: string[] = []
  let score = 0

  if (interp.provider) {
    score += WEIGHT_PROVIDER
    why.push(`provider ${job.provider}`)
  }

  const jobWorkspaceId = resolveCanonicalWorkspaceId(
    job.workspaceId,
    ctx.workspaces,
    ctx.normalizePath
  )
  const workspaceLabel = jobWorkspaceId ? wsLabelById.get(jobWorkspaceId) || null : null
  if (interp.workspaceId) {
    score += WEIGHT_WORKSPACE
    why.push(`workspace ${workspaceLabel || interp.workspaceLabel}`)
  }

  const anchorMs = jobAnchorMs(job)
  if (interp.timeWindow) {
    score += WEIGHT_TIME
    if (interp.timeWindow.focalMs != null && anchorMs != null) {
      const distance = Math.abs(anchorMs - interp.timeWindow.focalMs)
      const proximity = Math.max(0, 1 - distance / FOCAL_PROXIMITY_SCALE_MS)
      score += WEIGHT_TIME_PROXIMITY * proximity
      why.push(`~${fmtClock(anchorMs)} near ${fmtClock(interp.timeWindow.focalMs)}`)
    } else if (anchorMs != null) {
      why.push(`ran ${fmtClock(anchorMs)}`)
    }
  }

  const topicScore = topicOverlap(queryTokens, topicText)
  if (queryTokens.length > 0) {
    score += WEIGHT_TOPIC * topicScore
    if (topicScore > 0) why.push(`task match ${Math.round(topicScore * 100)}%`)
  }

  return {
    runId: job.runId,
    jobId: job.id,
    chatId: job.chatId || null,
    provider: job.provider,
    workspaceId: jobWorkspaceId,
    workspaceLabel,
    status: job.status,
    startedAtIso: job.startedAt || job.enqueuedAt || job.createdAt || null,
    startedAtMs: anchorMs,
    matchScore: Math.min(1, Number(score.toFixed(4))),
    why,
    topicScore
  }
}

function emptyResolution(interp: RecallInterpretation): RecallResolution {
  return { interpretation: interp, matchKind: 'none', candidates: [] }
}

/**
 * Resolve vague recall criteria against a set of run-queue jobs (already
 * fetched cheaply by the executor) into a ranked, bounded candidate set and a
 * conservative match verdict.
 *
 * Hard filters (forensics availability, provider, workspace, time-in-window)
 * remove non-matches; survivors are scored on metadata, the top-K rescored
 * with full text, then classified:
 *   - 'none'  : no survivor (or a named workspace that doesn't exist).
 *   - 'one'   : a single anchored match clears the floor + margin and, when a
 *               task was named, the topic confirms it. NEVER 'one' on topic
 *               alone — a query with no provider/workspace/time anchor always
 *               returns 'many' for the agent to disambiguate.
 *   - 'many'  : everything else; return the top-K for disambiguation.
 */
export function resolveRecall(
  criteria: RecallCriteria,
  jobs: readonly RunQueueJob[],
  ctx: RecallResolverContext
): RecallResolution {
  const { interpretation: interp, workspaceUnresolved } = interpret(criteria, ctx)

  // A named-but-unknown workspace is unsatisfiable — refuse to broaden into
  // other workspaces (that would both mislead and widen the blast radius).
  if (workspaceUnresolved) {
    return emptyResolution(interp)
  }

  const queryTokens = tokenize([criteria.taskQuery, criteria.freeText].filter(Boolean).join(' '))
  const wsLabelById = new Map(ctx.workspaces.map((w) => [w.id, w.displayName]))

  // Hard filters.
  const survivors = jobs.filter((job) => {
    if (ctx.isForensicsAvailable && !ctx.isForensicsAvailable(job)) return false
    if (interp.provider && job.provider !== interp.provider) return false
    if (interp.workspaceId) {
      const jobWs = resolveCanonicalWorkspaceId(job.workspaceId, ctx.workspaces, ctx.normalizePath)
      if (jobWs !== interp.workspaceId) return false
    }
    if (interp.timeWindow) {
      const anchorMs = jobAnchorMs(job)
      if (anchorMs == null) return false
      if (anchorMs < interp.timeWindow.startMs || anchorMs > interp.timeWindow.endMs) return false
    }
    return true
  })

  if (survivors.length === 0) {
    return emptyResolution(interp)
  }

  // Pre-rank on cheap metadata, take top-K, then rescore those with full text.
  const preRanked = survivors
    .map((job) => scoreJob(job, interp, queryTokens, metadataTopicText(job), wsLabelById, ctx))
    .sort(compareCandidates)
  const topK = preRanked.slice(0, RECALL_TOP_K)

  if (ctx.loadTopicText && queryTokens.length > 0) {
    const byRunId = new Map(survivors.map((j) => [j.runId, j]))
    for (let i = 0; i < topK.length; i += 1) {
      const job = byRunId.get(topK[i].runId)
      if (!job) continue
      const loaded = ctx.loadTopicText(job)
      if (loaded == null) continue
      topK[i] = scoreJob(
        job,
        interp,
        queryTokens,
        `${metadataTopicText(job)} ${loaded}`,
        wsLabelById,
        ctx
      )
    }
    topK.sort(compareCandidates)
  }

  const matchKind = classify(interp, topK)
  const candidates: RecallCandidate[] = topK.map(stripInternal)
  return { interpretation: interp, matchKind, candidates }
}

function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore
  // Recency tiebreak — the more recent run wins.
  return (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0)
}

function classify(interp: RecallInterpretation, topK: ScoredCandidate[]): RecallMatchKind {
  if (topK.length === 0) return 'none'

  const nonTopicAnchors =
    (interp.provider ? 1 : 0) + (interp.workspaceId ? 1 : 0) + (interp.timeWindow ? 1 : 0)

  // Never confirm a single target from a topic/recency match alone.
  if (nonTopicAnchors === 0) return 'many'

  const top = topK[0]
  const hasTopicQuery = (interp.taskQuery || '').trim().length > 0
  const topicConfirmed = !hasTopicQuery || top.topicScore >= TOPIC_CONFIRM
  if (!topicConfirmed) return 'many'

  if (topK.length === 1) return 'one'

  const second = topK[1]
  if (top.matchScore >= SCORE_FLOOR && top.matchScore - second.matchScore >= SCORE_MARGIN) {
    return 'one'
  }
  return 'many'
}

function stripInternal(candidate: ScoredCandidate): RecallCandidate {
  const { topicScore: _topicScore, ...rest } = candidate
  return rest
}

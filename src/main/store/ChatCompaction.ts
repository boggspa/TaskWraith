/*
 * Persisted-chat compaction — Step 4 of the store-size work.
 *
 * Field data (two 20-25MB chats): 93% of the bytes were raw tool events,
 * and 19.5MB of one chat was base64 SCREENSHOTS riding rawResultEvent
 * (attached_window_capture frames up to 4.4MB each). Message content was
 * 0.1-0.3MB. Every save re-serialized all of it; every cold load re-parsed it.
 *
 * Policy, applied on save to runs OUTSIDE the protected set (the latest run
 * + anything still running — live debugging keeps full fidelity):
 *   - inline image blocks are downscaled IN PLACE to thumbnails — the block
 *     shape ({type:'image', mimeType, data}) is preserved, so the renderer's
 *     extractMcpImageBlocks keeps showing historical screenshots untouched;
 *   - text-only rawUseEvent/rawResultEvent are dropped (the parsed fields —
 *     parameters, resultSummary, diffSummary — already carry the transcript);
 *   - the legacy outputSummary/outputPreview duplicates of resultSummary go.
 *
 * Historical work is incremental by generation. Each no-longer-latest
 * terminal run is traversed until its bounded image backlog is exhausted, then
 * stamped with `CHAT_HISTORY_COMPACTION_GENERATION`; steady-state saves inspect
 * only the much smaller run list and never walk historical messages. Legacy
 * unattributed messages carry one chat-level stamp. Thumbnailing remains
 * amortized via `maxImagesPerPass`, and a run is not stamped while work remains.
 */

import type { ChatMessage, ChatRecord, ToolActivity } from './types'

export interface ImageThumbnailer {
  (dataB64: string, mimeType: string): { data: string; mimeType: string } | null
}

export interface ChatCompactionOptions {
  thumbnail?: ImageThumbnailer
  /** Image blocks larger than this (base64 chars) get thumbnailed. */
  minImageChars?: number
  /** Cap on thumbnail conversions per save (amortized migration). */
  maxImagesPerPass?: number
  /** Injectable clock (tests). */
  now?: number
}

/** Default thumbnailer — electron nativeImage, JPEG at viewable size. Lazy
 * + guarded so unit tests (and any non-electron context) degrade to "leave
 * the block alone" instead of crashing. */
function nativeImageThumbnailer(dataB64: string, _mimeType: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nativeImage } = require('electron')
    if (!nativeImage) return null
    const image = nativeImage.createFromBuffer(Buffer.from(dataB64, 'base64'))
    if (image.isEmpty()) return null
    const { width } = image.getSize()
    const resized = width > 1024 ? image.resize({ width: 1024 }) : image
    const jpeg = resized.toJPEG(65)
    if (!jpeg || jpeg.length === 0) return null
    // Only swap when it actually shrinks — tiny PNGs can beat JPEG.
    if (jpeg.length >= Buffer.from(dataB64, 'base64').length) return null
    return { data: jpeg.toString('base64'), mimeType: 'image/jpeg' }
  } catch {
    return null
  }
}

const DEFAULT_MIN_IMAGE_CHARS = 64 * 1024
const DEFAULT_MAX_IMAGES_PER_PASS = 8
export const CHAT_HISTORY_COMPACTION_GENERATION = 1

/** Runs whose activities keep FULL raw fidelity: the most recent run plus
 * anything not yet terminal. */
export function protectedRunIds(chat: ChatRecord): Set<string> {
  const ids = new Set<string>()
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  for (const run of runs) {
    if (!run || typeof run.runId !== 'string') continue
    const status = String(run.status ?? '')
    if (status === 'running' || status === 'pending' || status === '') ids.add(run.runId)
  }
  const last = runs[runs.length - 1]
  if (last && typeof last.runId === 'string') ids.add(last.runId)
  return ids
}

interface PassBudget {
  imagesLeft: number
}

function isImageBlock(item: unknown): item is Record<string, unknown> {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  const record = item as Record<string, unknown>
  return (
    record.type === 'image' &&
    typeof record.data === 'string' &&
    typeof (record.mimeType ?? record.mime_type) === 'string'
  )
}

/** Thumbnail every oversized image block inside an MCP-style content array,
 * returning a new array (or null when nothing changed). */
function compactContentArray(
  content: unknown[],
  thumbnail: ImageThumbnailer,
  minImageChars: number,
  budget: PassBudget
): { content: unknown[]; changed: boolean; sawImage: boolean; pendingImage: boolean } {
  let changed = false
  let sawImage = false
  let pendingImage = false
  const next = content.map((item) => {
    if (!isImageBlock(item)) return item
    sawImage = true
    const record = item as Record<string, unknown>
    if (record.compacted === true) return item
    const data = record.data as string
    if (data.length < minImageChars) return item
    if (budget.imagesLeft <= 0) {
      pendingImage = true
      return item
    }
    budget.imagesLeft -= 1
    const mime = String(record.mimeType ?? record.mime_type)
    const shrunk = thumbnail(data, mime)
    changed = true
    if (!shrunk) {
      // Unprocessable (odd format, no electron) — mark so we never retry.
      return { ...record, compacted: true }
    }
    return { ...record, data: shrunk.data, mimeType: shrunk.mimeType, compacted: true }
  })
  return { content: next, changed, sawImage, pendingImage }
}

/** Compact one raw result event: thumbnail images where the envelope carries
 * them; report whether ANY image exists (image-bearing events are kept,
 * text-only ones are dropped by the caller). Handles both object envelopes
 * and JSON-stringified ones (re-stored parsed — the renderer accepts both). */
function compactRawResultEvent(
  raw: unknown,
  thumbnail: ImageThumbnailer,
  minImageChars: number,
  budget: PassBudget
): { value: unknown; sawImage: boolean; changed: boolean; pendingImage: boolean } {
  let parsed: unknown = raw
  let reparsed = false
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed)
        reparsed = true
      } catch {
        return { value: raw, sawImage: false, changed: false, pendingImage: false }
      }
    } else {
      return { value: raw, sawImage: false, changed: false, pendingImage: false }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { value: raw, sawImage: false, changed: false, pendingImage: false }
  }

  let sawImage = false
  let changed = reparsed
  let pendingImage = false

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const result = compactContentArray(node, thumbnail, minImageChars, budget)
      sawImage = sawImage || result.sawImage
      changed = changed || result.changed
      pendingImage = pendingImage || result.pendingImage
      // Same node back when nothing changed — steady-state saves must
      // reach the identity no-op so the whole chat keeps its reference.
      return result.changed ? result.content : node
    }
    if (!node || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    let out: Record<string, unknown> | null = null
    for (const key of ['content', 'result', 'output']) {
      const child = record[key]
      // Nested envelopes are sometimes themselves JSON strings.
      if (typeof child === 'string' && (child.includes('"image"') || child.includes('image/'))) {
        const inner = compactRawResultEvent(child, thumbnail, minImageChars, budget)
        sawImage = sawImage || inner.sawImage
        pendingImage = pendingImage || inner.pendingImage
        if (inner.changed || inner.sawImage) {
          out = out ?? { ...record }
          out[key] = inner.value
          changed = changed || inner.changed
        }
        continue
      }
      if (child && typeof child === 'object') {
        const visited = visit(child)
        if (visited !== child) {
          out = out ?? { ...record }
          out[key] = visited
        }
      }
    }
    return out ?? record
  }

  const value = visit(parsed)
  return { value, sawImage, changed: changed || value !== parsed, pendingImage }
}

function compactActivity(
  activity: ToolActivity,
  thumbnail: ImageThumbnailer,
  minImageChars: number,
  budget: PassBudget
): { activity: ToolActivity; pendingImage: boolean } {
  let next: ToolActivity | null = null
  let pendingImage = false
  const ensure = (): ToolActivity => {
    if (!next) next = { ...activity }
    return next
  }

  if (activity.rawResultEvent !== undefined) {
    const result = compactRawResultEvent(activity.rawResultEvent, thumbnail, minImageChars, budget)
    pendingImage = result.pendingImage
    if (result.sawImage) {
      if (result.changed) ensure().rawResultEvent = result.value
    } else {
      // Text-only raw result — the parsed fields already carry the story.
      delete ensure().rawResultEvent
    }
  }
  if (activity.rawUseEvent !== undefined) {
    delete ensure().rawUseEvent
  }
  // Legacy triplication: resultSummary/outputPreview/outputSummary held the
  // same 500-char string three times on every activity.
  if (
    activity.outputSummary !== undefined &&
    (activity.outputSummary === activity.resultSummary ||
      activity.outputSummary === activity.outputPreview)
  ) {
    delete ensure().outputSummary
  }
  if (activity.outputPreview !== undefined && activity.outputPreview === activity.resultSummary) {
    delete ensure().outputPreview
  }
  return { activity: next ?? activity, pendingImage }
}

/** Compact a chat record for persistence. Returns the same reference when
 * nothing needed compacting (the common steady-state). */
export function compactChatForPersist(
  chat: ChatRecord,
  options: ChatCompactionOptions = {}
): ChatRecord {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  // No run bookkeeping at all (legacy/synthetic chats): nothing is safely
  // "historical", keep everything.
  if (runs.length === 0) return chat

  const thumbnail = options.thumbnail ?? nativeImageThumbnailer
  const minImageChars = options.minImageChars ?? DEFAULT_MIN_IMAGE_CHARS
  const budget: PassBudget = {
    imagesLeft: options.maxImagesPerPass ?? DEFAULT_MAX_IMAGES_PER_PASS
  }
  const protectedIds = protectedRunIds(chat)
  const eligibleRunIds = new Set<string>()
  for (const run of runs) {
    if (
      run?.runId &&
      !protectedIds.has(run.runId) &&
      run.historyCompactionGeneration !== CHAT_HISTORY_COMPACTION_GENERATION
    ) {
      eligibleRunIds.add(run.runId)
    }
  }
  const compactUnattributed =
    chat.unattributedHistoryCompactionGeneration !== CHAT_HISTORY_COMPACTION_GENERATION
  // The decisive steady-state fast path: run bookkeeping is small, whereas
  // messages can contain tens of thousands of rows. Once every historical run
  // and the legacy unattributed tranche carry this generation, do not even
  // iterate the transcript.
  if (eligibleRunIds.size === 0 && !compactUnattributed) return chat

  // Legacy chats stamped no runId on tool messages (pre-T36), so run
  // membership can't protect them — but TIME can: anything older than the
  // latest run's start is definitively a previous session. Without run
  // timing, fall back to a conservative week.
  const now = options.now ?? Date.now()
  const latestRunStart = Date.parse(String(runs[runs.length - 1]?.startedAt ?? ''))
  const unattributedCutoff = Number.isFinite(latestRunStart)
    ? latestRunStart
    : now - 7 * 24 * 60 * 60 * 1000

  const unattributedIsProtected = (message: ChatMessage): boolean => {
    const ts = Date.parse(String(message.timestamp ?? ''))
    if (!Number.isFinite(ts)) return true // unknowable → keep
    return ts >= unattributedCutoff
  }

  let changedAny = false
  const incompleteRunIds = new Set<string>()
  let unattributedIncomplete = false
  const nextMessages = messages.map((message: ChatMessage) => {
    const activities = message.toolActivities
    if (!Array.isArray(activities) || activities.length === 0) return message
    const attributedRunId = message.runId
    if (attributedRunId) {
      if (!eligibleRunIds.has(attributedRunId)) return message
    } else if (!compactUnattributed || unattributedIsProtected(message)) {
      return message
    }
    let changed = false
    const nextActivities = activities.map((activity) => {
      const result = compactActivity(activity, thumbnail, minImageChars, budget)
      if (result.pendingImage) {
        if (attributedRunId) incompleteRunIds.add(attributedRunId)
        else unattributedIncomplete = true
      }
      if (result.activity !== activity) changed = true
      return result.activity
    })
    if (!changed) return message
    changedAny = true
    return { ...message, toolActivities: nextActivities }
  })

  let runsChanged = false
  const nextRuns = runs.map((run) => {
    if (!eligibleRunIds.has(run.runId) || incompleteRunIds.has(run.runId)) return run
    runsChanged = true
    return { ...run, historyCompactionGeneration: CHAT_HISTORY_COMPACTION_GENERATION }
  })
  const stampUnattributed = compactUnattributed && !unattributedIncomplete
  if (!changedAny && !runsChanged && !stampUnattributed) return chat
  return {
    ...chat,
    messages: changedAny ? nextMessages : messages,
    runs: runsChanged ? nextRuns : runs,
    ...(stampUnattributed
      ? { unattributedHistoryCompactionGeneration: CHAT_HISTORY_COMPACTION_GENERATION }
      : {})
  }
}

/**
 * Authoritative seat-change transcript row — shared vocabulary + coalescing
 * (owner spec 2026-08-05). Lives in shared because BOTH processes need it:
 * main's EnsembleOrchestrator coalesces and persists the rows; the renderer's
 * SeatChangeRow needs the window constant to tell a living (still-rolling)
 * row from a settled tombstone. A renderer value-import from main is the
 * cross-process edge `guard:architecture` forbids.
 *
 * Coalescing: rapid roster adjustments to the SAME participant within the
 * window collapse into one living row — the stale row is removed, and the
 * fresh row lands at the newest transcript position carrying the ORIGINAL
 * before-state (so the collapsed row's expansion shows what the seat was
 * before the whole flurry, and a remount rolls the full journey once). The
 * window slides from the LATEST adjustment — a user flicking through configs
 * gets the full window from each tweak to keep tweaking.
 *
 * Tombstoning: anything outside the window is permanent history. A later
 * change to the same participant creates a NEW row; the old one is never
 * touched again. Row-count invariance per coalesced update (lose exactly one
 * row, gain exactly one row) is the transcript-stability contract — the
 * augmentation lanes rely on it.
 */
export const SEAT_CHANGE_COALESCE_WINDOW_MS = 120_000

/** One side of an authoritative seat change (before/after) — the fields the
 * transcript row renders with the composer's own chip vocabulary. */
export interface SeatChangeSeatState {
  provider: string
  model: string
  /** Participant role at this side of the change — rendered right-aligned in
   * the provider accent so same-model panels stay tellable apart. */
  role?: string
  /** 1-based roster position, rendered as the "#N" prefix on the role (the
   * approval-modal @Role #N vocabulary). */
  seatNumber?: number
  reasoningEffort?: string
  /** Kimi's thinking toggle — a separate input from `reasoningEffort` that
   * produces the same chip suffix, so the seat cannot show it without this. */
  thinkingEnabled?: boolean
  permissionPresetId?: string
  /** Chat-level workspace grant count at emit time (the permission chip's
   * "N grants" suffix). */
  grantsCount?: number
  /**
   * Stage identity (scout / worker / reviewer / background), drawn as the glyph
   * beside the role name.
   *
   * Carried on the SEAT rather than resolved by each host because a seat change
   * can change it: without this the transcript row could show a participant
   * moved from Scout to Reviewer and render nothing at all to say so.
   */
  stageRole?: 'scout' | 'worker' | 'reviewer' | 'background'
  /**
   * Chat-level authority at emit time. Outranks `stageRole` for the glyph — a
   * Boss who is also a Scout reads as the Boss, matching the composer chips.
   */
  authority?: 'boss' | 'captain'
}

export interface SeatChangePayload {
  participantId: string
  /** Human seat label at emit time (role or provider). */
  label: string
  before: SeatChangeSeatState
  after: SeatChangeSeatState
  /** ISO timestamp of the LATEST coalesced adjustment. */
  appliedAt: string
  /**
   * The seat's goal/brief text moved in this change.
   *
   * A flag on the PAYLOAD rather than a field on either side, because the
   * brief is the one part of a seat that no chip renders: provider, model,
   * reasoning, tier, grants and role each have one, the brief has none. So a
   * brief-only edit produced a row whose two sides were character-for-
   * character identical — a change announcement with nothing changed in it.
   * The flag says a brief moved; it deliberately does not carry the text,
   * which is paragraphs against the row's one line.
   */
  briefUpdated?: boolean
}

/** Structural slice of ChatMessage the coalescer needs — keeps this module
 * free of main-process imports. */
export interface SeatChangeCarrierMessage {
  metadata?: {
    seatChange?: SeatChangePayload
  }
}

export interface SeatChangeCoalesceResult<T extends SeatChangeCarrierMessage> {
  /** Messages with the superseded in-window row removed (copied array either
   * way, matching the caller's spread-then-append idiom). */
  messages: T[]
  /** The payload to append: `before` inherited from the superseded row when
   * one coalesced, verbatim otherwise. */
  payload: SeatChangePayload
}

/**
 * Pure coalescing step: find the newest seat-change row for the same
 * participant, and — iff its latest adjustment is inside the sliding window —
 * remove it and inherit its `before`. Rows for other participants, rows
 * outside the window, and malformed rows are never touched.
 */
export function coalesceSeatChangeMessages<T extends SeatChangeCarrierMessage>(
  messages: readonly T[],
  next: SeatChangePayload,
  nowMs: number
): SeatChangeCoalesceResult<T> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]?.metadata?.seatChange
    if (!candidate || candidate.participantId !== next.participantId) continue
    const appliedAtMs = Date.parse(candidate.appliedAt ?? '')
    if (!Number.isFinite(appliedAtMs) || nowMs - appliedAtMs > SEAT_CHANGE_COALESCE_WINDOW_MS) {
      // Newest row for this participant is already a tombstone — stop looking.
      break
    }
    return {
      messages: [...messages.slice(0, index), ...messages.slice(index + 1)],
      payload: {
        ...next,
        before: candidate.before,
        // The coalesced row inherits the ORIGINAL before-state, so it describes
        // the whole flurry rather than its last step — and a brief edited in an
        // earlier tweak is still news when the latest one only moved the model.
        // Without this OR the note would blink out on the next unrelated tweak.
        ...(candidate.briefUpdated || next.briefUpdated ? { briefUpdated: true } : {})
      }
    }
  }
  return { messages: [...messages], payload: next }
}

/* ── Close-out table links ──────────────────────────────────────────
 * The round close-out table embeds one seat element per participant
 * instead of five plain-text columns. Markdown has no place to hang a
 * component, so the seat state travels in a custom link href that the
 * renderer intercepts (the same mechanism `ensemble-dm://` mentions
 * already use), and the link TEXT carries the full plain-text seat
 * description so TUI / iOS / copy-paste degrade to exactly the
 * information the culled columns used to show.
 *
 * Encoding the state in the persisted message content — rather than
 * resolving it live from the roster — is the point: a close-out is a
 * tombstone. Rounds that ran hours ago keep the seats they actually
 * ran with, even after later rounds rename roles or swap models.
 */
export const SEAT_CHANGE_LINK_PREFIX = 'ensemble-seat://'

export interface SeatChangeLink {
  participantId: string
  before: SeatChangeSeatState
  after: SeatChangeSeatState
}

/** After-side keys, and the `b`-prefixed before-side mirror. Short
 * because every close-out row carries one of these. */
const SEAT_LINK_KEYS = {
  provider: 'p',
  model: 'm',
  role: 'role',
  seatNumber: 'n',
  reasoningEffort: 'r',
  thinkingEnabled: 't',
  permissionPresetId: 'k',
  grantsCount: 'g',
  stageRole: 's',
  authority: 'a'
} as const

/**
 * `encodeURIComponent` deliberately leaves `!'()*` unescaped — and a bare
 * `)` inside a markdown link destination CLOSES the link, truncating the
 * href mid-query (an Ollama tag like `qwen3-coder:30b (q4_K_M)` is enough to
 * do it). Percent-encode those too; `decodeURIComponent` reverses all of it.
 */
function encodeLinkComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/** Hand-rolled rather than URLSearchParams: that class decodes `+` as a
 * space, which would silently corrupt any model id containing one. */
function encodeParams(params: Array<[string, string]>): string {
  return params
    .map(([key, value]) => `${encodeLinkComponent(key)}=${encodeLinkComponent(value)}`)
    .join('&')
}

function decodeParams(query: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    try {
      out.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1)))
    } catch {
      // A malformed escape drops that field rather than the whole row.
    }
  }
  return out
}

function seatParams(state: SeatChangeSeatState, prefix: string): Array<[string, string]> {
  const params: Array<[string, string]> = [
    [`${prefix}${SEAT_LINK_KEYS.provider}`, state.provider],
    [`${prefix}${SEAT_LINK_KEYS.model}`, state.model]
  ]
  if (state.role) params.push([`${prefix}${SEAT_LINK_KEYS.role}`, state.role])
  if (state.seatNumber) {
    params.push([`${prefix}${SEAT_LINK_KEYS.seatNumber}`, String(state.seatNumber)])
  }
  if (state.reasoningEffort) {
    params.push([`${prefix}${SEAT_LINK_KEYS.reasoningEffort}`, state.reasoningEffort])
  }
  if (state.thinkingEnabled !== undefined) {
    params.push([`${prefix}${SEAT_LINK_KEYS.thinkingEnabled}`, state.thinkingEnabled ? '1' : '0'])
  }
  if (state.permissionPresetId) {
    params.push([`${prefix}${SEAT_LINK_KEYS.permissionPresetId}`, state.permissionPresetId])
  }
  if (state.grantsCount !== undefined) {
    params.push([`${prefix}${SEAT_LINK_KEYS.grantsCount}`, String(state.grantsCount)])
  }
  // A new seat field that is not encoded here is silently dropped from every
  // close-out row — the table would keep rendering, just without the glyph.
  if (state.stageRole) params.push([`${prefix}${SEAT_LINK_KEYS.stageRole}`, state.stageRole])
  if (state.authority) params.push([`${prefix}${SEAT_LINK_KEYS.authority}`, state.authority])
  return params
}

function readSeat(params: Map<string, string>, prefix: string): SeatChangeSeatState | null {
  const provider = params.get(`${prefix}${SEAT_LINK_KEYS.provider}`)
  if (!provider) return null
  const seatNumber = Number(params.get(`${prefix}${SEAT_LINK_KEYS.seatNumber}`))
  const grantsCount = Number(params.get(`${prefix}${SEAT_LINK_KEYS.grantsCount}`))
  const role = params.get(`${prefix}${SEAT_LINK_KEYS.role}`)
  const reasoningEffort = params.get(`${prefix}${SEAT_LINK_KEYS.reasoningEffort}`)
  const permissionPresetId = params.get(`${prefix}${SEAT_LINK_KEYS.permissionPresetId}`)
  const thinkingEnabled = params.get(`${prefix}${SEAT_LINK_KEYS.thinkingEnabled}`)
  const stageRole = params.get(`${prefix}${SEAT_LINK_KEYS.stageRole}`)
  const authority = params.get(`${prefix}${SEAT_LINK_KEYS.authority}`)
  // Closed unions, validated on decode: this comes off persisted message
  // CONTENT, so an unknown value must drop rather than reach the icon resolver.
  const stage =
    stageRole === 'scout' || stageRole === 'worker' || stageRole === 'reviewer' ||
    stageRole === 'background'
      ? stageRole
      : undefined
  const auth = authority === 'boss' || authority === 'captain' ? authority : undefined
  return {
    provider,
    model: params.get(`${prefix}${SEAT_LINK_KEYS.model}`) || '',
    ...(role ? { role } : {}),
    ...(Number.isFinite(seatNumber) && seatNumber > 0 ? { seatNumber } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(thinkingEnabled === undefined ? {} : { thinkingEnabled: thinkingEnabled === '1' }),
    ...(permissionPresetId ? { permissionPresetId } : {}),
    ...(Number.isFinite(grantsCount) && grantsCount >= 0 ? { grantsCount } : {}),
    ...(stage ? { stageRole: stage } : {}),
    ...(auth ? { authority: auth } : {})
  }
}

/**
 * `ensemble-seat://<participantId>?<after fields>&<b-prefixed before
 * fields>`. The before side is omitted entirely when the seat never
 * changed, so an unchanged seat decodes to identical sides and the
 * element renders with nothing to roll.
 */
export function encodeSeatChangeLink(link: SeatChangeLink): string {
  const changed = JSON.stringify(link.before) !== JSON.stringify(link.after)
  const params = [...seatParams(link.after, ''), ...(changed ? seatParams(link.before, 'b') : [])]
  return `${SEAT_CHANGE_LINK_PREFIX}${encodeLinkComponent(link.participantId)}?${encodeParams(params)}`
}

export function decodeSeatChangeLink(href: string): SeatChangeLink | null {
  if (!href.startsWith(SEAT_CHANGE_LINK_PREFIX)) return null
  const rest = href.slice(SEAT_CHANGE_LINK_PREFIX.length)
  const queryStart = rest.indexOf('?')
  if (queryStart < 0) return null
  let participantId: string
  try {
    participantId = decodeURIComponent(rest.slice(0, queryStart))
  } catch {
    return null
  }
  const params = decodeParams(rest.slice(queryStart + 1))
  const after = readSeat(params, '')
  if (!participantId || !after) return null
  return { participantId, before: readSeat(params, 'b') || after, after }
}

/**
 * Which authority glyph a seat wears, if any.
 *
 * Shared so the composer chips, the seat-change row, the close-out table and
 * the transcript result cards cannot drift apart on a rule that is easy to get
 * subtly wrong: a Boss is never also shown as a Captain, and a BACKGROUND seat
 * wears neither — a background lane is not part of the round's command chain,
 * so decorating it with a crown would overstate what it does.
 */
export function resolveSeatAuthority(input: {
  participantId: string
  stageRole?: string | null
  bossmanParticipantId?: string | null
  captainParticipantIds?: readonly string[] | null
}): 'boss' | 'captain' | undefined {
  const id = (input.participantId || '').trim()
  if (!id || input.stageRole === 'background') return undefined
  const boss = (input.bossmanParticipantId || '').trim()
  if (boss && boss === id) return 'boss'
  const captains = input.captainParticipantIds || []
  return captains.some((candidate) => (candidate || '').trim() === id) ? 'captain' : undefined
}

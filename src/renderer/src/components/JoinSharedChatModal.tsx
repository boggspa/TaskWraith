import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownMessage } from './MarkdownMessage'
import { PillButton } from './PillButton'

/**
 * Collaborator-side "Join shared chat" flow (L5-2 / L6-2). Three steps:
 *   paste  → paste the host's invite JSON + a display name, dial in
 *   sas    → compare the 6-digit code with the host OUT OF BAND, then confirm
 *   viewing→ live read-only projection of the host's transcript (+ comment box)
 *
 * All transport/crypto lives in main (HumanCollaborationCollaboratorClient via
 * the human-collaboration-collaborator:* IPC); this is purely UI + orchestration.
 */
/** Matches `requireBoundedText`'s bound on the host side, so a collaborator
 *  never types text that is silently refused on arrival. */
const MAX_CONTRIBUTION_CHARS = 8000

type Step = 'paste' | 'connecting' | 'sas' | 'viewing'
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected'

export interface ParsedHumanCollaborationInvite {
  shareId: string
  chatId: string
  inviteToken: string
  mode: 'readOnly' | 'comments'
  relayUrl: string
  relayUrls: string[]
  roomId: string
  hostIdentityPubKeyB64?: string
}

/** A tool call as an external may see it — DERIVED scalars only, never a body.
 *  Mirrors `HumanShareProjectionToolRow`; kept as a local shape because this
 *  component may be talking to an older host that does not send it. */
interface ProjectionToolRow {
  name: string
  category?: 'task' | 'read' | 'write' | 'search' | 'shell' | 'unknown'
  failed?: boolean
  target?: string
  additions?: number
  deletions?: number
}

interface ProjectionRow {
  id: string
  role: 'host' | 'assistant' | 'collaborator' | 'placeholder'
  speaker: string
  preview: string
  truncated: boolean
  timestamp: string
  sequence?: number
  /** v2, additive. Absent on rows an older host produced — every branch on it
   *  must fall back to `preview`, which is the field every host populates. */
  kind?: 'message' | 'toolActivity' | 'system' | 'placeholder'
  tools?: ProjectionToolRow[]
  /** Which SEAT authored this — a model participant id, or a collaboratorId for
   *  an external. Compared against `youAre` to tell self from other. */
  authorSeatId?: string
  /** Index into the shared hue palette. An INDEX, never a CSS string: this
   *  value comes off the wire and lands in a class name, and a free-form string
   *  would be an injection surface. */
  colorIndex?: number
}

/** One seat in the panel, as an external may see it. */
interface ProjectionSeat {
  seatId: string
  kind: 'model' | 'external'
  label: string
  order: number
  colorIndex?: number
  present?: boolean
}
interface Projection {
  title: string
  mode: 'readOnly' | 'comments'
  /** P2b: the share's contribution preset (affordance only — main re-validates). */
  contributionPreset?: 'readOnly' | 'comments' | 'requestHostAction' | 'autoDraft' | 'directLimited'
  rows: ProjectionRow[]
  participants: Array<{ collaboratorId: string; displayName: string; status: string }>
  totalRows: number
  /** Which collaborator is receiving this projection. Without it nobody can
   *  tell their own words from anyone else's. */
  youAre?: string
  /** The effective panel, so the seat strip can be drawn. */
  roster?: ProjectionSeat[]
  /**
   * What became of the contributions THIS collaborator sent while the host has
   * review switched on. Viewer-scoped by main — never anybody else's — and
   * carries no body, because they wrote it.
   */
  yourPending?: Array<{
    entryId: string
    clientMessageId: string
    state: 'queued' | 'approved' | 'denied' | 'lapsed'
    enqueuedAt: number
    expiresAt: number
    resolvedAt?: number
    hostReason?: string
    lapseReason?: 'expired' | 'revoked' | 'shareEnded' | 'chatGone'
  }>
}

/**
 * Say what happened in the contributor's terms, not the store's.
 *
 * `approved` deliberately does NOT claim the message has been delivered —
 * approval releases it for the host's next turn, and telling someone it landed
 * when it has not is the one thing this notice must never do.
 */
function pendingStatusLabel(entry: {
  state: string
  hostReason?: string
  lapseReason?: string
}): string {
  if (entry.state === 'queued') return 'Waiting for the host to review'
  if (entry.state === 'approved') return 'Approved — it will appear on the host’s next turn'
  if (entry.state === 'denied') {
    return entry.hostReason ? `Declined — “${entry.hostReason}”` : 'Declined by the host'
  }
  if (entry.lapseReason === 'expired') return 'Expired before the host reviewed it'
  if (entry.lapseReason === 'shareEnded') return 'Not reviewed — the host stopped sharing'
  if (entry.lapseReason === 'revoked') return 'Not reviewed — your access was removed'
  return 'No longer pending'
}

/** Older rows paged in behind the live window, and the session they belong to. */
export interface OlderPageCache {
  sessionId: string
  rows: ProjectionRow[]
  hasMore: boolean
  oldestRowId?: string
}

/**
 * Fold one backwards page into the cache — the L-3 control, as a pure function
 * so it can be tested and mutated.
 *
 * The rule that matters: a page joins the cache ONLY when the session matches.
 * A page is client-held, so a host-side truncation cannot reach rows already on
 * this machine; what a truncation does is drop the room, forcing a re-handshake
 * that mints a new sessionId. Comparing it here means pre-truncation rows
 * cannot survive into the new session — they are discarded by construction
 * rather than by a caller remembering to clear them, and "erased" has to mean
 * erased everywhere it was served, not just at the source.
 */
export function mergeOlderPage(
  current: OlderPageCache | null,
  page: {
    sessionId: string
    rows: ProjectionRow[]
    hasMore: boolean
    oldestRowId?: string
    throttled?: boolean
  }
): OlderPageCache {
  // Session mismatch DROPS everything held. Never a merge, never a partial
  // carry-over of the rows that happen to look the same.
  const base = current && current.sessionId === page.sessionId ? current : null
  if (page.throttled) {
    // Refused for rate, not answered: no rows were read, so `hasMore` carries
    // no information about the thread. Keep the cursor and the affordance.
    return base ?? { sessionId: page.sessionId, rows: [], hasMore: true }
  }
  const seen = new Set(page.rows.map((row) => row.id))
  return {
    sessionId: page.sessionId,
    rows: [...page.rows, ...(base?.rows || []).filter((row) => !seen.has(row.id))],
    hasMore: page.hasMore,
    ...(page.oldestRowId ? { oldestRowId: page.oldestRowId } : {})
  }
}

export function bubbleClass(role: ProjectionRow['role'], isOwn: boolean): string {
  // Your own words read as YOUR bubbles; everyone else — the host, the models,
  // the other collaborator — reads as named transcript output. Without
  // `youAre` this distinction is unimplementable, which is why every
  // collaborator row used to look identical no matter who wrote it.
  if (isOwn) return 'message-bubble user join-projection-own'
  if (role === 'host') return 'message-bubble user'
  if (role === 'assistant') return 'message-bubble assistant'
  if (role === 'collaborator') return 'message-bubble system human-collaborator-comment'
  return 'message-bubble system join-projection-placeholder'
}

/**
 * Accent class for a seat.
 *
 * Keyed on the palette INDEX, never a colour name off the wire — the index is
 * the whole reason the projection carries a number here. An index with no rule
 * simply gets no accent, so a ninth hue added upstream degrades quietly instead
 * of injecting anything. Order mirrors CONTACT_COLOR_PALETTE.
 */
export function seatAccentClass(colorIndex?: number): string {
  return typeof colorIndex === 'number' && Number.isInteger(colorIndex) && colorIndex >= 0 && colorIndex < 8
    ? ` join-seat-color-${colorIndex}`
    : ''
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function decodeInvitePayload(value: string): string {
  const trimmed = value.trim()
  try {
    return decodeURIComponent(trimmed)
  } catch {
    // Fall through to base64url.
  }
  try {
    const padded = trimmed.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(trimmed.length / 4) * 4, '=')
    return atob(padded)
  } catch {
    return trimmed
  }
}

function parseInviteText(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Paste the invite the host shared with you.')
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    // Accept link-shaped invites too:
    // taskwraith://join-shared-chat?invite=<encoded-json-or-base64url-json>
    // https://.../join?invite=<encoded-json-or-base64url-json>
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new Error('That does not look like a valid invite. Paste the JSON or invite link the host copied.')
    }
    const hashParams = url.hash.startsWith('#') ? new URLSearchParams(url.hash.slice(1)) : null
    const encoded =
      url.searchParams.get('invite') ||
      url.searchParams.get('payload') ||
      hashParams?.get('invite') ||
      hashParams?.get('payload') ||
      (url.hash.length > 1 ? url.hash.slice(1) : '')
    if (!encoded) {
      throw new Error('That invite link is missing its invite payload.')
    }
    try {
      return JSON.parse(decodeInvitePayload(encoded)) as Record<string, unknown>
    } catch {
      throw new Error('That invite link contains an unreadable invite payload.')
    }
  }
}

export function parseHumanCollaborationInvite(raw: string): ParsedHumanCollaborationInvite {
  const invite = parseInviteText(raw)
  if (invite?.type !== 'taskwraith-human-collaboration-invite') {
    throw new Error('That JSON is not a TaskWraith collaboration invite.')
  }
  const shareId = asNonEmptyString(invite.shareId)
  const chatId = asNonEmptyString(invite.chatId)
  const inviteToken = asNonEmptyString(invite.inviteToken)
  const roomId = asNonEmptyString(invite.roomId)
  const relayUrls = Array.from(
    new Set(
      [
        ...(Array.isArray(invite.relayUrls) ? invite.relayUrls : []),
        invite.relayUrl
      ]
        .map(asNonEmptyString)
        .filter((url): url is string => Boolean(url))
    )
  )
  if (!shareId || !chatId || !inviteToken || !roomId) {
    throw new Error('This invite is missing required share information. Ask the host for a fresh invite.')
  }
  if (relayUrls.length === 0) {
    throw new Error('This invite has no connection info — the host needs remote access ON, then a fresh invite.')
  }
  return {
    shareId,
    chatId,
    inviteToken,
    mode: invite.mode === 'readOnly' ? 'readOnly' : 'comments',
    relayUrl: relayUrls[0],
    relayUrls,
    roomId,
    ...(typeof invite.hostIdentityPubKeyB64 === 'string' && invite.hostIdentityPubKeyB64.trim()
      ? { hostIdentityPubKeyB64: invite.hostIdentityPubKeyB64.trim() }
      : {})
  }
}

export function JoinSharedChatModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>('paste')
  const [inviteText, setInviteText] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sasCode, setSasCode] = useState('')
  const [mode, setMode] = useState<'readOnly' | 'comments'>('comments')
  const [projection, setProjection] = useState<Projection | null>(null)
  /**
   * Older rows paged in behind the live window — and the L-3 control.
   *
   * The cache CARRIES the session it belongs to. A host-side truncation cannot
   * reach rows already on this machine; what it does is drop the room, which
   * forces a re-handshake, which mints a new sessionId. Because every read and
   * every write below compares that id, pre-truncation rows cannot survive into
   * the new session — they are discarded structurally rather than by anyone
   * remembering to clear them. A cache that must be told to forget is a cache
   * that will one day keep rows somebody asked to have erased.
   */
  const [olderPages, setOlderPages] = useState<OlderPageCache | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [comment, setComment] = useState('')
  // A refusal is NOT a connection failure, so it gets its own slot rather than
  // riding `error` (which the status listener pairs with 'disconnected').
  const [contributionError, setContributionError] = useState<string | null>(null)
  // The text of contributions still awaiting a host verdict, by clientMessageId.
  // An append is a fire-and-forget notification — the host's refusal arrives
  // later, on its own frame — so the words have to be held somewhere until
  // then or there is nothing left to put back.
  const inFlightRef = useRef(new Map<string, string>())
  // P2b: whether the next contribution is a structured "request host action".
  const [sendAsActionRequest, setSendAsActionRequest] = useState(false)
  // Slice 5: whether a persisted, reconnectable previous session exists.
  const [lastSessionAvailable, setLastSessionAvailable] = useState(false)
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [busy, setBusy] = useState(false)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  // Slice 5: check for a reconnectable previous session whenever the modal opens.
  useEffect(() => {
    if (!open) return
    if (typeof window.api.humanCollaborationCollaboratorLastSession !== 'function') return
    void window.api
      .humanCollaborationCollaboratorLastSession()
      .then((result) => setLastSessionAvailable(Boolean(result?.available)))
      .catch(() => setLastSessionAvailable(false))
  }, [open])

  // Live projection + status while the modal is open.
  useEffect(() => {
    if (!open) return
    const off = window.api.onHumanCollaborationCollaboratorProjection?.((payload) => {
      const next = payload.projection as Projection
      setProjection(next)
      // A projection from a DIFFERENT session means the old one is gone — a
      // revoke, a truncation, any re-handshake. Whatever we paged in belonged
      // to that session and does not carry over.
      setOlderPages((current) =>
        current && current.sessionId !== payload.sessionId ? null : current
      )
      // The host can flip the share's rules mid-session; without this the
      // composer keeps the stale mode until the next reconnect (main still
      // re-validates, so this is affordance-honesty, not enforcement).
      if (next?.mode === 'readOnly' || next?.mode === 'comments') setMode(next.mode)
    })
    const offPage = window.api.onHumanCollaborationCollaboratorOlderPage?.((page) => {
      setLoadingOlder(false)
      setOlderPages((current) =>
        mergeOlderPage(current, {
          ...page,
          rows: (page.rows as ProjectionRow[]) || []
        })
      )
    })
    const offStatus = window.api.onHumanCollaborationCollaboratorStatus?.((payload) => {
      if (payload.connected === true) setConnectionState('connected')
      else if (payload.connected === false) setConnectionState('disconnected')
      if (payload.error) {
        setError(payload.error)
        setConnectionState('disconnected')
      }
      const rejected = payload.contributionRejected
      if (rejected) {
        setContributionError(rejected.message)
        // Give them their words back. Only if the box is empty — they may have
        // started typing something else while waiting, and clobbering that
        // would be a second, worse version of the same bug.
        const held = rejected.clientMessageId
          ? inFlightRef.current.get(rejected.clientMessageId)
          : undefined
        if (held) {
          setComment((current) => (current.trim() ? current : held))
          inFlightRef.current.delete(rejected.clientMessageId as string)
        }
      }
    })
    return () => {
      off?.()
      offPage?.()
      offStatus?.()
    }
  }, [open])

  // Reset everything when the modal closes.
  useEffect(() => {
    if (open) return
    setStep('paste')
    setInviteText('')
    setDisplayName('')
    setError(null)
    setConnectionState('idle')
    setSasCode('')
    setProjection(null)
    setOlderPages(null)
    setLoadingOlder(false)
    setComment('')
    setContributionError(null)
    inFlightRef.current.clear()
    setBusy(false)
  }, [open])

  // Keep the projection pinned to the latest row.
  useEffect(() => {
    if (step === 'viewing') rowsRef.current?.scrollTo({ top: rowsRef.current.scrollHeight })
  }, [projection, step])

  const leaveAndClose = useCallback(() => {
    void window.api.humanCollaborationCollaboratorLeave?.()
    onClose()
  }, [onClose])

  const requestLeave = useCallback(() => {
    if (step === 'viewing' || step === 'sas') {
      if (!window.confirm('Leave this People chat?')) return
    }
    leaveAndClose()
  }, [leaveAndClose, step])

  useEffect(() => {
    if (!open) return
    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null
    const focusTimer = window.setTimeout(() => {
      const el = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
      )
      el?.focus()
    }, 0)
    return () => {
      window.clearTimeout(focusTimer)
      const last = lastFocusedRef.current
      if (last && typeof last.focus === 'function') {
        try {
          last.focus()
        } catch {
          // element may be gone; ignore
        }
      }
    }
  }, [open, step])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (busy) return
        event.preventDefault()
        if (step === 'paste' || step === 'connecting' || step === 'sas') {
          leaveAndClose()
        } else if (step === 'viewing') {
          requestLeave()
        }
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (active && !root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, leaveAndClose, open, requestLeave, step])

  const handleJoin = useCallback(async () => {
    setError(null)
    let invite: ParsedHumanCollaborationInvite
    try {
      invite = parseHumanCollaborationInvite(inviteText)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That does not look like a valid invite.')
      setConnectionState('disconnected')
      return
    }
    setBusy(true)
    setConnectionState('connecting')
    setStep('connecting')
    try {
      const res = await window.api.humanCollaborationCollaboratorJoin({
        shareId: invite.shareId,
        chatId: invite.chatId,
        inviteToken: invite.inviteToken,
        displayName: displayName.trim() || 'External',
        mode: invite.mode,
        relayUrl: invite.relayUrl,
        relayUrls: invite.relayUrls,
        roomId: invite.roomId,
        hostIdentityPubKeyB64: invite.hostIdentityPubKeyB64
      })
      setSasCode(res.confirmCode)
      setMode(res.mode)
      setStep('sas')
      setConnectionState('connecting')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect to the People chat.')
      setConnectionState('disconnected')
      void window.api.humanCollaborationCollaboratorLeave?.()
      setStep('paste')
    } finally {
      setBusy(false)
    }
  }, [inviteText, displayName])

  const handleSasMatch = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await window.api.humanCollaborationCollaboratorConfirm()
      setStep('viewing')
      setConnectionState('connected')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the session.')
      setConnectionState('disconnected')
    } finally {
      setBusy(false)
    }
  }, [])

  const connectionLabel =
    connectionState === 'connected'
      ? 'Connected'
      : connectionState === 'connecting'
        ? 'Connecting…'
        : connectionState === 'disconnected'
          ? 'Disconnected'
          : 'Not connected'

  const connectionClassName =
    connectionState === 'connected'
      ? 'join-connection-status is-connected'
      : connectionState === 'disconnected'
        ? 'join-connection-status is-disconnected'
        : connectionState === 'connecting'
          ? 'join-connection-status is-connecting'
          : 'join-connection-status'

  // P2b affordance: the projection advertises the share's contribution preset;
  // action requests exist only under requestHostAction / autoDraft rules. The
  // host's main process re-validates every contribution regardless.
  const actionRequestsAvailable =
    projection?.contributionPreset === 'requestHostAction' ||
    projection?.contributionPreset === 'autoDraft'

  // Slice 5: pinned-identity reconnect — no fresh invite, no SAS re-compare
  // (main verifies the pinned host key + fresh transcript signatures).
  const handleReconnect = useCallback(async () => {
    if (typeof window.api.humanCollaborationCollaboratorReconnect !== 'function') return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.humanCollaborationCollaboratorReconnect()
      setMode(result.mode === 'readOnly' ? 'readOnly' : 'comments')
      setConnectionState('connected')
      setStep('viewing')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reconnect.')
      setConnectionState('disconnected')
    } finally {
      setBusy(false)
    }
  }, [])

  // The rows the reader actually sees: paged-in history above the live window.
  // Deduped preferring the LIVE row — redaction runs per build from the current
  // record, so if a row appears in both, the live copy is the freshly-redacted
  // one and a cached copy must never win.
  const visibleRows = ((): ProjectionRow[] => {
    const live = projection?.rows || []
    if (!olderPages?.rows.length) return live
    const liveIds = new Set(live.map((row) => row.id))
    return [...olderPages.rows.filter((row) => !liveIds.has(row.id)), ...live]
  })()

  const oldestCursor = olderPages?.oldestRowId ?? projection?.rows[0]?.id
  // With a cache, trust what the last page said. Without one, fall back to the
  // count — which is already floored to the share's lifetime, so it never
  // advertises history the collaborator is deliberately not being given.
  const canLoadOlder = olderPages
    ? olderPages.hasMore
    : Boolean(projection && projection.totalRows > projection.rows.length)

  const handleLoadOlder = useCallback(() => {
    if (loadingOlder) return
    if (typeof window.api.humanCollaborationCollaboratorLoadOlder !== 'function') return
    setLoadingOlder(true)
    void window.api
      .humanCollaborationCollaboratorLoadOlder(
        oldestCursor ? { beforeRowId: oldestCursor } : {}
      )
      .catch(() => setLoadingOlder(false))
  }, [loadingOlder, oldestCursor])

  // The page rides an event, not a reply, so a dropped frame would otherwise
  // leave the control spinning forever with no way back.
  useEffect(() => {
    if (!loadingOlder) return
    const timer = window.setTimeout(() => setLoadingOlder(false), 8000)
    return () => window.clearTimeout(timer)
  }, [loadingOlder])

  const handleSendComment = useCallback(async () => {
    const text = comment.trim()
    if (!text) return
    const clientMessageId = crypto.randomUUID()
    setContributionError(null)
    try {
      await window.api.humanCollaborationCollaboratorAppendComment({
        content: text,
        clientMessageId,
        // P2b: send as a structured host-action request only when the share's
        // rules allow it AND the collaborator ticked the box. Main re-validates.
        ...(sendAsActionRequest && actionRequestsAvailable
          ? { intent: 'requestHostAction' as const }
          : {})
      })
      // Cleared only after the send resolves — and held, because resolving
      // means the frame left this machine, NOT that the host accepted it. The
      // verdict arrives later on its own frame; until then these are the only
      // copy of the words.
      inFlightRef.current.set(clientMessageId, text)
      setComment('')
    } catch (e) {
      // Left in the box on purpose. Clearing first meant a 9 KB paste, or any
      // second message sent inside the 750 ms rate limit, was destroyed and
      // reported as sent.
      setError(e instanceof Error ? e.message : 'Could not send the comment.')
    }
  }, [comment, sendAsActionRequest, actionRequestsAvailable])

  if (!open) return null

  const backdropDismissible = step === 'paste' || step === 'connecting'

  return createPortal(
    <div
      className="creative-approval-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (backdropDismissible && !busy) leaveAndClose()
      }}
    >
      <div
        ref={dialogRef}
        className="creative-approval-modal join-shared-chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Join a People chat"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="creative-approval-modal-eyebrow">Collaborate · People</div>

        {step === 'paste' || step === 'connecting' ? (
          <>
            <h2 className="creative-approval-modal-title">Join a People chat</h2>
            <div className={connectionClassName}>Connection: {connectionLabel}</div>
            <p className="creative-approval-modal-description">
              Paste the invite the host shared with you, then verify the 6-digit code together.
            </p>
            {lastSessionAvailable && (
              /* Slice 5: pinned-identity reconnect to the previous shared chat —
               * no new invite, no code re-compare (identity was verified once). */
              <div className="join-reconnect-row">
                <PillButton
                  size="compact"
                  className="join-reconnect-btn"
                  onClick={() => void handleReconnect()}
                  disabled={busy || step === 'connecting'}
                >
                  Reconnect to your last People chat
                </PillButton>
              </div>
            )}
            <label className="join-field-label" htmlFor="join-shared-chat-display-name">
              Your name (shown to the host)
            </label>
            <input
              id="join-shared-chat-display-name"
              className="join-text-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Olly"
              maxLength={80}
            />
            <label className="join-field-label" htmlFor="join-shared-chat-invite">
              Invite
            </label>
            <textarea
              id="join-shared-chat-invite"
              className="join-invite-textarea"
              value={inviteText}
              onChange={(e) => setInviteText(e.target.value)}
              placeholder="Paste the invite JSON here…"
              rows={5}
              spellCheck={false}
            />
            {error && <div className="join-error" role="alert">{error}</div>}
            <div className="join-actions">
              <PillButton size="compact" onClick={leaveAndClose}>
                Cancel
              </PillButton>
              <PillButton
                variant="primary"
                size="compact"
                onClick={handleJoin}
                disabled={busy || step === 'connecting' || !inviteText.trim()}
              >
                {step === 'connecting' ? 'Connecting…' : 'Connect'}
              </PillButton>
            </div>
          </>
        ) : null}

        {step === 'sas' ? (
          <>
            <h2 className="creative-approval-modal-title">Compare the code</h2>
            <div className={connectionClassName}>Connection: {connectionLabel}</div>
            <p className="creative-approval-modal-description">
              The host sees a 6-digit code too. Confirm out of band (call/message) that these match
              before joining — this is what stops an imposter in the middle.
            </p>
            <div className="join-sas-code" aria-label="Security code">{sasCode}</div>
            {error && <div className="join-error" role="alert">{error}</div>}
            <div className="join-actions">
              <PillButton size="compact" onClick={requestLeave} disabled={busy}>
                Codes don&apos;t match
              </PillButton>
              <PillButton variant="primary" size="compact" onClick={handleSasMatch} disabled={busy}>
                {busy ? 'Joining…' : 'Codes match — join'}
              </PillButton>
            </div>
          </>
        ) : null}

        {step === 'viewing' ? (
          <>
            <h2 className="creative-approval-modal-title">{projection?.title || 'People chat'}</h2>
            <div className={connectionClassName}>Connection: {connectionLabel}</div>
            {connectionState === 'disconnected' && (
              /* P2a presence clarity: offline is a STATE, not an error — say
               * plainly what still works and how to get back in. Slice 5 adds
               * pinned-identity reconnect (no fresh invite needed). */
              <div className="join-offline-hint" role="status">
                Connection lost — you&apos;re offline. You can keep reading what already loaded.
                <PillButton
                  size="compact"
                  className="join-reconnect-btn"
                  onClick={() => void handleReconnect()}
                  disabled={busy}
                >
                  Reconnect
                </PillButton>
              </div>
            )}
            <p className="creative-approval-modal-description">
              {mode === 'comments'
                ? 'You are following this chat live. You can leave comments — the host decides what, if anything, goes to the AI.'
                : 'You are following this chat live (view only). The host stays in control of the AI.'}
            </p>
            {projection?.roster && projection.roster.length > 0 && (
              /* The panel, so an external can see who is in the room and in
                 what order — the same information the host reads off the chip
                 strip. `seatDisabled` is deliberately absent from the wire:
                 the host's private mute state is not a collaborator's business. */
              <div className="join-seat-strip" aria-label="Panel">
                {projection.roster
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((seat) => {
                    const isYou = Boolean(projection.youAre && seat.seatId === projection.youAre)
                    return (
                      <div
                        key={seat.seatId}
                        className={`join-seat${seat.kind === 'external' ? ' is-external' : ''}${
                          isYou ? ' is-you' : ''
                        }${seat.present === false ? ' is-away' : ''}${seatAccentClass(seat.colorIndex)}`}
                        title={
                          seat.kind === 'external'
                            ? `${seat.label} — external collaborator`
                            : seat.label
                        }
                      >
                        <span className="join-seat-order">{seat.order}</span>
                        <span className="join-seat-label">{isYou ? 'You' : seat.label}</span>
                        {seat.kind === 'external' && !isYou && (
                          <span className="join-seat-badge">External</span>
                        )}
                      </div>
                    )
                  })}
              </div>
            )}
            <div className="join-projection-rows" ref={rowsRef}>
              {projection && canLoadOlder && (
                <div className="join-load-older-row">
                  <PillButton size="compact" onClick={handleLoadOlder} disabled={loadingOlder}>
                    {loadingOlder ? 'Loading…' : 'Load older messages'}
                  </PillButton>
                </div>
              )}
              {projection && !canLoadOlder && olderPages && (
                /* Said only when a page actually reported the end. An empty
                   page refused for rate never sets this, or paging would claim
                   the conversation began somewhere it did not. */
                <div className="join-projection-top" role="status">
                  You have reached the start of what this share covers.
                </div>
              )}
              {!projection || visibleRows.length === 0 ? (
                <div className="join-projection-empty">Waiting for the host’s transcript…</div>
              ) : (
                visibleRows.map((row) => {
                  const isOwn = Boolean(
                    projection.youAre && row.authorSeatId && row.authorSeatId === projection.youAre
                  )
                  return (
                  <div
                    key={row.id}
                    className={`join-projection-row${isOwn ? ' is-own' : ''}`}
                  >
                    <div className={`join-projection-speaker${seatAccentClass(row.colorIndex)}`}>
                      {isOwn ? 'You' : row.speaker}
                      {row.role === 'collaborator' && !isOwn && (
                        <span className="message-meta-model-badge human-collaborator-badge">External</span>
                      )}
                    </div>
                    <div className={bubbleClass(row.role, isOwn)}>
                      {row.kind === 'toolActivity' && row.tools?.length ? (
                        /* The structured form when the host speaks v2. `preview`
                         * carries the same facts as text and is what an older
                         * client (and the no-activities case) falls back to. */
                        <ul className="join-projection-tools">
                          {row.tools.map((tool, index) => (
                            <li
                              key={`${row.id}-tool-${index}`}
                              className={`join-projection-tool${tool.failed ? ' is-failed' : ''}`}
                            >
                              <span className="join-projection-tool-name">{tool.name}</span>
                              {tool.target && (
                                <span className="join-projection-tool-target">{tool.target}</span>
                              )}
                              {(typeof tool.additions === 'number' ||
                                typeof tool.deletions === 'number') && (
                                <span className="join-projection-tool-diff">
                                  +{tool.additions ?? 0}/−{tool.deletions ?? 0}
                                </span>
                              )}
                              {tool.failed && (
                                <span className="join-projection-tool-failed">failed</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <MarkdownMessage content={row.preview} />
                      )}
                      {row.truncated && <span className="join-projection-truncated"> …(truncated)</span>}
                    </div>
                  </div>
                  )
                })
              )}
            </div>
            {projection?.yourPending && projection.yourPending.length > 0 && (
              <div className="join-your-pending" aria-live="polite">
                <div className="join-your-pending-title">Your contributions</div>
                {projection.yourPending.map((entry) => (
                  <div className="join-your-pending-row" key={entry.entryId} data-state={entry.state}>
                    {pendingStatusLabel(entry)}
                  </div>
                ))}
              </div>
            )}
            {error && <div className="join-error" role="alert">{error}</div>}
            {contributionError && (
              <div className="join-error join-contribution-error" role="alert">
                {contributionError}
              </div>
            )}
            {mode === 'comments' && actionRequestsAvailable && (
              <label className="join-action-request-toggle">
                <input
                  type="checkbox"
                  checked={sendAsActionRequest}
                  onChange={(event) => setSendAsActionRequest(event.target.checked)}
                />
                <span>
                  Send as action request — goes to the host for review, not to the AI
                </span>
              </label>
            )}
            {mode === 'comments' ? (
              <div className="join-comment-row">
                <textarea
                  className="join-comment-input"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      void handleSendComment()
                    }
                  }}
                  placeholder="Leave a comment for the host to review…"
                  rows={2}
                  /* The host's own bound. Refusing here, where the text still
                     exists, beats refusing after it has been sent and cleared. */
                  maxLength={MAX_CONTRIBUTION_CHARS}
                />
                <PillButton
                  variant="primary"
                  size="compact"
                  onClick={handleSendComment}
                  disabled={!comment.trim()}
                >
                  Send
                </PillButton>
              </div>
            ) : null}
            <div className="join-actions">
              <PillButton size="compact" onClick={requestLeave}>
                Leave
              </PillButton>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  )
}

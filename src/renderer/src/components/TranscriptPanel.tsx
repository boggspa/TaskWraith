import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  DiffFileSummary,
  ProviderId
} from '../../../main/store/types'
import { ensembleRoundStatusClass } from '../lib/ensembleRoundStatusClass'
import { getChatProvider } from '../lib/chatScope'
import { getProviderLabel } from '../lib/providerLabels'
import { formatAssistantMessageLabel } from '../lib/assistantMessageLabel'
import { shortModelName } from '../lib/composerChipFormat'
import { deriveParticipantRenameContinuity } from '../lib/sessionActivityLedger'
import { shouldCollapseUserMessage, truncateUserMessagePreview } from '../lib/UserMessageCollapse'
import {
  buildEnsembleRoundSummaryRows,
  buildEscalationChips,
  buildGuestCompanionRamRow,
  buildRunCompleteSummaryRows,
  resolveGuestCompanionRuns
} from '../lib/runCompleteSummary'
import { decideMeasurePass, MAX_MEASURE_REWRITE_PASSES } from '../lib/transcriptMeasureConvergence'
import { deriveQueuedLifecycleProjection } from '../lib/queuedMessageRows'
import {
  TRANSCRIPT_VIRTUALIZATION_ENABLED,
  DEFAULT_OVERSCAN_PX,
  projectRows,
  selectWindow,
  findScrollAnchor,
  sumHeights,
  getRowHeight,
  measurementKey,
  widthBucket,
  type VirtualRow,
  type VirtualWindow
} from '../lib/TranscriptVirtualWindow'
import type { PlanChoiceState } from '../lib/planModeChoice'
import type { DisplayCurrency } from '../lib/formatCost'
import type { RendererProviderRates } from '../lib/providerRateEstimate'
import { shouldSuppressRunCompleteSummary, type RunCompleteNotice } from '../lib/runCompleteNotice'
import { EMPTY_CHAT_MESSAGES } from '../lib/stableEmpties'
import { groupAdjacentToolMessages } from '../lib/transcriptToolMessageGrouping'
import { ActivityStack } from './ActivityStack'
import { AgentQuestionCard, type AgentQuestionState } from './AgentQuestionCard'
import { isGuestParticipantReplyMessage } from './GuestParticipantReplyCardModel'
import { SubThreadDelegationCard } from './SubThreadDelegationCard'
import { isSubThreadDelegationMessage } from './SubThreadDelegationCardModel'
import { SubThreadReturnCard } from './SubThreadReturnCard'
import { isSubThreadReturnMessage, subThreadReturnBody } from './SubThreadReturnCardModel'
import { ParticipantHealthCard } from './ParticipantHealthCard'
import { ProviderRunFailureCard } from './ProviderRunFailureCard'
import { MarkdownMessage } from './MarkdownMessage'
import { RevealingMarkdownMessage } from './RevealingMarkdownMessage'
import { ProposedPlanCard } from './ProposedPlanCard'
import type { ProposedPlanState } from '../lib/proposedPlan'
import { MessageActionsChip } from './MessageActionsChip'
import {
  TranscriptMessageContextMenu,
  type TranscriptMessageContextMenuSelection
} from './TranscriptMessageContextMenu'
import { ChatMessageMediaStrip, collectMessageMediaRefs, type ChatMediaRef } from './ChatMediaPanel'
import { collectInlineImageRefIds } from '../lib/resolveMarkdownImageRef'
import { FileTypeIcon } from './FileTypeIcon'
import { RunCard } from './RunCard'
import { ThinkingIndicator } from './AppChromeSymbols'
import {
  humanCollaboratorMetadata,
  isHumanCollaboratorComment
} from '../../../main/collaboration/HumanCollaboratorMessages'

export type TranscriptPanelProps = {
  scrollRef: React.RefObject<HTMLDivElement | null>
  /**
   * Ref pinned to the SINGLE inner content div (`.transcript-inner`)
   * inside the scroll container. The App-level scroll effect attaches
   * one `ResizeObserver` to this node so ANY late-mount layout growth
   * (CodeMirror code blocks, `ActivityStack` rows revealing
   * tool-result output, shell-command stdout measuring, future
   * content types) triggers a coalesced rAF re-pin via the shared
   * `shouldRepinAfterTranscriptResize` gate. This is the
   * follow-up to a12f913 — that fix observed individual code blocks,
   * which missed Codex transcripts heavy with `Ran /bin/zsh -lc '...'`
   * activity rows. One observer on the content div catches them all
   * without per-component plumbing.
   */
  contentRef: React.RefObject<HTMLDivElement | null>
  endRef: React.RefObject<HTMLDivElement | null>
  messages: ChatMessage[]
  isWelcomeChat: boolean
  isThinking: boolean
  pendingPlanChoice: PlanChoiceState | null
  pendingProposedPlan: ProposedPlanState | null
  pendingAgentQuestions: readonly AgentQuestionState[]
  onAgentQuestionSubmit: (questionId: string, answer: string, isCustom: boolean) => void
  onAgentQuestionDismiss: (questionId: string) => void
  runCompleteNotice: RunCompleteNotice | null
  runCompleteDurationText: string | null
  currentChat: ChatRecord | null
  /**
   * True when the rendered chat has `scope === 'global'` (General/Global Chats).
   * Presentation-only: gates friendlier, less-technical rendering. Derived by
   * the host via `isGlobalChat(...)` so this component stays presentation-pure.
   */
  isGlobal?: boolean
  currentRun?: ChatRun | null
  currentWorkspacePath?: string
  currentProviderLabel: string
  /**
   * Provider id for the chat's primary speaker. Forwarded to the
   * assistant-message label so each message's `.message-meta` gets
   * a `provider-{name}` class hook — that lets the CSS colour the
   * "Codex" / "Claude" / "Gemini" / "Kimi" label in the provider's
   * theme tint without needing a separate JSX rewrite per provider.
   * Falls back to the chat-level provider when the message itself
   * doesn't carry an ensembleProvider in its metadata.
   */
  currentProvider: ProviderId
  /**
   * Slice B (1.0.3) — ensemble-aware "Thinking…" label. When an
   * ensemble round is mid-flight, this resolves to the active
   * participant's provider label (e.g. "Kimi" while Kimi is speaking);
   * otherwise it equals `currentProviderLabel`.
   */
  thinkingProviderLabel?: string
  /**
   * Companion provider id for {@link thinkingProviderLabel}. Drives
   * the `.message-meta.provider-{name}` class on the live thinking
   * indicator so the per-provider tint applies there too — same
   * treatment as completed assistant messages.
   */
  thinkingProvider?: ProviderId | null
  /**
   * Optional presentation-only provider class. Used for local Ollama
   * model brands that should look like Qwen / Google / OpenAI in the
   * transcript while remaining runtime provider `ollama`.
   */
  thinkingProviderClass?: string | null
  /**
   * Short model name (e.g. "5.5", "Opus 4.7", "K2.7 Code", "2.5 Pro") for
   * the in-flight ensemble participant. Rendered as a dim chip after
   * the "Codex Thinking…" label so the user knows *which configured
   * model* is producing the live output. Null for solo chats and
   * legacy ensembles without per-participant model data.
   */
  thinkingModelBadge?: string | null
  /**
   * Guest participant in-flight indicator. Guest runs happen in a linked
   * child chat, so the parent transcript needs its own pending row or the
   * user sees the main run summary before the guest reply lands.
   */
  guestThinkingProviderLabel?: string | null
  guestThinkingProvider?: ProviderId | null
  guestThinkingProviderClass?: string | null
  guestThinkingModelBadge?: string | null
  displayFileChangeSummaries: DiffFileSummary[]
  fileChangeSummaryText: string
  fileChangeShouldShowStats: boolean
  fileChangeDisplayAdds: number
  fileChangeDisplayDels: number
  /** Phase I3.2 — all chats, so the inline delegation card can look up
   * the live sub-thread record by id and reflect its status. */
  chats: ChatRecord[]
  /** Phase I3.2 — chat ids currently running on the run-queue so the
   * delegation card and the chat-header ticker can show live state. */
  runningChatIds: string[]
  onPlanChoiceSubmit: (messageId: string, option: string) => void
  onProposedPlanApprove: (messageId: string, planBody: string) => void
  onProposedPlanDismiss: (messageId: string) => void
  onProposedPlanCustom: (messageId: string, feedback: string) => void
  onOpenSubThread: (chatId: string) => void
  onOpenSubThreadInSidePanel?: (chatId: string, presentation?: 'split' | 'drawer') => void
  /** Phase K1B: when set, RunCard's "Inspect →" affordance enters Run
   * mode for the clicked run. Plumbed from App.tsx down. */
  onInspectRun?: (runId: string) => void
  onOpenSideChatFromRun?: (runId: string) => void
  /** Phase L3 slice 6 — `settings.compactDensity` plumbed through so
   * every `ActivityStack` inside the transcript renders in the same
   * density as the rest of the chat. */
  compactDensity: boolean
  /** Cursor-style live activity viewport toggle (`settings.liveActivityViewport`),
   * forwarded to every `ActivityStack` so in-flight thinking + tool activity
   * streams inside the masked auto-following region. */
  liveActivityViewport?: boolean
  /** Set of `appRunId`s whose run-queue job is still in `'queued'`
   * status. Used to hide the in-transcript "Queued (#N): …" system
   * card while the queued-messages above-row is showing the same
   * item live. Once the job dispatches (status leaves `'queued'`),
   * the appRunId drops from this set and the transcript card
   * reappears as the historical "this run was queued" record. */
  pendingQueuedAppRunIds?: Set<string>
  queuedRunStatusByAppRunId?: Partial<Record<string, string>>
  /**
   * 1.0.4-AQ4 — per-message actions on hover.
   *
   * `onCopyMessage(messageId, content)` copies the raw `msg.content`
   * string to the clipboard. 1.0.8: takes the message id too so the
   * shared copy-feedback hook can show a transient "Copied" on the
   * originating chip. Pure — does not mutate chat state.
   *
   * `onDeleteMessage(messageId)` removes the message from
   * `currentChat.messages`. The host applies a `confirm()` gate so
   * the destructive action requires intent. Both user and assistant
   * bubbles use the same handler; the host can differentiate by
   * checking the role itself if it ever wants to gate
   * differently (e.g. forbid deleting in-flight assistant runs).
   */
  onCopyMessage: (messageId: string, content: string) => void
  onDeleteMessage: (messageId: string) => void
  onTogglePinMessage?: (messageId: string) => void
  onPromoteCollaboratorComment?: (messageId: string) => void
  onMessageSelectionCandidate?: (message: ChatMessage) => void
  onOpenSideChatFromMessage?: (message: ChatMessage) => void
  sideChatSeedMessageId?: string | null
  jumpToMessageRequest?: { messageId: string; requestId: number } | null
  onPreviewImage: (ref: ChatMediaRef) => void
  /**
   * 1.0.8 — shared copy-to-clipboard feedback (see {@link useCopyFeedback}).
   * `copiedId` is the id currently showing its "Copied" confirmation;
   * `copy(id, text)` performs the write and arms the reset timer. Drives
   * the message chips (keyed on message id) and the latest-response copy
   * button (keyed on the latest assistant message id).
   */
  copiedId: string | null
  copy: (id: string, text: string) => void
  /**
   * 1.0.6-TV1 — when true, the transcript mounts only the visible window
   * + overscan (spacer-above / spacer-below) instead of the full message
   * list. Defaults to {@link TRANSCRIPT_VIRTUALIZATION_ENABLED} when
   * omitted; tests pass `true` to exercise the windowed path while the
   * global flag is still off. The non-virtualised branch is byte-for-byte
   * the original render and is deleted in TV3 after soak.
   */
  virtualize?: boolean
  /**
   * 1.0.6-TV1 — the App-level auto-follow ref. Read (never written) by
   * the windowing layer: when engaged the window pins to the bottom (so
   * the last row is always mounted and the existing snap behaves
   * identically), and the pre-paint anchor correction runs ONLY when it
   * is disengaged. A stable ref, so it never perturbs the memo.
   */
  autoFollowRef?: React.MutableRefObject<boolean>
  /**
   * 1.0.7 — display currency + conservative-overestimate bias (Settings →
   * General), threaded in so the ensemble run-complete card's Cost row routes
   * through `formatCost`. Defaults to USD / 0 when omitted.
   */
  currency?: DisplayCurrency
  currencyOverestimatePercent?: number
  showRunCompleteSummary?: boolean
  /**
   * 1.0.7 — per-provider rate table (USD per 1M tokens) from the
   * `providerRates:get` IPC. Used ONLY to project a clearly-badged
   * API-equivalent cost for subscription/credit seats that emit no
   * `cost_usd` (Codex / Grok / Cursor). Absent → no estimate.
   */
  providerRates?: RendererProviderRates
}

/** Stable empty heights array so the disabled path allocates nothing. */
const EMPTY_TRANSCRIPT_HEIGHTS: number[] = []
/** Stable empty rows array for the non-virtualised render path. */
const EMPTY_VIRTUAL_ROWS: VirtualRow[] = []
/** Stable empty expansion set so unopened tool rows share one reference. */
const EMPTY_ACTIVITY_EXPANSION: Set<string> = new Set()

/**
 * 1.0.6-TV1 — In-house transcript windowing glue (renderer side).
 *
 * Pure window math lives in `lib/TranscriptVirtualWindow.ts`; this hook
 * is the thin React/DOM layer that drives it inside `TranscriptPanel`.
 * It mounts only the visible band + overscan and collapses everything
 * else into a top/bottom spacer, so render work + DOM node count stop
 * scaling with total chat length.
 *
 * Coexistence with the hardened scroll machinery in `App` (`autoFollowRef`
 * + the four rAF re-pin sites + `lib/TranscriptScroll` predicates):
 *
 *   - The scroll container, its refs, `scrollHeight`, and every re-pin
 *     site are untouched. Spacers + mounted rows always sum to the real
 *     content height, so `scrollTop = scrollHeight` still means "true
 *     bottom" and every predicate keeps working byte-for-byte.
 *   - When auto-follow is engaged (streaming / pinned at the bottom) the
 *     window is forced to the END (effective scrollTop = totalHeight −
 *     viewport) so the last row is always mounted and `bottomSpacerPx`
 *     is 0. The bottom path behaves exactly as the non-virtualised
 *     transcript and the chat-switch snap never lands on a blank spacer.
 *   - The single imperative scroll write is the pre-paint anchor
 *     correction, gated to `!autoFollow`: it pins the row under the
 *     viewport top across height changes so content above the viewport
 *     mounting/measuring never makes the visible content jump.
 *
 * It attaches a deliberately READ-ONLY passive scroll listener to the
 * scroller (a documented, intentional deviation from "no second scroll
 * listener"): it never writes `scrollTop`, never touches `autoFollowRef`,
 * and schedules no re-pin — it only rAF-coalesces a window-recompute tick
 * and captures the scroll anchor, so it cannot perturb the auto-follow /
 * re-pin coalescing. Row growth is measured with a shared `ResizeObserver`
 * on individual blocks (NOT the scroll container — a block's rect is
 * independent of the ancestor `scrollTop`, per `TranscriptScroll.ts`), so
 * the historical observer-feedback loop cannot return.
 */
/* eslint-disable react-hooks/refs -- Virtualisation intentionally keeps scroll/measurement state in refs for synchronous window selection. */
function useTranscriptVirtualization(params: {
  enabled: boolean
  rows: VirtualRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  /**
   * 1.0.7 — the `.transcript-inner` element (capped at
   * --composer-content-max-width). Width is bucketed off THIS, not the scroll
   * container, so a scrollbar appear/disappear (which changes the scroller's
   * clientWidth but not the capped inner's) can't flip the width bucket and
   * invalidate the measurement cache. Falls back to the scroller when absent.
   */
  contentRef?: React.RefObject<HTMLDivElement | null>
  autoFollowRef?: React.MutableRefObject<boolean>
  compactDensity: boolean
  /**
   * 1.0.6-TV2 — row ids whose tool stack currently has something
   * expanded. Folded into the measurement-cache key (the geometry bit)
   * so a collapsed vs expanded row caches distinct heights, and into
   * the live height lookup so toggling re-flows the spacers.
   */
  expandedRowIds?: ReadonlySet<string>
}): {
  window: VirtualWindow
  blockRef: (el: HTMLDivElement | null) => void
  spacerBottomRef: React.RefObject<HTMLDivElement | null>
} {
  const { enabled, rows, scrollRef, contentRef, autoFollowRef, compactDensity, expandedRowIds } =
    params

  const measurementsRef = useRef<Map<string, number>>(new Map())
  const scrollTopRef = useRef(0)
  const viewportRef = useRef(0)
  const bucketRef = useRef(0)
  const heightsRef = useRef<number[]>(EMPTY_TRANSCRIPT_HEIGHTS)
  const rowsRef = useRef<VirtualRow[]>(rows)
  // The row the viewport is anchored to + the total height ABOVE it as of the
  // last layout pass, PLUS the sub-row offset of the viewport top within that
  // row. The pre-paint correction restores scrollTop ABSOLUTELY to
  // Σ(heights before anchor) + offsetWithin (never a relative += delta) so it
  // is self-correcting and cannot accumulate as rows above hydrate. The old
  // relative form sampled "height above" at scroll-time (estimates) vs
  // post-measure (measured), so the delta was structurally non-zero while rows
  // above were still hydrating — the scroll-up-bumps-down / scroll-down-jumps-up
  // fight. An absolute target lands the viewport exactly where the anchor row
  // stays fixed, whether rows above resolved taller or shorter than estimate.
  const anchorRef = useRef<{ rowId: string; aboveHeight: number; offsetWithin: number } | null>(
    null
  )
  const blockElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const spacerBottomRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const measureRafRef = useRef<number | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  // 1.0.7 — convergence guard for the pre-paint measurement effect. Counts
  // consecutive passes that only REWROTE existing measurement keys (no new
  // keys). A row whose measured height oscillates between two values for the
  // same key — seen mid-chat in Ensemble (concurrent participant streams +
  // scrollbar/sub-pixel reflow) — would otherwise bump setState on every
  // synchronous pass forever and trip React's nested-update limit, crashing
  // the transcript surface. `measureWarnedRef` makes the diagnostic one-shot
  // per oscillation episode. See lib/transcriptMeasureConvergence.ts.
  const measureRewritePassesRef = useRef(0)
  const measureWarnedRef = useRef(false)
  // 1.0.7 — set true immediately before the anchor correction writes
  // `scroller.scrollTop`, so the passive scroll listener can recognise that
  // scroll event as our OWN write and skip re-baselining the anchor / bumping.
  // Without this the programmatic write re-enters the listener → re-baseline
  // from a mid-convergence heights snapshot → non-zero delta → another write,
  // which is the async (~50ms) leg of the ensemble flicker loop.
  const anchorWriteRef = useRef(false)
  // 1.0.7 — true when the PREVIOUS pre-paint pass fully converged (no new key,
  // no rewrite). The Phase-1 anchor correction only runs when this is true, so
  // it never restores scrollTop while heights are still settling (which would
  // jitter the viewport every frame and evict the just-mounted big rows). It
  // waits for measurement to finish, then restores the anchor absolutely, once.
  const measureConvergedRef = useRef(true)
  // Flips true the first time the scroller reports a real scroll position
  // (the chat-switch snap-to-bottom counts). Before that, `scrollTopRef`
  // is still 0, so we force the bottom window to avoid flashing the top;
  // after it, the window tracks the actual scroll position so scroll-up
  // loads older rows.
  const hasScrolledRef = useRef(false)

  // Re-render signals. State (not refs) so a change forces a recompute;
  // the heavy work is gone (only the small window mounts) so a per-frame
  // recompute is cheap.
  const [scrollTick, setScrollTick] = useState(0)
  const [measureTick, setMeasureTick] = useState(0)
  const bumpScroll = useCallback(() => setScrollTick((t) => (t + 1) % 0x7fffffff), [])
  const bumpMeasure = useCallback(() => setMeasureTick((t) => (t + 1) % 0x7fffffff), [])

  // Slot heights (measured-or-estimated, gap folded in). Recomputed only
  // when the rows change or a measurement/bucket/density signal fires —
  // never on plain scroll, so scrolling stays allocation-light.
  const heights = useMemo(() => {
    if (!enabled) return EMPTY_TRANSCRIPT_HEIGHTS
    const m = measurementsRef.current
    const bucket = bucketRef.current
    return rows.map((row) => getRowHeight(row, m, bucket, expandedRowIds?.has(row.id) ?? false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rows, measureTick, expandedRowIds])
  heightsRef.current = heights
  rowsRef.current = rows

  // Window selection. Inline (not memoised) because it reads scroll refs;
  // it re-runs on every tick, which is cheap.
  //
  // Drive the window from the REAL browser scroll position. The App
  // scroll machinery keeps `scrollTop` pinned to the bottom while
  // auto-following / streaming, so reading the live position mounts the
  // bottom window in that case AND follows the user when they scroll up.
  // We must NOT force the bottom from the `autoFollow` flag: if it failed
  // to disengage (or re-engaged), the window stayed welded to the bottom
  // and scroll-up only revealed the empty top spacer — the reported bug.
  // The bottom is forced ONLY for the first frames after a chat loads,
  // before the snap-to-bottom has run and `scrollTopRef` still reads 0.
  const totalHeight = enabled ? sumHeights(heights, 0, heights.length) : 0
  const forceBottomOnLoad = Boolean(autoFollowRef?.current) && !hasScrolledRef.current
  const effectiveScrollTop = forceBottomOnLoad
    ? Math.max(0, totalHeight - viewportRef.current)
    : scrollTopRef.current
  // 1.0.7 — window selection from a STABLE heights snapshot. This is the core
  // fix for the ensemble virtualization oscillation. Previously the window was
  // selected from live `heights`, which recompute on every `measureTick` — so
  // the instant a mounted row reported its real (large) height, the window
  // re-selected a smaller span, dropped that very row, re-measured, and limit-
  // cycled (the ~50ms flicker that settled on the short System rows). The
  // mounted set must NOT be an input to the computation that re-picks it.
  //
  // `windowHeights` is refreshed on scroll/resize (`scrollTick`) and on row-set
  // / expansion changes, but is HELD across a pure measurement bump. Within a
  // frame the window is fixed; Phase-2 measures exactly that window's rows and
  // writes the cache; live `heights` still feed the spacers + anchor so total
  // height and the bottom-pin invariant stay exact. The next genuine scroll
  // then re-selects ONCE from now-measured heights and lands correctly. The
  // 900px overscan absorbs the estimate error during the single settle frame.
  // Standard virtualiser hysteresis: select on scroll, measure within the
  // selection, never let measurement re-trigger selection.
  const windowHeights = useMemo(
    () => heights,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, rows, expandedRowIds, scrollTick] // deliberately NOT measureTick
  )
  const virtualWindow: VirtualWindow = enabled
    ? selectWindow({
        scrollTop: effectiveScrollTop,
        viewportHeight: viewportRef.current,
        heights: windowHeights,
        overscanPx: DEFAULT_OVERSCAN_PX
      })
    : { startIndex: 0, endIndex: rows.length, topSpacerPx: 0, bottomSpacerPx: 0 }

  // Read-only passive scroll + resize listener: refresh metrics, capture
  // the anchor, and request a window recompute. Never writes scrollTop.
  useEffect(() => {
    if (!enabled) return
    const scroller = scrollRef.current
    if (!scroller) return
    const readMetricsInto = (el: HTMLDivElement): boolean => {
      scrollTopRef.current = el.scrollTop
      viewportRef.current = el.clientHeight
      // 1.0.7 — bucket width off the capped `.transcript-inner` (contentRef),
      // not the scroll container: a scrollbar appear/disappear changes the
      // scroller's clientWidth but not the inner's, so this can't flip the
      // bucket and invalidate the whole measurement cache. Fall back to the
      // scroller when contentRef hasn't mounted yet.
      const widthEl = contentRef?.current ?? el
      const nextBucket = widthBucket(widthEl.clientWidth)
      const bucketChanged = nextBucket !== bucketRef.current
      bucketRef.current = nextBucket
      return bucketChanged
    }
    readMetricsInto(scroller)
    bumpScroll()

    const refresh = (): void => {
      if (scrollRafRef.current !== null) return
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null
        const el = scrollRef.current
        if (!el) return
        // 1.0.7 — if this scroll event is the anchor correction's OWN
        // `scrollTop +=` write, re-read metrics but DON'T re-baseline the
        // anchor or bump. Re-baselining here from a mid-convergence heights
        // snapshot is what produced a fresh non-zero delta every pass → another
        // write → the async oscillation. Consuming the flag makes the anchor
        // correction one-shot: the baseline only moves on real user scrolls.
        if (anchorWriteRef.current) {
          anchorWriteRef.current = false
          readMetricsInto(el)
          return
        }
        // The scroller has reported a real position (incl. the
        // snap-to-bottom): from here the window tracks the live scrollTop.
        hasScrolledRef.current = true
        const bucketChanged = readMetricsInto(el)
        // Re-baseline the anchor at the new scroll position. Capturing the
        // height-above HERE (not in the layout effect) is what makes the
        // correction compose with scroll: a scroll-driven render then sees
        // a zero delta, so it never fights the user; only a genuine height
        // change above the anchor produces a non-zero nudge.
        const a = findScrollAnchor(scrollTopRef.current, heightsRef.current)
        const anchorRow = rowsRef.current[a.index]
        anchorRef.current = anchorRow
          ? {
              rowId: anchorRow.id,
              aboveHeight: sumHeights(heightsRef.current, 0, a.index),
              offsetWithin: a.offsetWithin
            }
          : null
        if (bucketChanged) bumpMeasure()
        bumpScroll()
      })
    }
    scroller.addEventListener('scroll', refresh, { passive: true })
    window.addEventListener('resize', refresh)
    return () => {
      scroller.removeEventListener('scroll', refresh)
      window.removeEventListener('resize', refresh)
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [enabled, scrollRef, bumpScroll, bumpMeasure])

  // Shared ResizeObserver on individual mounted blocks → re-measure on
  // async growth (CodeMirror, ActivityStack output reveal, image load).
  useEffect(() => {
    if (!enabled) return
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (measureRafRef.current !== null) return
      measureRafRef.current = requestAnimationFrame(() => {
        measureRafRef.current = null
        bumpMeasure()
      })
    })
    observerRef.current = ro
    for (const el of blockElsRef.current.values()) {
      if (el.isConnected) ro.observe(el)
    }
    return () => {
      ro.disconnect()
      observerRef.current = null
      if (measureRafRef.current !== null) {
        cancelAnimationFrame(measureRafRef.current)
        measureRafRef.current = null
      }
    }
  }, [enabled, bumpMeasure])

  // Density change alters --space-lg (the row gap baked into slot
  // heights), so every cached measurement is stale — clear + re-measure.
  useEffect(() => {
    if (!enabled) return
    measurementsRef.current.clear()
    const frame = window.requestAnimationFrame(() => bumpMeasure())
    return () => window.cancelAnimationFrame(frame)
  }, [enabled, compactDensity, bumpMeasure])

  // Pre-paint: anchor correction (Phase 1) + slot measurement (Phase 2).
  // No dependency array — runs after every commit; both phases are cheap
  // and converge (only fire `bumpMeasure` when a height actually moved).
  useLayoutEffect(() => {
    if (!enabled) return
    const scroller = scrollRef.current
    if (!scroller) return

    // Phase 1 — keep the anchored row visually fixed when rows ABOVE it change
    // height (estimate→measured, late-mount growth). ABSOLUTE restore: target
    // scrollTop = Σ(heights before anchor) + offsetWithin, recomputed from the
    // CURRENT heights every pass. Unlike the old relative `+= delta` (whose two
    // height samples came from different estimate-vs-measured snapshots and so
    // never zeroed while rows above hydrated — the scroll-up-bumps-down and
    // scroll-down-jumps-up fight), an absolute target is self-correcting and
    // cannot accumulate: it lands the viewport exactly where the anchor row
    // stays fixed regardless of whether rows above resolved taller or shorter.
    //
    // GATED on prior-pass convergence: while measurement is still settling we
    // leave scrollTop alone (a restore mid-settle would jitter the viewport and
    // evict the just-mounted big rows); once Phase 2 reports a converged pass we
    // restore ONCE from settled heights. Also gated on a real "not at the
    // bottom" DOM measure — with a 24px dead-band so scrollHeight growth near
    // the bottom can't flap the correction on/off — rather than the autoFollow
    // flag, so it runs whenever the user has scrolled up and is skipped at the
    // bottom where the App machinery owns scrollTop.
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    const atBottom = distanceFromBottom <= 24
    if (measureConvergedRef.current && !atBottom && anchorRef.current) {
      const anchor = anchorRef.current
      const idx = rowsRef.current.findIndex((r) => r.id === anchor.rowId)
      if (idx >= 0) {
        const aboveHeight = sumHeights(heightsRef.current, 0, idx)
        const target = Math.max(0, aboveHeight + anchor.offsetWithin)
        if (Math.abs(target - scroller.scrollTop) > 0.5) {
          // 1.0.7 — flag the programmatic write so the passive scroll listener
          // recognises the resulting scroll event as our own and skips the
          // re-baseline/bump (Fix 4), keeping the restore one-shot.
          anchorWriteRef.current = true
          scroller.scrollTop = target
        }
        anchor.aboveHeight = aboveHeight
      }
    }

    // Phase 2 — measure mounted slot heights via offsetTop deltas (which
    // include the row gap), keyed by `measurementKey`. Request one more
    // pass when something moved; converges once stable.
    const measurements = measurementsRef.current
    const bucket = bucketRef.current
    const mountedRows = rowsRef.current.slice(virtualWindow.startIndex, virtualWindow.endIndex)
    const spacerBottom = spacerBottomRef.current
    let sawNewKey = false
    let sawRewrite = false
    for (let i = 0; i < mountedRows.length; i++) {
      const row = mountedRows[i]
      // 1.0.7 — element + measurement maps key on `rowKey` (`${id}#${index}`),
      // NOT the bare message id. Historical/imported data can carry duplicate
      // message ids; keying on id alone collapsed those rows to one element +
      // one measurement slot, scrambling heights + order (the load/unload,
      // System-rows-pinned-to-top bug). `rowKey` is unique per list position.
      const el = blockElsRef.current.get(row.rowKey)
      if (!el || !el.isConnected) continue
      const nextEl =
        i + 1 < mountedRows.length
          ? blockElsRef.current.get(mountedRows[i + 1].rowKey)
          : spacerBottom
      const slot = nextEl && nextEl.isConnected ? nextEl.offsetTop - el.offsetTop : el.offsetHeight
      if (!(slot > 0)) continue
      const key = measurementKey(
        row.rowKey,
        row.contentVersion,
        bucket,
        expandedRowIds?.has(row.id) ?? false
      )
      const prev = measurements.get(key)
      if (prev === undefined) {
        measurements.set(key, slot)
        sawNewKey = true
      } else if (Math.abs(prev - slot) > 0.5) {
        measurements.set(key, slot)
        sawRewrite = true
      }
    }
    // 1.0.7 — gate the re-measure bump through the convergence guard. A new key
    // (genuine content/growth) always converges and resets the budget; a run of
    // rewrite-only passes (oscillation) is capped so it can't spin React's
    // nested-update limit and crash the transcript surface.
    const decision = decideMeasurePass({
      sawNewKey,
      sawRewrite,
      rewritePasses: measureRewritePassesRef.current,
      alreadyWarned: measureWarnedRef.current
    })
    measureRewritePassesRef.current = decision.nextRewritePasses
    measureWarnedRef.current = decision.nextAlreadyWarned
    // 1.0.7 — record whether THIS pass fully converged (nothing changed). The
    // next pre-paint pass's Phase-1 anchor restore reads this so it only fires
    // once heights have settled — never mid-measure.
    measureConvergedRef.current = !sawNewKey && !sawRewrite
    if (decision.shouldWarn) {
      console.warn(
        '[transcript] measurement did not converge after ' +
          `${MAX_MEASURE_REWRITE_PASSES} passes; freezing heights to avoid a render loop. ` +
          'A mounted row height is likely oscillating (concurrent streams / scrollbar reflow).'
      )
    }
    if (decision.bump) bumpMeasure()
  })

  const blockRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    // `data-vrow-id` carries the collision-proof `rowKey` (`${id}#${index}`),
    // so `blockElsRef` is keyed by rowKey — duplicate message ids can't share
    // an element entry.
    const rowKey = el.dataset.vrowId
    if (!rowKey) return
    blockElsRef.current.set(rowKey, el)
    observerRef.current?.observe(el)
  }, [])

  return { window: virtualWindow, blockRef, spacerBottomRef }
}
/* eslint-enable react-hooks/refs */

export const TranscriptPanel = memo(
  function TranscriptPanel({
    scrollRef,
    contentRef,
    endRef,
    messages,
    isWelcomeChat,
    isThinking,
    pendingPlanChoice,
    pendingAgentQuestions,
    onAgentQuestionSubmit,
    onAgentQuestionDismiss,
    runCompleteNotice,
    runCompleteDurationText,
    currentChat,
    currentRun,
    currentWorkspacePath,
    currentProviderLabel,
    currentProvider,
    thinkingProviderLabel,
    thinkingProvider,
    thinkingProviderClass,
    thinkingModelBadge,
    guestThinkingProviderLabel,
    guestThinkingProvider,
    guestThinkingProviderClass,
    guestThinkingModelBadge,
    displayFileChangeSummaries,
    fileChangeSummaryText,
    fileChangeShouldShowStats,
    fileChangeDisplayAdds,
    fileChangeDisplayDels,
    chats,
    runningChatIds,
    onPlanChoiceSubmit,
    onProposedPlanApprove,
    onProposedPlanDismiss,
    onProposedPlanCustom,
    onOpenSubThread,
    onOpenSubThreadInSidePanel,
    onInspectRun,
    onOpenSideChatFromRun,
    compactDensity,
    liveActivityViewport,
    pendingQueuedAppRunIds,
    queuedRunStatusByAppRunId,
    onCopyMessage,
    onDeleteMessage,
    onTogglePinMessage,
    onPromoteCollaboratorComment,
    onMessageSelectionCandidate,
    onOpenSideChatFromMessage,
    sideChatSeedMessageId,
    jumpToMessageRequest,
    onPreviewImage,
    copiedId,
    copy,
    virtualize,
    autoFollowRef,
    currency,
    currencyOverestimatePercent,
    showRunCompleteSummary,
    isGlobal,
    providerRates
  }: TranscriptPanelProps) {
    const visibleMessages = useMemo(() => {
      const source = isWelcomeChat ? EMPTY_CHAT_MESSAGES : messages
      const projected = deriveQueuedLifecycleProjection({
        messages: source,
        pendingQueuedAppRunIds,
        queuedRunStatusByAppRunId
      })
      // Dedup: when a queued-message system card's job is still in
      // the `queued` set, suppress the card here — the queued-
      // messages above-row is the live representation. Once the job
      // dispatches, the card resurfaces as a historical "this was
      // queued" record. Untagged messages always pass through.
      if (!pendingQueuedAppRunIds || pendingQueuedAppRunIds.size === 0) return projected
      return projected.filter((msg) => {
        if (msg.metadata?.kind !== 'queuedRunRequest') return true
        const appRunId = typeof msg.metadata?.appRunId === 'string' ? msg.metadata.appRunId : null
        if (!appRunId) return true
        return !pendingQueuedAppRunIds.has(appRunId)
      })
    }, [isWelcomeChat, messages, pendingQueuedAppRunIds, queuedRunStatusByAppRunId])
    const [messageContextMenu, setMessageContextMenu] =
      useState<TranscriptMessageContextMenuSelection | null>(null)
    const closeMessageContextMenu = useCallback(() => {
      setMessageContextMenu(null)
    }, [])
    const openMessageContextMenu = useCallback(
      (
        event: React.MouseEvent,
        message: ChatMessage,
        copyContent: string,
        label: string,
        options: {
          copySource?: TranscriptMessageContextMenuSelection['copySource']
          copyOnly?: boolean
        } = {}
      ): void => {
        event.preventDefault()
        event.stopPropagation()
        setMessageContextMenu({
          anchor: { x: event.clientX, y: event.clientY },
          message,
          copyContent,
          copySource: options.copySource || 'message-content',
          label,
          pinned: typeof message.metadata?.pinnedAt === 'number',
          copyOnly: options.copyOnly
        })
      },
      []
    )
    const activeMessageContextMenu = useMemo(() => {
      if (!messageContextMenu) return null
      const latestMessage =
        visibleMessages.find((message) => message.id === messageContextMenu.message.id) ||
        messageContextMenu.message
      const copyContent =
        messageContextMenu.copySource === 'subthread-return-body'
          ? subThreadReturnBody(latestMessage.content)
          : messageContextMenu.copySource === 'static'
            ? messageContextMenu.copyContent
            : latestMessage.content || ''
      return {
        ...messageContextMenu,
        message: latestMessage,
        copyContent,
        pinned: typeof latestMessage.metadata?.pinnedAt === 'number'
      }
    }, [messageContextMenu, visibleMessages])
    useEffect(() => {
      if (!messageContextMenu) return
      if (visibleMessages.some((message) => message.id === messageContextMenu.message.id)) return
      setMessageContextMenu(null)
    }, [messageContextMenu, visibleMessages])
    const shouldShowRunCompleteNotice =
      Boolean(runCompleteNotice && !isWelcomeChat && !shouldSuppressRunCompleteSummary(runCompleteNotice))
    const runCompleteSummaryRows = useMemo(() => {
      // Ensemble chats: aggregate across every participant in the
      // round so the user sees ALL contributing models (not just the
      // last speaker's), round-envelope duration, and summed tokens.
      // Solo chats: the original single-run summary.
      if (currentChat?.chatKind === 'ensemble' && currentChat.ensemble?.activeRound) {
        return buildEnsembleRoundSummaryRows(currentChat, runCompleteNotice?.exitCode !== 0, {
          currency,
          overestimatePercent: currencyOverestimatePercent,
          providerRates
        })
      }
      const rows = buildRunCompleteSummaryRows(currentRun)
      if (!rows.some((row) => row.label === 'RAM')) {
        const guestRam = buildGuestCompanionRamRow(
          resolveGuestCompanionRuns(currentChat, chats)
        )
        if (guestRam) rows.push(guestRam)
      }
      return rows
    }, [
      chats,
      currentChat,
      currentRun,
      runCompleteNotice?.exitCode,
      currency,
      currencyOverestimatePercent,
      providerRates
    ])
    // 1.0.7 (M5 surfacing) — advisory chips for the dark-shipped escalation
    // signals on the current round. Read-only: the orchestrator persists
    // these; we just surface label + recommended action.
    const escalationChips = useMemo(() => buildEscalationChips(currentChat), [currentChat])
    const runBoundaryByMessageId = useMemo(() => {
      const runs = currentChat?.runs || []
      const runById = new Map<string, ChatRun>()
      const promptRunByMessageId = new Map<string, ChatRun>()
      for (const run of runs) {
        if (run.runId) runById.set(run.runId, run)
        if (run.promptMessageId) promptRunByMessageId.set(run.promptMessageId, run)
      }

      const boundaries = new Map<string, ChatRun>()
      let previousRunId: string | null = null
      for (const message of visibleMessages) {
        const run =
          (message.runId ? runById.get(message.runId) : undefined) ||
          promptRunByMessageId.get(message.id)
        if (!run?.runId) continue
        if (run.runId !== previousRunId) {
          boundaries.set(message.id, run)
        }
        previousRunId = run.runId
      }
      return boundaries
    }, [currentChat?.runs, visibleMessages])
    // Per-message expansion state for long user-message bubbles. Keyed by
    // message.id so toggling one brief does not collapse others. Default for
    // every long message is collapsed — see UserMessageCollapse for thresholds.
    const [expandedUserMessages, setExpandedUserMessages] = useState<Set<string>>(new Set())
    const toggleUserMessageExpanded = (id: string) => {
      setExpandedUserMessages((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      })
    }

    // 1.0.6-TV2 — lifted ActivityStack expansion. Keyed by message id
    // (the tool row's id), value is the stack's set of open activity
    // ids. Held here (not inside ActivityStack) so a tool row scrolled
    // out of the virtualised window and back keeps whatever the user had
    // expanded — same survival pattern as `expandedUserMessages`.
    const [activityExpansionByRow, setActivityExpansionByRow] = useState<Map<string, Set<string>>>(
      new Map()
    )
    const setActivityExpansionForRow = useCallback((rowId: string, next: Set<string>) => {
      setActivityExpansionByRow((prev) => {
        const map = new Map(prev)
        if (next.size === 0) map.delete(rowId)
        else map.set(rowId, next)
        return map
      })
    }, [])
    const [expandedSubThreadResults, setExpandedSubThreadResults] = useState<Set<string>>(
      new Set()
    )
    const setSubThreadResultExpanded = useCallback((rowId: string, expanded: boolean) => {
      setExpandedSubThreadResults((prev) => {
        const next = new Set(prev)
        if (expanded) next.add(rowId)
        else next.delete(rowId)
        return next
      })
    }, [])
    // Row ids whose tool stack has something open — the measurementKey
    // geometry bit, so collapsed vs expanded rows cache distinct heights.
    const expandedRowIds = useMemo(() => {
      const ids = new Set<string>()
      for (const [rowId, set] of activityExpansionByRow) {
        if (set.size > 0) ids.add(rowId)
      }
      for (const rowId of expandedSubThreadResults) {
        ids.add(rowId)
      }
      return ids
    }, [activityExpansionByRow, expandedSubThreadResults])

    // 1.0.6-TV1 — windowing. `virtualize` defaults to the global flag;
    // tests pass it explicitly. When off, `useTranscriptVirtualization`
    // is inert and the full-list branch below renders exactly as before.
    //
    // 1.0.7 — virtualization is ON for ALL chat kinds including ensembles. An
    // earlier patch (e4feee5) disabled it for ensembles to dodge a flicker, but
    // that abandoned the benefit for exactly the densest transcripts. The
    // flicker's real root cause — a window↔measurement oscillation fed by (a)
    // 4–5× under-estimated dense rows, (b) a scrollbar→width-bucket cache
    // invalidation, and (c) the window being re-selected from the live heights
    // its own mounted rows mutate — is now fixed at source: content-scaled
    // estimates, `scrollbar-gutter: stable` + inner-width bucketing, a stable
    // window-selection snapshot (select-on-scroll, not on every measure), and a
    // one-shot anchor correction. So ensembles keep windowing and converge.
    const virtualizeEnabled = virtualize ?? TRANSCRIPT_VIRTUALIZATION_ENABLED
    const displayMessages = useMemo(() => groupAdjacentToolMessages(visibleMessages), [visibleMessages])

    // Phase 3 — type-out reveal (Variant B), behind a flag (default OFF). The
    // live last-assistant bubble of a running chat reveals progressively via
    // RevealingMarkdownMessage; everything else stays the plain MarkdownMessage.
    const revealEnabled = useMemo(() => {
      try {
        return localStorage.getItem('taskwraith.experimentalReveal') === 'true'
      } catch {
        return false
      }
    }, [])
    const revealChatId = currentChat?.appChatId ?? null
    const revealChatIsRunning =
      revealChatId != null && Array.isArray(runningChatIds) && runningChatIds.includes(revealChatId)
    const lastDisplayedMessageId =
      displayMessages.length > 0 ? displayMessages[displayMessages.length - 1].id : null
    const displayRunBoundaryByMessageId = useMemo(() => {
      const map = new Map(runBoundaryByMessageId)
      for (const message of displayMessages) {
        if (map.has(message.id)) continue
        const groupedIds = message.metadata?.groupedToolMessageIds
        if (!Array.isArray(groupedIds)) continue
        const boundaryId = groupedIds.find((id) => typeof id === 'string' && map.has(id))
        if (boundaryId) map.set(message.id, map.get(boundaryId)!)
      }
      return map
    }, [displayMessages, runBoundaryByMessageId])

    const virtualRows = useMemo(
      () =>
        virtualizeEnabled
          ? projectRows(displayMessages, new Set(displayRunBoundaryByMessageId.keys()))
          : EMPTY_VIRTUAL_ROWS,
      [virtualizeEnabled, displayMessages, displayRunBoundaryByMessageId]
    )
    const {
      window: virtualWindow,
      blockRef: virtualBlockRef,
      spacerBottomRef
    } = useTranscriptVirtualization({
      enabled: virtualizeEnabled,
      rows: virtualRows,
      scrollRef,
      contentRef,
      autoFollowRef,
      compactDensity,
      expandedRowIds
    })
    const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
    const highlightTimerRef = useRef<number | null>(null)
    const chatId = currentChat?.appChatId ?? null
    const previousChatIdRef = useRef<string | null>(chatId)
    useLayoutEffect(() => {
      if (previousChatIdRef.current === chatId) return
      previousChatIdRef.current = chatId
      setMessageContextMenu(null)
      setExpandedUserMessages(new Set())
      setActivityExpansionByRow(new Map())
      setExpandedSubThreadResults(new Set())
      setHighlightedMessageId(null)
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = null
      }
    }, [chatId])
    const focusMessageBlock = useCallback(
      (messageId: string): boolean => {
        const scroller = scrollRef.current
        if (!scroller) return false
        const escaped =
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(messageId)
            : messageId.replace(/["\\]/g, '\\$&')
        const target = scroller.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`)
        if (!target) return false
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setHighlightedMessageId(messageId)
        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current)
        }
        highlightTimerRef.current = window.setTimeout(() => {
          highlightTimerRef.current = null
          setHighlightedMessageId((current) => (current === messageId ? null : current))
        }, 1800)
        return true
      },
      [scrollRef]
    )

    useEffect(() => {
      const request = jumpToMessageRequest
      if (!request?.messageId) return
      if (focusMessageBlock(request.messageId)) return

      const scroller = scrollRef.current
      if (!scroller || !virtualizeEnabled) return
      const row = virtualRows.find((candidate) => candidate.id === request.messageId)
      if (!row) return
      const estimatedTop = sumHeights(
        virtualRows.map((candidate) => candidate.estimatedHeight),
        0,
        row.index
      )
      scroller.scrollTop = Math.max(0, estimatedTop - Math.round(scroller.clientHeight * 0.35))
      const frame = window.requestAnimationFrame(() => {
        focusMessageBlock(request.messageId)
      })
      return () => window.cancelAnimationFrame(frame)
    }, [
      jumpToMessageRequest?.requestId,
      jumpToMessageRequest?.messageId,
      focusMessageBlock,
      scrollRef,
      virtualRows,
      virtualizeEnabled
    ])

    useEffect(() => {
      return () => {
        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current)
          highlightTimerRef.current = null
        }
      }
    }, [])

    // Messages mounted this frame, each paired with its collision-proof
    // `rowKey` (`${id}#${index}`). The window slice when virtualised, else the
    // full list. Keying React + the element map on `rowKey` (not `msg.id`)
    // means duplicate message ids — which exist in historical/imported data —
    // can never make two rows share a DOM node / measurement slot.
    const renderedRows: Array<{ msg: ChatMessage; rowKey: string }> = virtualizeEnabled
      ? virtualRows
          .slice(virtualWindow.startIndex, virtualWindow.endIndex)
          .map((r) => {
            const msg = displayMessages[r.index]
            return msg ? { msg, rowKey: r.rowKey } : null
          })
          .filter((r): r is { msg: ChatMessage; rowKey: string } => Boolean(r))
      : displayMessages.map((msg, index) => ({ msg, rowKey: `${msg.id}#${index}` }))

    return (
      <div
        className={`transcript-scroll${isGlobal ? ' is-global' : ''}`}
        data-scope={isGlobal ? 'global' : 'workspace'}
        ref={scrollRef}
      >
        <div
          className={`transcript-inner${virtualizeEnabled ? ' transcript-virtualized' : ''}`}
          ref={contentRef}
        >
          {virtualizeEnabled && (
            <div
              className="vlist-spacer-top"
              style={{ height: virtualWindow.topSpacerPx }}
              aria-hidden
            />
          )}
          {renderedRows.map(({ msg, rowKey }) => {
            const isDelegationCard = isSubThreadDelegationMessage(msg)
            const isReturnCard = isSubThreadReturnMessage(msg)
            const isGuestReply = isGuestParticipantReplyMessage(msg)
            const isCollaboratorComment = isHumanCollaboratorComment(msg)
            const collaboratorMeta = isCollaboratorComment ? humanCollaboratorMetadata(msg) : null
            const boundaryRun = displayRunBoundaryByMessageId.get(msg.id)
            const isSideChatSeedMessage = Boolean(
              sideChatSeedMessageId && msg.id === sideChatSeedMessageId
            )
            const isPinned = typeof msg.metadata?.pinnedAt === 'number'
            const isPinnedMessageTarget = highlightedMessageId === msg.id
            return (
              <div
                key={`message-block-${rowKey}`}
                className={`transcript-message-block${
                  isSideChatSeedMessage ? ' is-side-chat-seed' : ''
                }${isPinnedMessageTarget ? ' is-pinned-message-target' : ''}`}
                data-vrow-id={rowKey}
                data-message-id={msg.id}
                onMouseEnter={() => onMessageSelectionCandidate?.(msg)}
                onFocus={() => onMessageSelectionCandidate?.(msg)}
                ref={virtualizeEnabled ? virtualBlockRef : undefined}
              >
                {boundaryRun && (
                  <RunCard
                    run={boundaryRun}
                    fallbackProvider={getChatProvider(currentChat)}
                    onInspect={onInspectRun}
                    onOpenSideChat={onOpenSideChatFromRun}
                  />
                )}
                {isDelegationCard || isReturnCard ? (
                  <div
                    key={msg.id}
                    className={`message-group ${
                      isReturnCard ? 'subthread-return-message' : ''
                    } ${isDelegationCard ? 'subthread-delegation-message' : ''}${
                      isGuestReply ? ' guest-participant-reply-message' : ''
                    }${isCollaboratorComment ? ' human-collaborator-comment-message' : ''
                    }`}
                    onContextMenu={
                      isReturnCard
                        ? (event) =>
                            openMessageContextMenu(
                              event,
                              msg,
                              subThreadReturnBody(msg.content),
                              'sub-thread result',
                              { copySource: 'subthread-return-body' }
                            )
                        : undefined
                    }
                  >
                    {isDelegationCard ? (
                      <SubThreadDelegationCard
                        message={msg}
                        chats={chats}
                        runningChatIds={runningChatIds}
                        onOpenSubThread={onOpenSubThread}
                        onOpenSubThreadInSidePanel={onOpenSubThreadInSidePanel}
                      />
                    ) : (
                      <SubThreadReturnCard
                        message={msg}
                        chat={currentChat || undefined}
                        onOpenSubThread={onOpenSubThread}
                        onOpenSubThreadInSidePanel={onOpenSubThreadInSidePanel}
                        onCopyMessage={onCopyMessage}
                        onTogglePinMessage={onTogglePinMessage}
                        onDeleteMessage={onDeleteMessage}
                        onOpenSideChatFromMessage={onOpenSideChatFromMessage}
                        pinned={isPinned}
                        copied={copiedId === msg.id}
                        resultExpanded={expandedSubThreadResults.has(msg.id)}
                        onResultExpandedChange={(expanded) =>
                          setSubThreadResultExpanded(msg.id, expanded)
                        }
                      />
                    )}
                  </div>
                ) : msg.role === 'tool' && (msg.toolActivities?.length || 0) > 0 ? (
                  <ActivityStack
                    key={msg.id}
                    activities={msg.toolActivities || []}
                    workspacePath={currentWorkspacePath}
                    provider={getChatProvider(currentChat)}
                    chatId={currentChat?.appChatId}
                    runId={msg.runId || boundaryRun?.runId}
                    chat={currentChat || undefined}
                    compactDensity={compactDensity}
                    liveActivityViewport={liveActivityViewport}
                    expandedActivityIds={
                      activityExpansionByRow.get(msg.id) ?? EMPTY_ACTIVITY_EXPANSION
                    }
                    onExpandedActivityIdsChange={(next) => setActivityExpansionForRow(msg.id, next)}
                  />
                ) : msg.role === 'tool' ? (
                  <div key={msg.id} className="message-group tool-message-fallback">
                    <div className="message-meta">Tool</div>
                    <div
                      className="message-bubble system tool-message-fallback-bubble"
                      onContextMenu={(event) =>
                        openMessageContextMenu(event, msg, msg.content || '', 'tool message')
                      }
                    >
                      {msg.content ? (
                        <MarkdownMessage content={msg.content} chat={currentChat || undefined} />
                      ) : (
                        <span>Tool event recorded without displayable details.</span>
                      )}
                      <MessageActionsChip
                        onCopy={() => onCopyMessage(msg.id, msg.content || '')}
                        onTogglePin={
                          onTogglePinMessage ? () => onTogglePinMessage(msg.id) : undefined
                        }
                        onDelete={() => onDeleteMessage(msg.id)}
                        onOpenSideChat={
                          onOpenSideChatFromMessage
                            ? () => onOpenSideChatFromMessage(msg)
                            : undefined
                        }
                        pinned={isPinned}
                        copied={copiedId === msg.id}
                        label="tool message"
                      />
                    </div>
                  </div>
                ) : msg.metadata?.kind === 'ensembleParticipantHealth' ? (
                  /*
                    1.0.5-EW29 — Structured participant-health pre-flight
                    summary. Rendered as a chip-strip card instead of a
                    plain system-message bubble. The card component
                    derives everything it needs (provider, role, status,
                    failure reason) from `msg.metadata.entries`. The
                    text variant on `msg.content` is the fallback for
                    older transcripts / exports.
                  */
                  <ParticipantHealthCard key={msg.id} message={msg} />
                ) : msg.metadata?.kind === 'providerRunFailure' ? (
                  <ProviderRunFailureCard
                    key={msg.id}
                    message={msg}
                    onCopy={onCopyMessage}
                    onContextMenu={(event, copyText) =>
                      openMessageContextMenu(event, msg, copyText, 'provider failure', {
                        copyOnly: true,
                        copySource: 'static'
                      })
                    }
                    copied={copiedId === msg.id}
                  />
                ) : (
                  <div
                    key={msg.id}
                    className={`message-group ${
                      isReturnCard ? 'subthread-return-message' : ''
                    } ${isDelegationCard ? 'subthread-delegation-message' : ''}${
                      isGuestReply ? ' guest-participant-reply-message' : ''
                    }${isCollaboratorComment ? ' human-collaborator-comment-message' : ''}`}
                  >
                    {(() => {
                      // Provider-aware label rendering. Solo chats: the
                      // chat-level provider colours the whole label.
                      // Ensemble chats: each message carries its own
                      // `ensembleProvider` metadata so each assistant
                      // message gets coloured by *who actually spoke*
                      // even when the chat-level provider differs.
                      // CSS in `main.css` keys off `.provider-{name}`
                      // on `.message-meta` to tint with
                      // `--provider-{name}-color`.
                      if (msg.role === 'user') {
                        // `user-meta` class is the seam the per-user
                        // `userBubbleColor` appearance setting hooks
                        // into to tint the "You" label with the same
                        // hue as the bubble. See `[data-user-bubble-
                        // color]` rules in `main.css`.
                        return <div className="message-meta user-meta">You</div>
                      }
                      if (msg.role === 'error') {
                        return <div className="message-meta">Error</div>
                      }
                      if (isCollaboratorComment) {
                        return (
                          <div className="message-meta human-collaborator-meta">
                            <span className="message-meta-label">
                              {collaboratorMeta?.collaboratorDisplayName || 'Collaborator'}
                            </span>
                            <span
                              className="message-meta-model-badge"
                              title="External collaborator comment"
                            >
                              Collaborator
                            </span>
                          </div>
                        )
                      }
                      if (msg.role === 'assistant' || isGuestReply) {
                        const { label, provider, providerClass, modelBadge } =
                          formatAssistantMessageLabel(msg, currentProviderLabel, currentProvider, {
                            isEnsembleChat: currentChat?.chatKind === 'ensemble'
                          })
                        // Solo General (global, non-ensemble) chats read as one
                        // friendly "Assistant" voice: drop the provider tint +
                        // model badge. Ensemble — AND a solo guest reply — keep
                        // their per-speaker tint/badge so the reader can still
                        // tell host from guest in a legitimate multi-voice chat.
                        const soloGlobal =
                          isGlobal === true &&
                          currentChat?.chatKind !== 'ensemble' &&
                          !isGuestReply
                        // 1.0.7 — participant-rename continuity. The
                        // header keeps the FROZEN role label; this quiet
                        // badge tells the reader the seat has since been
                        // renamed (e.g. "Planner" here is the seat now
                        // called "Architect") so they can follow one
                        // participant across a mid-session rename. Ledger-
                        // preferred, with a frozen-vs-current fallback —
                        // see deriveParticipantRenameContinuity.
                        const renameContinuity = deriveParticipantRenameContinuity(
                          msg,
                          currentChat?.ensemble?.participants,
                          currentChat?.ensemble?.sessionActivityLedger
                        )
                        return (
                          <div
                            className={`message-meta${
                              !soloGlobal && (providerClass || provider)
                                ? ` provider-${providerClass || provider}`
                                : ''
                            }`}
                          >
                            <span className="message-meta-label">
                              {soloGlobal ? 'Assistant' : label}
                            </span>
                            {!soloGlobal && modelBadge && (
                              <span
                                className="message-meta-model-badge"
                                title={`Model: ${modelBadge}`}
                                aria-label={`Model ${modelBadge}`}
                              >
                                {modelBadge}
                              </span>
                            )}
                            {renameContinuity && (
                              <span
                                className="message-meta-renamed-from"
                                title={`Now: ${renameContinuity.currentRole}`}
                                aria-label={`Renamed from ${renameContinuity.fromRole}; now ${renameContinuity.currentRole}`}
                              >
                                renamed from {renameContinuity.fromRole}
                              </span>
                            )}
                          </div>
                        )
                      }
                      // Ensemble status messages (`yielded` / `failed` /
                      // `skipped`) currently arrive with `role: 'system'`
                      // because the orchestrator emits them as system-
                      // origin chrome. They carry the participant's
                      // identity in metadata though — so render them as
                      // the participant (with provider tint) rather than
                      // a generic "System" label. Reads more naturally
                      // for users (e.g. the reason text on a yield is
                      // really the participant's voice, not the app's).
                      const statusMeta =
                        msg.metadata?.kind === 'ensembleParticipantStatus'
                          ? {
                              provider: msg.metadata?.ensembleProvider as ProviderId | undefined,
                              role:
                                typeof msg.metadata?.ensembleRole === 'string'
                                  ? msg.metadata.ensembleRole
                                  : '',
                              model:
                                typeof msg.metadata?.ensembleModel === 'string'
                                  ? msg.metadata.ensembleModel
                                  : ''
                            }
                          : null
                      if (statusMeta?.provider) {
                        const label = statusMeta.role
                          ? `${getProviderLabel(statusMeta.provider)} / ${statusMeta.role}`
                          : getProviderLabel(statusMeta.provider)
                        const statusModelBadge = statusMeta.model
                          ? shortModelName(statusMeta.provider, '', statusMeta.model)
                          : ''
                        return (
                          <div className={`message-meta provider-${statusMeta.provider}`}>
                            <span className="message-meta-label">{label}</span>
                            {statusModelBadge && (
                              <span
                                className="message-meta-model-badge"
                                title={`Model: ${statusModelBadge}`}
                                aria-label={`Model ${statusModelBadge}`}
                              >
                                {statusModelBadge}
                              </span>
                            )}
                          </div>
                        )
                      }
                      return <div className="message-meta">System</div>
                    })()}
                    {msg.role === 'user' ? (
                      (() => {
                        // Long pasted briefs would otherwise dominate the scroll
                        // viewport. Collapse them by default and let the user
                        // expand inline with "Show more". Toggle state lives in
                        // `expandedUserMessages` so each bubble is independent.
                        const collapsible = shouldCollapseUserMessage(msg.content)
                        const isExpanded = expandedUserMessages.has(msg.id)
                        const showCollapsed = collapsible && !isExpanded
                        const preview = showCollapsed
                          ? truncateUserMessagePreview(msg.content)
                          : msg.content
                        const mediaRefs = collectMessageMediaRefs(msg)
                        // Drop from the attachment strip any image already shown
                        // inline in the (possibly truncated) rendered body.
                        const inlineImageIds = collectInlineImageRefIds(
                          preview,
                          mediaRefs,
                          currentChat?.workspacePath
                        )
                        const stripRefs = inlineImageIds.size
                          ? mediaRefs.filter((ref) => !inlineImageIds.has(ref.id))
                          : mediaRefs
                        return (
                          <div
                            className={`message-bubble user${
                              collapsible ? ' is-collapsible' : ''
                            }${showCollapsed ? ' is-collapsed' : ''}`}
                            onContextMenu={(event) =>
                              openMessageContextMenu(event, msg, msg.content, 'user message')
                            }
                          >
                            <div className="user-message-content">
                              <MarkdownMessage
                                content={preview}
                                chat={currentChat || undefined}
                                mediaRefs={mediaRefs}
                                workspacePath={currentChat?.workspacePath}
                                onPreviewImage={onPreviewImage}
                              />
                            </div>
                            {stripRefs.length > 0 && (
                              <ChatMessageMediaStrip
                                refs={stripRefs}
                                workspacePath={currentChat?.workspacePath}
                                onPreviewImage={onPreviewImage}
                              />
                            )}
                            {collapsible && (
                              <button
                                type="button"
                                className="user-message-toggle"
                                onClick={() => toggleUserMessageExpanded(msg.id)}
                                aria-expanded={isExpanded}
                                title={isExpanded ? 'Collapse message' : 'Show full message'}
                              >
                                {isExpanded ? 'Show less' : 'Show more'}
                              </button>
                            )}
                            {/* 1.0.4-AQ4 — hover-only Copy + Delete actions.
                                Visible only when hovering the bubble (CSS),
                                so the resting transcript stays clean. Copy
                                writes msg.content verbatim; Delete confirms
                                before removing from the transcript. */}
                            <MessageActionsChip
                              onCopy={() => onCopyMessage(msg.id, msg.content)}
                              onTogglePin={
                                onTogglePinMessage ? () => onTogglePinMessage(msg.id) : undefined
                              }
                              onDelete={() => onDeleteMessage(msg.id)}
                              onOpenSideChat={
                                onOpenSideChatFromMessage
                                  ? () => onOpenSideChatFromMessage(msg)
                                  : undefined
                              }
                              pinned={isPinned}
                              copied={copiedId === msg.id}
                              label="user message"
                            />
                          </div>
                        )
                      })()
                    ) : (
                      (() => {
                        const mediaRefs = collectMessageMediaRefs(msg)
                        // Drop from the attachment strip any image already shown
                        // inline in the rendered body (deduped by resolved ref id).
                        const inlineImageIds = collectInlineImageRefIds(
                          msg.content,
                          mediaRefs,
                          currentChat?.workspacePath
                        )
                        const stripRefs = inlineImageIds.size
                          ? mediaRefs.filter((ref) => !inlineImageIds.has(ref.id))
                          : mediaRefs
                        return (
                          <div
                            className={`message-bubble ${
                              isCollaboratorComment
                                ? 'system human-collaborator-comment'
                                : isGuestReply
                                  ? 'assistant guest-participant-reply'
                                  : msg.role
                            }${ensembleRoundStatusClass(msg)}`}
                            onContextMenu={
                              (msg.role === 'assistant' || msg.role === 'system' || isGuestReply) &&
                              msg.content
                                ? (event) =>
                                    openMessageContextMenu(
                                      event,
                                      msg,
                                      msg.content || '',
                                      `${isGuestReply ? 'guest participant' : msg.role} message`
                                    )
                                : undefined
                            }
                          >
                            {msg.role === 'assistant' || msg.role === 'system' || isGuestReply ? (
                              revealEnabled &&
                              revealChatIsRunning &&
                              msg.id === lastDisplayedMessageId ? (
                                <RevealingMarkdownMessage
                                  content={msg.content}
                                  chat={currentChat || undefined}
                                  isLive
                                  mediaRefs={mediaRefs}
                                  workspacePath={currentChat?.workspacePath}
                                  onPreviewImage={onPreviewImage}
                                />
                              ) : (
                                <MarkdownMessage
                                  content={msg.content}
                                  chat={currentChat || undefined}
                                  mediaRefs={mediaRefs}
                                  workspacePath={currentChat?.workspacePath}
                                  onPreviewImage={onPreviewImage}
                                />
                              )
                            ) : (
                              msg.content
                            )}
                            {stripRefs.length > 0 && (
                              <ChatMessageMediaStrip
                                refs={stripRefs}
                                workspacePath={currentChat?.workspacePath}
                                onPreviewImage={onPreviewImage}
                              />
                            )}
                            {isCollaboratorComment && onPromoteCollaboratorComment && (
                              <div className="human-collaborator-actions">
                                <button
                                  type="button"
                                  className="human-collaborator-promote-btn"
                                  onClick={() => onPromoteCollaboratorComment(msg.id)}
                                  title="Add this collaborator request to the composer"
                                >
                                  Add to Composer
                                </button>
                                {collaboratorMeta?.promotedAt && (
                                  <span className="human-collaborator-status">
                                    Added to composer
                                  </span>
                                )}
                              </div>
                            )}
                            {/* 1.0.4-AQ4 — Copy + Delete on hover. Both assistant
                                and "other" role bubbles get the chip; for system
                                bubbles (status notes etc.) the chip is harmless
                                but rarely useful. */}
                            {(msg.role === 'assistant' || msg.role === 'system' || isGuestReply) &&
                              msg.content && (
                              <MessageActionsChip
                                onCopy={() => onCopyMessage(msg.id, msg.content)}
                                onTogglePin={
                                  onTogglePinMessage ? () => onTogglePinMessage(msg.id) : undefined
                                }
                                onDelete={() => onDeleteMessage(msg.id)}
                                onOpenSideChat={
                                  onOpenSideChatFromMessage
                                    ? () => onOpenSideChatFromMessage(msg)
                                    : undefined
                                }
                                pinned={isPinned}
                                copied={copiedId === msg.id}
                                label={`${isGuestReply ? 'guest participant' : msg.role} message`}
                              />
                            )}
                          </div>
                        )
                      })()
                    )}
                    {pendingPlanChoice && pendingPlanChoice.messageId === msg.id && (
                      <div className="plan-choice-card">
                        <div className="plan-choice-question">{pendingPlanChoice.question}</div>
                        <div className="plan-choice-actions">
                          {pendingPlanChoice.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              className="plan-choice-action-btn"
                              onClick={() => onPlanChoiceSubmit(msg.id, option)}
                              title={`Continue with "${option}"`}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {msg.metadata?.proposedPlan && (
                      <ProposedPlanCard
                        title={msg.metadata.proposedPlan.title}
                        body={msg.metadata.proposedPlan.body}
                        status={msg.metadata.proposedPlan.status}
                        chat={currentChat || undefined}
                        onApprove={(planBody) => onProposedPlanApprove(msg.id, planBody)}
                        onDismiss={() => onProposedPlanDismiss(msg.id)}
                        onCustom={(feedback) => onProposedPlanCustom(msg.id, feedback)}
                      />
                    )}
                    {pendingAgentQuestions
                      .filter((question) => question.messageId === msg.id)
                      .map((question) => (
                        <AgentQuestionCard
                          key={question.questionId}
                          state={question}
                          onAnswer={(answer, isCustom) =>
                            onAgentQuestionSubmit(question.questionId, answer, isCustom)
                          }
                          onDismiss={() => onAgentQuestionDismiss(question.questionId)}
                        />
                      ))}
                  </div>
                )}
              </div>
            )
          })}
          {virtualizeEnabled && (
            <div
              className="vlist-spacer-bottom"
              ref={spacerBottomRef}
              style={{ height: virtualWindow.bottomSpacerPx }}
              aria-hidden
            />
          )}
          {/*
            1.0.5-EW36 — Belt-and-braces fallback for the
            `ask_user_question` modal. The primary render path is
            inline next to the synthetic `agentQuestion` system
            marker (line ~5437); the chat-updated merge guard at
            line ~10864 keeps that marker alive across re-syncs.
            This fallback covers the residual case where the
            marker is somehow missing (race / store reset / future
            regression in the merge logic): if the user has a
            pending question with no matching message in
            visibleMessages, render the card here at the tail of
            the transcript so they can still answer. Without this
            the agent times out after 10 minutes with no
            user-recoverable surface.
          */}
          {pendingAgentQuestions
            .filter((question) => !visibleMessages.some((m) => m.id === question.messageId))
            .map((question) => (
              <div
                key={`pending-agent-question-fallback-${question.questionId}`}
                className="message-group agent-question-fallback"
              >
                <AgentQuestionCard
                  key={question.questionId}
                  state={question}
                  onAnswer={(answer, isCustom) =>
                    onAgentQuestionSubmit(question.questionId, answer, isCustom)
                  }
                  onDismiss={() => onAgentQuestionDismiss(question.questionId)}
                />
              </div>
            ))}
          {isThinking && (
            <div key="thinking-indicator" className="message-group">
              <div
                className={`message-meta${
                  thinkingProviderClass || thinkingProvider
                    ? ` provider-${thinkingProviderClass || thinkingProvider}`
                    : ''
                }`}
              >
                <span className="message-meta-label">
                  {thinkingProviderLabel || currentProviderLabel}
                </span>
                {thinkingModelBadge && (
                  <span
                    className="message-meta-model-badge"
                    title={`Model: ${thinkingModelBadge}`}
                    aria-label={`Model ${thinkingModelBadge}`}
                  >
                    {thinkingModelBadge}
                  </span>
                )}
              </div>
              <ThinkingIndicator />
            </div>
          )}
          {guestThinkingProviderLabel && (
            <div
              key="guest-thinking-indicator"
              className="message-group guest-participant-thinking-message"
            >
              <div
                className={`message-meta${
                  guestThinkingProviderClass || guestThinkingProvider
                    ? ` provider-${guestThinkingProviderClass || guestThinkingProvider}`
                    : ''
                }`}
              >
                <span className="message-meta-label">{guestThinkingProviderLabel}</span>
                {guestThinkingModelBadge && (
                  <span
                    className="message-meta-model-badge"
                    title={`Model: ${guestThinkingModelBadge}`}
                    aria-label={`Model ${guestThinkingModelBadge}`}
                  >
                    {guestThinkingModelBadge}
                  </span>
                )}
              </div>
              <ThinkingIndicator />
            </div>
          )}
          {showRunCompleteSummary !== false && shouldShowRunCompleteNotice && runCompleteNotice && (
            <div className={`run-complete-card${isGlobal ? ' is-global-stripped' : ''}`}>
              <div className="run-complete-main">
                <div className="run-complete-metadata">
                  <strong>
                    {isGlobal
                      ? runCompleteNotice.exitCode === 0
                        ? 'Done'
                        : runCompleteNotice.exitCode === 130
                          ? 'Stopped'
                          : "Couldn't finish"
                      : runCompleteNotice.exitCode === 0
                        ? 'Task complete'
                        : runCompleteNotice.exitCode === 130
                          ? 'Run cancelled'
                          : `Task ended (code ${runCompleteNotice.exitCode})`}
                  </strong>
                  {!isGlobal && (
                    <span className="run-complete-time-row">
                      <span>
                        {new Date(runCompleteNotice.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit'
                        })}
                      </span>
                      {runCompleteDurationText && <span>{runCompleteDurationText}</span>}
                    </span>
                  )}
                  {!isGlobal && runCompleteNotice.exitCode === 0 && (
                    <span>Awaiting your next prompt.</span>
                  )}
                </div>
                <div className="run-complete-actions">
                  {(() => {
                    const latestAssistantMessage = [...messages]
                      .reverse()
                      .find((m) => m.role === 'assistant')
                    const latestCopyId = latestAssistantMessage
                      ? `run-complete-copy-${latestAssistantMessage.id}`
                      : null
                    const isCopied = latestCopyId !== null && copiedId === latestCopyId
                    return (
                      <button
                        className={`btn btn-sm btn-ghost run-copy-btn${isCopied ? ' is-copied' : ''}`}
                        onClick={() => {
                          if (latestAssistantMessage?.content && latestCopyId) {
                            copy(latestCopyId, latestAssistantMessage.content)
                          }
                        }}
                        disabled={!latestAssistantMessage?.content}
                        title={isCopied ? 'Copied' : 'Copy latest assistant response'}
                        aria-label={
                          isCopied ? 'Latest response copied' : 'Copy latest assistant response'
                        }
                      >
                        {isCopied ? 'Copied' : 'Copy'}
                      </button>
                    )
                  })()}
                  {isGlobal && currentRun?.runId && onInspectRun && (
                    <button
                      className="btn btn-sm btn-ghost"
                      type="button"
                      onClick={() => onInspectRun(currentRun.runId)}
                      title="Inspect this run"
                      aria-label="Inspect this run"
                    >
                      Inspect
                    </button>
                  )}
                  {!isGlobal && currentRun?.runId && onOpenSideChatFromRun && (
                    <button
                      className="btn btn-sm btn-ghost"
                      type="button"
                      onClick={() => onOpenSideChatFromRun(currentRun.runId)}
                      title="Open side chat seeded from this run result"
                      aria-label="Open side chat from run result"
                    >
                      Side chat
                    </button>
                  )}
                </div>
              </div>
              {!isGlobal && runCompleteSummaryRows.length > 0 && (
                <div className="run-complete-summary-card">
                  <div className="run-complete-summary-header">
                    <strong>Run details</strong>
                  </div>
                  <div className="run-complete-summary-grid">
                    {runCompleteSummaryRows.map((row) => (
                      <div key={row.label} className="run-complete-summary-item">
                        <span>{row.label}</span>
                        <strong title={row.value}>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!isGlobal && escalationChips.length > 0 && (
                <div
                  className="ensemble-escalation-advisory"
                  role="status"
                  aria-label="Round advisories"
                >
                  {escalationChips.map((chip) => (
                    <div key={chip.id} className={`ensemble-escalation-chip tone-${chip.tone}`}>
                      <span className="ensemble-escalation-chip-label">{chip.label}</span>
                      {chip.action && (
                        <span className="ensemble-escalation-chip-action">{chip.action}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {(!isGlobal || displayFileChangeSummaries.length > 0) && (
              <div className="file-change-summary-card">
                <div className="file-change-summary-header">
                  <strong>File changes</strong>
                  <div className="file-change-summary-meta">
                    <span>{fileChangeSummaryText}</span>
                    {fileChangeShouldShowStats && (
                      <span className="file-change-summary-stats">
                        <span className="file-change-stat file-change-stat-add">
                          +{fileChangeDisplayAdds}
                        </span>
                        <span className="file-change-stat-divider">|</span>
                        <span className="file-change-stat file-change-stat-delete">
                          -{fileChangeDisplayDels}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="file-change-summary-list">
                  {displayFileChangeSummaries.length > 0 ? (
                    <>
                      {displayFileChangeSummaries.slice(0, 12).map((item) => (
                        <div
                          key={`${item.path}-${item.status}`}
                          className="file-change-summary-item"
                        >
                          <span className={`file-change-summary-status status-${item.status}`}>
                            {item.status === 'modified' ? 'edited' : item.status}
                          </span>
                          <FileTypeIcon
                            path={item.path}
                            size={14}
                            className="file-change-summary-type-icon"
                            workspacePath={currentWorkspacePath}
                          />
                          <span className="file-change-summary-path" title={item.path}>
                            {item.path}
                          </span>
                          {(item.additions !== undefined || item.deletions !== undefined) && (
                            <span className="file-change-summary-item-stats">
                              <span className="file-change-stat file-change-stat-add">
                                +{item.additions || 0}
                              </span>
                              <span className="file-change-stat-divider">|</span>
                              <span className="file-change-stat file-change-stat-delete">
                                -{item.deletions || 0}
                              </span>
                            </span>
                          )}
                        </div>
                      ))}
                      {displayFileChangeSummaries.length > 12 && (
                        <div className="file-change-summary-item file-change-summary-overflow">
                          +{displayFileChangeSummaries.length - 12} more files changed
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="file-change-summary-item file-change-summary-empty">
                      No file changes detected for this run.
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
        <TranscriptMessageContextMenu
          selection={activeMessageContextMenu}
          onCopyMessage={onCopyMessage}
          onTogglePinMessage={onTogglePinMessage}
          onOpenSideChatFromMessage={onOpenSideChatFromMessage}
          onDeleteMessage={onDeleteMessage}
          onClose={closeMessageContextMenu}
        />
      </div>
    )
  },
  (previous, next) =>
    previous.scrollRef === next.scrollRef &&
    previous.contentRef === next.contentRef &&
    previous.endRef === next.endRef &&
    previous.messages === next.messages &&
    previous.isWelcomeChat === next.isWelcomeChat &&
    previous.isThinking === next.isThinking &&
    previous.pendingPlanChoice === next.pendingPlanChoice &&
    previous.pendingProposedPlan === next.pendingProposedPlan &&
    previous.pendingAgentQuestions === next.pendingAgentQuestions &&
    previous.onAgentQuestionSubmit === next.onAgentQuestionSubmit &&
    previous.onAgentQuestionDismiss === next.onAgentQuestionDismiss &&
    previous.runCompleteNotice === next.runCompleteNotice &&
    previous.runCompleteDurationText === next.runCompleteDurationText &&
    previous.currentRun === next.currentRun &&
    previous.currentChat === next.currentChat &&
    previous.currentWorkspacePath === next.currentWorkspacePath &&
    previous.currentProviderLabel === next.currentProviderLabel &&
    previous.currentProvider === next.currentProvider &&
    previous.thinkingProviderLabel === next.thinkingProviderLabel &&
    previous.thinkingProvider === next.thinkingProvider &&
    previous.thinkingProviderClass === next.thinkingProviderClass &&
    previous.thinkingModelBadge === next.thinkingModelBadge &&
    previous.guestThinkingProviderLabel === next.guestThinkingProviderLabel &&
    previous.guestThinkingProvider === next.guestThinkingProvider &&
    previous.guestThinkingProviderClass === next.guestThinkingProviderClass &&
    previous.guestThinkingModelBadge === next.guestThinkingModelBadge &&
    previous.displayFileChangeSummaries === next.displayFileChangeSummaries &&
    previous.fileChangeSummaryText === next.fileChangeSummaryText &&
    previous.fileChangeShouldShowStats === next.fileChangeShouldShowStats &&
    previous.fileChangeDisplayAdds === next.fileChangeDisplayAdds &&
    previous.fileChangeDisplayDels === next.fileChangeDisplayDels &&
    previous.chats === next.chats &&
    previous.runningChatIds === next.runningChatIds &&
    previous.pendingQueuedAppRunIds === next.pendingQueuedAppRunIds &&
    previous.queuedRunStatusByAppRunId === next.queuedRunStatusByAppRunId &&
    previous.onCopyMessage === next.onCopyMessage &&
    previous.onDeleteMessage === next.onDeleteMessage &&
    previous.onMessageSelectionCandidate === next.onMessageSelectionCandidate &&
    previous.onOpenSideChatFromMessage === next.onOpenSideChatFromMessage &&
    previous.sideChatSeedMessageId === next.sideChatSeedMessageId &&
    previous.onPreviewImage === next.onPreviewImage &&
    previous.copiedId === next.copiedId &&
    previous.copy === next.copy &&
    previous.virtualize === next.virtualize &&
    previous.autoFollowRef === next.autoFollowRef
)

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AgentIdentityContext } from './AgentIdentityContext'
import { MarkdownMediaContext } from './MarkdownMediaContext'
import { identityContextEqual, useStableMarkdownMediaValue } from './MarkdownMessage'
import { StableMarkdownBlock } from './StableMarkdownBlock'
import { splitMarkdownIntoBlocks, type MarkdownBlockType } from '../lib/MarkdownBlockSplit'
import { graphemeCount, sliceGraphemes, toGraphemes } from '../lib/advanceReveal'
import {
  advanceAdaptiveReveal,
  commonGraphemePrefixLength,
  createAdaptiveRevealState,
  createRevealCadenceTracker,
  observeRevealTarget,
  resolveAdaptiveRevealPresentation,
  revealCadenceSnapshot
} from '../lib/adaptiveReveal'
import { readRevealCadencePrior, recordRevealCadencePrior } from '../lib/revealCadenceRegistry'
import {
  clearRevealSession,
  readRevealSession,
  revealSessionKey,
  writeRevealSession
} from '../lib/revealSessionRegistry'
import { useRevealClock } from '../lib/useRevealClock'
import type { ChatMediaRef } from './ChatMediaPanel'
import type { ChatRecord, ProviderId } from '../../../main/store/types'

/*
 * RevealingMarkdownMessage decouples ARRIVAL from DISPLAY for the one live
 * assistant bubble. The authoritative accumulated string is never changed;
 * an adaptive, message-global grapheme cursor chooses the display-only prefix.
 *
 * Message-global is important: a blank line may promote a Markdown tail into a
 * stable block, but that block still cannot render until the cursor reaches it.
 * The component also stays mounted after `isLive` flips false, so terminal
 * backlog drains smoothly instead of being replaced by plain Markdown in one
 * frame.
 */

interface RevealingMarkdownMessageProps {
  content: string
  chat?: ChatRecord
  /** True while this is the live, streaming last-assistant bubble. */
  isLive: boolean
  /** Stable identity used for cadence history and reattach decisions. */
  messageId?: string
  messageTimestamp?: string
  provider?: ProviderId
  model?: string | null
  /** Override; defaults to the OS / in-app reduced-motion setting. */
  reduceMotion?: boolean
  /** This message's media refs, used to replace inline `![]()` placeholders. */
  mediaRefs?: readonly ChatMediaRef[]
  /** Chat workspace path, used to resolve relative markdown image paths. */
  workspacePath?: string
  /** When provided, inline images open the full-size preview overlay on click. */
  onPreviewImage?: (ref: ChatMediaRef) => void
  /** Run id for stream render instrumentation. */
  streamRunId?: string
  /** Prunes lifecycle state after a settled row naturally leaves the viewport. */
  onRevealUnmounted?: () => void
}

const FRESH_LIVE_MOUNT_MS = 4_000

function readReducedMotionPreference(): boolean {
  if (
    typeof document !== 'undefined' &&
    document.documentElement?.getAttribute('data-reduce-motion') === 'true'
  ) {
    return true
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return !!window.matchMedia('(prefers-reduced-motion: reduce)')?.matches
  }
  return false
}

function useReducedMotionPreference(override: boolean | undefined, active = true): boolean {
  const [systemReduced, setSystemReduced] = useState(readReducedMotionPreference)

  useEffect(() => {
    if (!active || override !== undefined || typeof window === 'undefined') return
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    const update = () => setSystemReduced(readReducedMotionPreference())
    media?.addEventListener?.('change', update)
    const observer =
      typeof MutationObserver === 'function' && typeof document !== 'undefined'
        ? new MutationObserver(update)
        : null
    if (document?.documentElement) {
      observer?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-reduce-motion']
      })
    }
    update()
    return () => {
      media?.removeEventListener?.('change', update)
      observer?.disconnect()
    }
  }, [active, override])

  return override ?? systemReduced
}

function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function isFreshLiveMount(timestamp: string | undefined): boolean {
  if (!timestamp) return true
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return true
  return Date.now() - parsed <= FRESH_LIVE_MOUNT_MS
}

/** Structure-safe display slice of one Markdown tail. */
export function safeTailSlice(
  tailRaw: string,
  tailType: MarkdownBlockType,
  revealedGraphemes: number
): string {
  if (tailType === 'code') return tailRaw
  const slice = sliceGraphemes(tailRaw, revealedGraphemes)
  if (tailType === 'paragraph' || tailType === 'heading') return slice
  const nl = slice.lastIndexOf('\n')
  return nl >= 0 ? slice.slice(0, nl + 1) : ''
}

const NO_SPACE_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u
const AMBIGUOUS_LIST_MARKER_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s*$/u

function markerOpener(value: string, marker: string): number | null {
  let opener: number | null = null
  let index = 0
  while (index <= value.length - marker.length) {
    const found = value.indexOf(marker, index)
    if (found < 0) break
    const escaped = found > 0 && value[found - 1] === '\\'
    const previous = value[found - 1]
    const next = value[found + marker.length]
    if (!escaped) {
      if (opener === null && (next === undefined || !/\s/u.test(next))) opener = found
      else if (opener !== null && previous !== undefined && !/\s/u.test(previous)) opener = null
    }
    index = found + marker.length
  }
  return opener
}

/** Hold inline constructs until their closer arrives, avoiding a DOM reparse flash. */
function trimIncompleteInlineMarkdown(value: string): string {
  let cutoff = value.length
  const bracketStack: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] === '[') bracketStack.push(index > 0 && value[index - 1] === '!' ? index - 1 : index)
    else if (value[index] === ']' && bracketStack.length > 0) bracketStack.pop()
  }
  if (bracketStack.length > 0) cutoff = Math.min(cutoff, bracketStack[0])

  // A closing label at the current frontier is still ambiguous until the next
  // grapheme proves it is not followed by a link destination.
  if (value.endsWith(']')) {
    const labelStart = value.lastIndexOf('[')
    if (labelStart >= 0) {
      cutoff = Math.min(
        cutoff,
        labelStart > 0 && value[labelStart - 1] === '!' ? labelStart - 1 : labelStart
      )
    }
  }
  if (value.endsWith('!')) cutoff = Math.min(cutoff, value.length - 1)

  const incompleteDestination = /\]\([^)]*$/u.exec(value)
  if (incompleteDestination?.index !== undefined) {
    const labelStart = value.lastIndexOf('[', incompleteDestination.index)
    if (labelStart >= 0) {
      cutoff = Math.min(cutoff, labelStart > 0 && value[labelStart - 1] === '!' ? labelStart - 1 : labelStart)
    }
  }

  for (const marker of ['**', '__', '~~', '`']) {
    const opener = markerOpener(value, marker)
    if (opener !== null) cutoff = Math.min(cutoff, opener)
  }
  return value.slice(0, cutoff)
}

function canReleaseTrailingFragment(value: string): boolean {
  const trimmed = value.trimEnd()
  if (!trimmed) return false
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1)
  if (lastLine.includes('|')) return false
  if (/^\s*\d{1,9}$/u.test(lastLine)) return false
  if (['!', '[', ']', '`', '*', '_', '~'].includes(trimmed.at(-1) ?? '')) return false
  return trimIncompleteInlineMarkdown(trimmed) === trimmed
}

/**
 * Message-global structure-safe prefix. Lists/tables stay on completed-line
 * boundaries; paragraphs/headings reveal by the adaptive word-snapped cursor.
 * Code remains an intentional atomic unit (the controller snaps its cursor to
 * the current target once the opening fence reaches the frontier).
 */
export function safeMessageSlice(
  content: string,
  revealedGraphemes: number,
  isComplete = false,
  cachedGraphemes?: readonly string[],
  releaseTrailingFragment = false
): string {
  const graphemes = cachedGraphemes ?? toGraphemes(content)
  const cursor = Math.max(0, Math.min(graphemes.length, Math.floor(revealedGraphemes)))
  const candidate = graphemes.slice(0, cursor).join('')
  if (!candidate || (isComplete && cursor >= graphemes.length)) return candidate
  const split = splitMarkdownIntoBlocks(candidate)
  const tail = split.tail
  if (!tail) return candidate

  // The splitter intentionally normalises away one trailing newline on the
  // live tail. Locate its literal suffix instead of subtracting raw.length,
  // otherwise `- one\n- two\n` can duplicate a marker or hide a completed row.
  const locatedTailStart = tail.raw ? candidate.lastIndexOf(tail.raw) : candidate.length
  const tailStart = locatedTailStart >= 0 ? locatedTailStart : candidate.length - tail.raw.length
  const literalTail = candidate.slice(tailStart)

  if (tail.type === 'paragraph' || tail.type === 'heading') {
    if (AMBIGUOUS_LIST_MARKER_RE.test(literalTail)) return candidate.slice(0, tailStart)
    const proseLines = literalTail.split('\n')
    const firstLine = proseLines[0]
    const tableShapedFrontier =
      /^\s*\|/u.test(firstLine) ||
      (firstLine.includes('|') && /^\s*\|?\s*:?-{2,}/u.test(proseLines[1] ?? ''))
    if (tail.type === 'paragraph' && tableShapedFrontier) {
      return candidate.slice(0, tailStart)
    }

    // Scripts without whitespace need the grapheme controller rather than an
    // English-centric "wait for a space" rule. The inline-syntax trim still
    // prevents unfinished markdown from being exposed.
    if (!/\s/u.test(literalTail) && NO_SPACE_SCRIPT_RE.test(literalTail)) {
      return candidate.slice(0, tailStart) + trimIncompleteInlineMarkdown(literalTail)
    }
    if (releaseTrailingFragment && canReleaseTrailingFragment(literalTail)) {
      return candidate.slice(0, tailStart) + trimIncompleteInlineMarkdown(literalTail)
    }

    const nextGrapheme = graphemes[cursor]
    if (/\s$/u.test(literalTail) || (nextGrapheme !== undefined && /^\s$/u.test(nextGrapheme))) {
      return candidate.slice(0, tailStart) + trimIncompleteInlineMarkdown(literalTail)
    }
    // A provider delta often ends in the middle of its newest word. Rendering
    // that fragment and then remounting the completed word is the occasional
    // flash users perceive. Hold only that final fragment; settled words remain
    // visible and the terminal frame still reveals the last word in full.
    let lastWhitespaceEnd = 0
    for (const match of literalTail.matchAll(/\s+/gu)) {
      lastWhitespaceEnd = (match.index ?? 0) + match[0].length
    }
    if (lastWhitespaceEnd === 0 && graphemeCount(literalTail) > 24) {
      const bounded = toGraphemes(literalTail).slice(0, -6).join('')
      return candidate.slice(0, tailStart) + trimIncompleteInlineMarkdown(bounded)
    }
    return (
      candidate.slice(0, tailStart) +
      trimIncompleteInlineMarkdown(literalTail.slice(0, lastWhitespaceEnd))
    )
  }

  if (tail.type === 'code') return candidate
  const safeTail = safeTailSlice(literalTail, tail.type, graphemeCount(literalTail))
  if (tail.type === 'table' && (safeTail.match(/\n/g)?.length ?? 0) < 2) {
    return candidate.slice(0, tailStart)
  }
  return candidate.slice(0, tailStart) + safeTail
}

export interface FencedCodeRange {
  start: number
  end: number
}

function fenceMarker(line: string): string | null {
  const match = /^\s*([`~]{3,})/.exec(line)
  return match?.[1] ?? null
}

/** Grapheme ranges for every closed or active fenced block in the target. */
export function fencedCodeRanges(
  content: string,
  cachedGraphemes?: readonly string[]
): FencedCodeRange[] {
  const codeUnitRanges: Array<{ start: number; end: number }> = []
  let lineStart = 0
  let fenceStart: number | null = null
  let activeMarker: string | null = null

  while (lineStart < content.length) {
    const newline = content.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? content.length : newline + 1
    const line = content.slice(lineStart, newline < 0 ? lineEnd : newline)
    const marker = fenceMarker(line)

    if (!activeMarker && marker) {
      activeMarker = marker
      fenceStart = lineStart
    } else if (
      activeMarker &&
      marker &&
      marker[0] === activeMarker[0] &&
      marker.length >= activeMarker.length
    ) {
      codeUnitRanges.push({ start: fenceStart ?? lineStart, end: lineEnd })
      activeMarker = null
      fenceStart = null
    }
    lineStart = lineEnd
  }

  if (activeMarker && fenceStart !== null) {
    codeUnitRanges.push({ start: fenceStart, end: content.length })
  }

  const graphemes = cachedGraphemes ?? toGraphemes(content)
  const graphemeByCodeUnit = new Map<number, number>([[0, 0]])
  let codeUnitOffset = 0
  for (let index = 0; index < graphemes.length; index += 1) {
    codeUnitOffset += graphemes[index].length
    graphemeByCodeUnit.set(codeUnitOffset, index + 1)
  }
  return codeUnitRanges.map((range) => ({
    start: graphemeByCodeUnit.get(range.start) ?? 0,
    end: graphemeByCodeUnit.get(range.end) ?? graphemes.length
  }))
}

/** Backwards-compatible helper retained for focused tests/callers. */
export function activeCodeTailStart(content: string): number | null {
  const tail = splitMarkdownIntoBlocks(content).tail
  if (!tail || tail.type !== 'code') return null
  const tailStart = Math.max(0, content.lastIndexOf(tail.raw))
  return graphemeCount(content.slice(0, tailStart))
}

type RevealCssProperties = CSSProperties & {
  '--stream-reveal-duration': string
}

function RevealingMarkdownMessageImpl({
  content,
  chat,
  isLive,
  messageId,
  messageTimestamp,
  provider,
  model,
  reduceMotion,
  mediaRefs,
  workspacePath,
  onPreviewImage,
  streamRunId,
  onRevealUnmounted
}: RevealingMarkdownMessageProps) {
  const targetGraphemes = useMemo(() => toGraphemes(content), [content])
  const targetLen = targetGraphemes.length
  const codeRanges = useMemo(
    () => fencedCodeRanges(content, targetGraphemes),
    [content, targetGraphemes]
  )
  const cadencePrior = useMemo(() => readRevealCadencePrior(provider, model), [provider, model])
  const sessionKey = useMemo(
    () => revealSessionKey({ chatId: chat?.appChatId, messageId, streamRunId }),
    [chat?.appChatId, messageId, streamRunId]
  )

  const [initialReveal] = useState(() => {
    const resumed = readRevealSession(sessionKey, content, targetGraphemes)
    if (resumed) return resumed
    const revealed = isLive && isFreshLiveMount(messageTimestamp) ? 0 : targetLen
    return { revealed, state: createAdaptiveRevealState(revealed), resumed: false as const }
  })
  const [revealedLen, setRevealedLen] = useState(initialReveal.revealed)
  const paintedRevealedRef = useRef(initialReveal.revealed)
  const controllerRef = useRef(initialReveal.state)
  const [initialCadenceTracker] = useState(() =>
    createRevealCadenceTracker(
      initialReveal.resumed || initialReveal.revealed > 0 ? targetLen : 0,
      cadencePrior
    )
  )
  const cadenceRef = useRef({ ...initialCadenceTracker })
  const [hasBeenLive, setHasBeenLive] = useState(isLive || initialReveal.resumed)
  const [tokenFadeEnabled] = useState(
    () => !initialReveal.resumed && initialReveal.revealed === 0
  )
  const [settled, setSettled] = useState(false)
  const reduced = useReducedMotionPreference(reduceMotion, !settled)
  const [presentation, setPresentation] = useState(() =>
    resolveAdaptiveRevealPresentation(revealCadenceSnapshot(initialCadenceTracker))
  )
  const [releaseTrailingFragment, setReleaseTrailingFragment] = useState(false)
  const paintElapsedRef = useRef(0)
  const previousTargetGraphemesRef = useRef(targetGraphemes)
  const previousTargetContentRef = useRef(content)
  const previousCadenceContentRef = useRef('')
  const cadenceRecordedRef = useRef(false)
  const hasEverBeenLiveRef = useRef(isLive || initialReveal.resumed)
  const wasLiveRef = useRef(isLive)
  const settleNotifiedRef = useRef(false)
  const contentRef = useRef(content)
  const isLiveRef = useRef(isLive)
  const revealLifecycleRef = useRef(isLive || initialReveal.resumed)
  const sessionKeyRef = useRef(sessionKey)
  const onRevealUnmountedRef = useRef(onRevealUnmounted)
  const cadenceIdentityRef = useRef({ provider, model })
  contentRef.current = content
  isLiveRef.current = isLive
  revealLifecycleRef.current = isLive || hasBeenLive
  sessionKeyRef.current = sessionKey
  onRevealUnmountedRef.current = onRevealUnmounted
  cadenceIdentityRef.current = { provider, model }

  const recordCadenceRef = useRef<() => void>(() => undefined)
  recordCadenceRef.current = () => {
    if (cadenceRecordedRef.current || !hasEverBeenLiveRef.current) return
    const cadence = revealCadenceSnapshot(cadenceRef.current)
    const freshSampleCount = cadence.sampleCount - initialCadenceTracker.sampleCount
    if (freshSampleCount <= 0) return
    cadenceRecordedRef.current = true
    const identity = cadenceIdentityRef.current
    recordRevealCadencePrior(identity.provider, identity.model, {
      ...cadence,
      sampleCount: freshSampleCount
    })
  }

  useLayoutEffect(() => {
    const previousTarget = previousTargetGraphemesRef.current
    const appendOnly = content.startsWith(previousTargetContentRef.current)
    const commonPrefix = appendOnly
      ? previousTarget.length
      : commonGraphemePrefixLength(previousTarget, targetGraphemes)
    if (
      commonPrefix < controllerRef.current.revealed ||
      commonPrefix < paintedRevealedRef.current
    ) {
      controllerRef.current = createAdaptiveRevealState(commonPrefix)
      paintedRevealedRef.current = Math.min(paintedRevealedRef.current, commonPrefix)
      setRevealedLen(paintedRevealedRef.current)
    }
    previousTargetGraphemesRef.current = targetGraphemes
    previousTargetContentRef.current = content

    if (isLive || wasLiveRef.current) {
      hasEverBeenLiveRef.current = true
      const cadenceAppendOnly = content.startsWith(previousCadenceContentRef.current)
      cadenceRef.current = observeRevealTarget(cadenceRef.current, targetLen, monotonicNow(), {
        appendOnly: cadenceAppendOnly
      })
      previousCadenceContentRef.current = content
      const nextPresentation = resolveAdaptiveRevealPresentation(
        revealCadenceSnapshot(cadenceRef.current)
      )
      setPresentation((current) =>
        current.band === nextPresentation.band ? current : nextPresentation
      )
      if (!settleNotifiedRef.current) {
        writeRevealSession(
          sessionKey,
          content,
          controllerRef.current,
          paintedRevealedRef.current
        )
      }
    }
  }, [content, isLive, sessionKey, targetGraphemes, targetLen])

  useEffect(() => {
    if (isLive) {
      hasEverBeenLiveRef.current = true
      setHasBeenLive(true)
    }
    if (wasLiveRef.current && !isLive) {
      recordCadenceRef.current()
    }
    wasLiveRef.current = isLive
  }, [isLive, sessionKey])

  useEffect(() => {
    if (!content) {
      setReleaseTrailingFragment(false)
      return
    }
    // Keep an already-released fragment visible during terminal drain. Resetting
    // it at the live→complete edge would briefly retract the partial word until
    // the terminal cursor catches up.
    if (!isLive) return
    if (/\s$/u.test(content)) {
      if (releaseTrailingFragment) setReleaseTrailingFragment(false)
      return
    }
    if (releaseTrailingFragment) return
    const quietDelay = Math.max(140, Math.min(260, cadenceRef.current.averageGapMs * 1.8))
    const timer = window.setTimeout(() => setReleaseTrailingFragment(true), quietDelay)
    return () => window.clearTimeout(timer)
  }, [content, isLive, releaseTrailingFragment])

  useEffect(() => {
    return () => {
      recordCadenceRef.current()
      if (revealLifecycleRef.current && !settleNotifiedRef.current) {
        writeRevealSession(
          sessionKeyRef.current,
          contentRef.current,
          controllerRef.current,
          paintedRevealedRef.current
        )
      }
      if (settleNotifiedRef.current) onRevealUnmountedRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (isLive || revealedLen < targetLen || settleNotifiedRef.current) return
    const delay = hasBeenLive && tokenFadeEnabled ? presentation.fadeDurationMs + 40 : 0
    const timer = window.setTimeout(() => {
      settleNotifiedRef.current = true
      clearRevealSession(sessionKey)
      setSettled(true)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [hasBeenLive, isLive, presentation.fadeDurationMs, revealedLen, sessionKey, targetLen, tokenFadeEnabled])

  // Static/history mounts and reduced-motion paths are immediate. A component
  // that was live is exempt: it must stay mounted long enough to terminal-drain.
  useEffect(() => {
    if (!reduced && (isLive || hasBeenLive)) return
    controllerRef.current = createAdaptiveRevealState(targetLen)
    paintedRevealedRef.current = targetLen
    if (revealedLen !== targetLen) setRevealedLen(targetLen)
  }, [hasBeenLive, isLive, reduced, revealedLen, targetLen])

  const revealLifecycleActive = isLive || hasBeenLive
  const animationActive = !reduced && revealLifecycleActive && revealedLen < targetLen

  useRevealClock((dt) => {
    const cadence = revealCadenceSnapshot(cadenceRef.current)
    let next = advanceAdaptiveReveal({
      state: controllerRef.current,
      target: content,
      targetGraphemes,
      cadence,
      dt,
      isComplete: !isLive
    })

    // Preserve the existing safety/performance invariant: never feed a partial
    // fenced block through the highlighter. Once its opener reaches the visual
    // frontier, reveal the current code target atomically.
    const enteredCodeRange = codeRanges.find(
      (range) => next.revealed >= range.start && next.revealed < range.end
    )
    if (enteredCodeRange) {
      const atomicAdvance = enteredCodeRange.end - next.revealed
      next = {
        ...next,
        revealed: enteredCodeRange.end,
        credit: Math.max(-16, next.credit - atomicAdvance)
      }
    }

    controllerRef.current = next
    paintElapsedRef.current += dt
    const paintInterval = 1 / presentation.maxPaintFps
    const mustCommit =
      next.revealed >= targetGraphemes.length || paintElapsedRef.current >= paintInterval
    if (mustCommit) {
      paintElapsedRef.current =
        next.revealed >= targetGraphemes.length
          ? 0
          : Math.max(0, paintElapsedRef.current - paintInterval)
      if (next.revealed !== paintedRevealedRef.current) {
        paintedRevealedRef.current = next.revealed
        setRevealedLen(next.revealed)
      }
      if (revealLifecycleActive && !settleNotifiedRef.current) {
        writeRevealSession(sessionKey, content, next, paintedRevealedRef.current)
      }
    }
  }, animationActive)

  const projectedDisplayContent =
    !reduced && revealLifecycleActive
      ? safeMessageSlice(
          content,
          revealedLen,
          !isLive,
          targetGraphemes,
          releaseTrailingFragment
        )
      : content
  const monotonicProjectionRef = useRef({ content, displayContent: projectedDisplayContent })
  const previousProjection = monotonicProjectionRef.current
  const appendOnlyProjection = content.startsWith(previousProjection.content)
  const displayContent =
    appendOnlyProjection && !projectedDisplayContent.startsWith(previousProjection.displayContent)
      ? previousProjection.displayContent
      : projectedDisplayContent
  monotonicProjectionRef.current = { content, displayContent }
  const { stable, tail } = useMemo(() => splitMarkdownIntoBlocks(displayContent), [displayContent])
  const displayBlocks = useMemo(() => (tail ? [...stable, tail] : stable), [stable, tail])
  const revealing = !reduced && revealLifecycleActive && revealedLen < targetLen
  const revealStyle: RevealCssProperties = {
    '--stream-reveal-duration': `${presentation.fadeDurationMs}ms`
  }

  const mediaCtx = useStableMarkdownMediaValue(mediaRefs, workspacePath, onPreviewImage)
  const identityCtxRef = useRef(chat)
  if (!identityContextEqual(identityCtxRef.current, chat)) {
    identityCtxRef.current = chat
  }

  return (
    <AgentIdentityContext.Provider value={identityCtxRef.current}>
      <MarkdownMediaContext.Provider value={mediaCtx}>
        <div
          className={`message-markdown message-markdown-pro stream-reveal-message speed-${presentation.band}`}
          data-reveal-speed={presentation.band}
          data-reveal-active={revealing ? 'true' : 'false'}
          aria-busy={isLive || revealing ? 'true' : undefined}
          style={revealStyle}
        >
          {displayBlocks.map((block, index) => (
            <StableMarkdownBlock
              key={`block-${index}`}
              raw={block.raw}
              streamRunId={streamRunId}
              revealTokens={
                tokenFadeEnabled &&
                !reduced &&
                revealLifecycleActive &&
                index >= displayBlocks.length - 2 &&
                (block.type === 'paragraph' || block.type === 'heading')
              }
              animatedWordWindow={presentation.animatedWordWindow}
              revealDurationMs={presentation.fadeDurationMs}
            />
          ))}
        </div>
      </MarkdownMediaContext.Provider>
    </AgentIdentityContext.Provider>
  )
}

export const RevealingMarkdownMessage = memo(RevealingMarkdownMessageImpl)

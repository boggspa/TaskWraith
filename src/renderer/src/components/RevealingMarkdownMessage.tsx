import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AgentIdentityContext } from './AgentIdentityContext'
import { MarkdownMediaContext } from './MarkdownMediaContext'
import { useStableMarkdownMediaValue } from './MarkdownMessage'
import { StableMarkdownBlock } from './StableMarkdownBlock'
import { splitMarkdownIntoBlocks, type MarkdownBlockType } from '../lib/MarkdownBlockSplit'
import { advanceReveal, graphemeCount, sliceGraphemes } from '../lib/advanceReveal'
import { REVEAL_PARAMS } from '../../../shared/revealParams'
import { useRevealClock } from '../lib/useRevealClock'
import type { ChatMediaRef } from './ChatMediaPanel'
import type { ChatRecord } from '../../../main/store/types'

/*
 * RevealingMarkdownMessage — the Electron type-out (Variant B), the live
 * counterpart to MarkdownMessage. It reuses the same block split + memoised
 * blocks, but the trailing TAIL block reveals progressively: a display-only
 * grapheme cursor (advanceReveal, the SHARED cross-platform spec) grows the
 * rendered slice over time, so the bubble grows in height as words materialise
 * — scroll code is untouched (Variant B keeps DOM height == revealed content).
 *
 * Gate-safe by construction: the cursor is display-only and never touches the
 * chat record / chatByIdRef, so the token-drop gate is unaffected and the final
 * rendered text equals the full content (when isLive flips false the parent
 * swaps back to the plain MarkdownMessage, which renders everything).
 *
 * Markdown safety: the full content is split ONCE; stable blocks render solid;
 * only the tail slices, snapped to a structure-safe boundary (paragraphs/
 * headings word-reveal; lists/tables reveal whole completed lines; code is
 * instant — never a partial Lezer parse). The newest text gets a soft opacity
 * fade via a CSS mask edge (no per-grapheme spans).
 */

interface RevealingMarkdownMessageProps {
  content: string
  chat?: ChatRecord
  /** True while this is the live, streaming last-assistant bubble. */
  isLive: boolean
  /** Override; defaults to the OS / in-app reduced-motion setting. */
  reduceMotion?: boolean
  /** This message's media refs, used to replace inline `![]()` placeholders. */
  mediaRefs?: readonly ChatMediaRef[]
  /** Chat workspace path, used to resolve relative markdown image paths. */
  workspacePath?: string
  /** When provided, inline images open the full-size preview overlay on click. */
  onPreviewImage?: (ref: ChatMediaRef) => void
}

function prefersReducedMotion(): boolean {
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

/** Structure-safe display slice of the tail — never ends mid-markdown-token. */
export function safeTailSlice(
  tailRaw: string,
  tailType: MarkdownBlockType,
  revealedGraphemes: number
): string {
  if (tailType === 'code') return tailRaw // code reveals instantly (no partial Lezer)
  const slice = sliceGraphemes(tailRaw, revealedGraphemes)
  if (tailType === 'paragraph' || tailType === 'heading') return slice
  // list / table / other: cut to the last completed line so a half-row/item
  // never parses as the wrong block then flips its classification on completion.
  const nl = slice.lastIndexOf('\n')
  return nl >= 0 ? slice.slice(0, nl + 1) : ''
}

function RevealingMarkdownMessageImpl({
  content,
  chat,
  isLive,
  reduceMotion,
  mediaRefs,
  workspacePath,
  onPreviewImage
}: RevealingMarkdownMessageProps) {
  const { stable, tail } = useMemo(() => splitMarkdownIntoBlocks(content), [content])
  const tailRaw = tail?.raw ?? ''
  const tailType: MarkdownBlockType = tail?.type ?? 'paragraph'
  const isCode = tailType === 'code'
  const targetLen = graphemeCount(tailRaw)

  const reduced = reduceMotion ?? prefersReducedMotion()
  const animate = isLive && !reduced && !isCode

  // Cursor (graphemes into the tail). Cold-snap a large pre-existing tail at
  // mount so enabling the reveal mid-stream doesn't re-type everything.
  const [revealedLen, setRevealedLen] = useState(() =>
    targetLen > REVEAL_PARAMS.coldSnapChars ? targetLen : 0
  )
  const revealedRef = useRef(revealedLen)
  revealedRef.current = revealedLen
  const targetRawRef = useRef(tailRaw)
  targetRawRef.current = tailRaw
  const prevRawRef = useRef(tailRaw)
  const liveRef = useRef(isLive)
  liveRef.current = isLive

  // Non-animated paths (reduced motion / code / not live): show the full tail.
  useEffect(() => {
    if (!animate) {
      prevRawRef.current = tailRaw
      if (revealedRef.current !== targetLen) setRevealedLen(targetLen)
    }
  }, [animate, tailRaw, targetLen])

  useRevealClock((dt) => {
    const next = advanceReveal({
      prev: prevRawRef.current,
      next: targetRawRef.current,
      revealed: revealedRef.current,
      isComplete: !liveRef.current,
      dt
    })
    prevRawRef.current = targetRawRef.current
    if (next !== revealedRef.current) {
      revealedRef.current = next
      setRevealedLen(next)
    }
  }, animate)

  const displayRaw = animate ? safeTailSlice(tailRaw, tailType, revealedLen) : tailRaw
  const revealing = animate && revealedLen < targetLen
  // Soft opacity edge on the newest line while revealing (CSS mask, no spans).
  const tailStyle = revealing
    ? {
        WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 1.1em), transparent)',
        maskImage: 'linear-gradient(to bottom, #000 calc(100% - 1.1em), transparent)'
      }
    : undefined

  // Stabilise the media context across the per-delta re-renders so inline
  // images (if any are present on a live message) don't re-resolve every frame.
  const mediaCtx = useStableMarkdownMediaValue(mediaRefs, workspacePath, onPreviewImage)

  return (
    <AgentIdentityContext.Provider value={chat}>
      <MarkdownMediaContext.Provider value={mediaCtx}>
        <div className="message-markdown message-markdown-pro">
          {stable.map((block, index) => (
            <StableMarkdownBlock key={`${index}-${block.id}`} raw={block.raw} />
          ))}
          {tail ? (
            <div style={tailStyle}>
              <StableMarkdownBlock key={`tail-${stable.length}`} raw={displayRaw} />
            </div>
          ) : null}
        </div>
      </MarkdownMediaContext.Provider>
    </AgentIdentityContext.Provider>
  )
}

export const RevealingMarkdownMessage = memo(RevealingMarkdownMessageImpl)

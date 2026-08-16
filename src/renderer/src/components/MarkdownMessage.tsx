import { memo, useMemo, useRef } from 'react'
import { AgentIdentityContext } from './AgentIdentityContext'
import { MarkdownMediaContext, type MarkdownMediaContextValue } from './MarkdownMediaContext'
import {
  MarkdownCommitReferenceContext,
  useMarkdownCommitReferenceValue
} from './MarkdownCommitReferenceContext'
import {
  PROJECT_REFERENCE_CITATION_LINK_PREFIX,
  ProjectReferenceCitationContext
} from './ProjectReferenceCitationContext'
import { StableMarkdownBlock } from './StableMarkdownBlock'
import { splitMarkdownIntoBlocks } from '../lib/MarkdownBlockSplit'
import { deepEqual } from '../lib/messagesRenderEqual'
import {
  prepareProjectReferenceCitationsForRender,
  type ProjectReferenceCitationOpenTarget
} from '../lib/projectReferenceCitations'
import {
  PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER,
  PROJECT_REFERENCE_CITATION_OPEN,
  type ProjectReferenceCitationExtractResolution
} from '../../../shared/projectReferenceCitation'
import type { ChatMediaRef } from './ChatMediaPanel'
import type { ChatRecord } from '../../../main/store/types'

/** Turn `\uFFFC` chip slots into indexed markdown links StableMarkdownBlock can chip-render. */
export function embedProjectReferenceCitationLinks(displayText: string): string {
  let index = 0
  return displayText.split(PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER).reduce((acc, part, i) => {
    if (i === 0) return part
    const link = `[§](${PROJECT_REFERENCE_CITATION_LINK_PREFIX}${index++})`
    return acc + link + part
  }, '')
}

interface MarkdownMessageProps {
  content: string
  /** Render raw HTML only after conservative sanitisation. Off by default. */
  allowSafeHtml?: boolean
  /** Chat used to look up subagent identities for `[@Name](agent://id)` chips. */
  chat?: ChatRecord
  /** This message's media refs, used to replace inline `![]()` placeholders with
   *  the safe bounded thumbnail. Omitted for callsites with no transcript media. */
  mediaRefs?: readonly ChatMediaRef[]
  /** Chat workspace path, used to resolve relative markdown image paths. */
  workspacePath?: string
  /** When provided, inline images open the full-size preview overlay on click. */
  onPreviewImage?: (ref: ChatMediaRef) => void
  /** Run id for stream render instrumentation. */
  streamRunId?: string
  /**
   * Resolve consentful extract text for `⟦pref:…⟧` citation chips. When omitted
   * (or a reference is unknown), chips still render in a degraded form labelled
   * with the referenceId.
   */
  resolveProjectReferenceExtract?: (
    referenceId: string
  ) => ProjectReferenceCitationExtractResolution | null
  /** Optional Refs-viewer open handler for citation chip clicks. */
  onOpenProjectReferenceCitation?: (target: ProjectReferenceCitationOpenTarget) => void
}

/**
 * A cheap, stable signature of the slices of `mediaRefs` that affect inline
 * image rendering: identity, status, the two path keys we match on, and the
 * thumbnail payload size (a content swap re-hashes the id, but the length guards
 * the rare same-id/new-bytes case). Drives BOTH the context-stabilising ref and
 * `propsAreEqual`, so a no-op broadcast never re-renders the inline images while
 * a new/updated thumbnail always does. Only image refs participate.
 */
export function markdownMediaSignature(
  refs: readonly ChatMediaRef[] | undefined,
  workspacePath?: string
): string {
  let sig = workspacePath ? `ws:${workspacePath};` : ''
  if (!refs) return sig
  for (const ref of refs) {
    if (ref.kind !== 'image') continue
    sig += `${ref.id}|${ref.status || ''}|${ref.path || ''}|${ref.workspaceRelativePath || ''}|${
      ref.thumbnail?.mimeType || ''
    }|${ref.thumbnail?.dataBase64?.length ?? 0};`
  }
  return sig
}

/**
 * Build the (identity-stable) MarkdownMediaContext value. The value object is
 * swapped only when the render-relevant ref slice OR the presence of a preview
 * handler changes, so streaming re-renders leave the inline images untouched.
 * `onPreviewImage` is wrapped behind a ref so the value stays stable even when
 * the parent passes a fresh handler each render. Shared by MarkdownMessage and
 * RevealingMarkdownMessage so the two can never drift.
 */
export function useStableMarkdownMediaValue(
  mediaRefs: readonly ChatMediaRef[] | undefined,
  workspacePath: string | undefined,
  onPreviewImage: ((ref: ChatMediaRef) => void) | undefined
): MarkdownMediaContextValue | undefined {
  const onPreviewRef = useRef(onPreviewImage)
  onPreviewRef.current = onPreviewImage
  const previewCbRef = useRef<((ref: ChatMediaRef) => void) | undefined>(undefined)
  if (!previewCbRef.current) {
    previewCbRef.current = (ref: ChatMediaRef) => onPreviewRef.current?.(ref)
  }
  const hasPreview = Boolean(onPreviewImage)
  const key = `${hasPreview ? '1' : '0'}|${markdownMediaSignature(mediaRefs, workspacePath)}`
  const keyRef = useRef<string | null>(null)
  const valueRef = useRef<MarkdownMediaContextValue | undefined>(undefined)
  if (keyRef.current !== key) {
    keyRef.current = key
    valueRef.current =
      mediaRefs && mediaRefs.some((ref) => ref.kind === 'image')
        ? {
            refs: mediaRefs,
            workspacePath,
            ...(hasPreview ? { onPreviewImage: previewCbRef.current } : {})
          }
        : undefined
  }
  return valueRef.current
}

/**
 * MarkdownMessage — orchestrator for streaming-friendly markdown.
 *
 * Phase L1a refactor. The renderer is now block-aware:
 *
 *   1. We split `content` into stable blocks + an optional tail via
 *      `splitMarkdownIntoBlocks` (pure string scan, no mdast).
 *   2. Each stable block goes through `StableMarkdownBlock`, keyed by
 *      `<index>-<content-hash>`. That subtree is `React.memo`'d on `raw`,
 *      so a parent re-render driven by `assistant_message_delta` only
 *      diffs the tail.
 *   3. The tail is rendered through the same memoised component, keyed
 *      by `tail-<stable.length>` (the "tail" prefix avoids colliding
 *      with the numeric stable-index keys). The key changes ONLY when a
 *      block commits to the stable prefix (stable.length grows), so
 *      across the deltas that grow a single block the tail re-renders
 *      IN PLACE instead of unmount/remount. That lets a streaming code
 *      fence reuse its CodeMirror EditorView (a cheap per-delta doc
 *      transaction) instead of destroying + recreating the whole view
 *      every keystroke. The stable prefix survives unchanged.
 *      (Was `tail-<content-hash>`, which rolled every keystroke and
 *      forced a full remount of the tail subtree per delta.)
 *
 * Position-aware keys (the `<index>-` prefix) fix a class of bugs where
 * two blocks within the SAME message share identical raw content —
 * most prominently the `\n\n---\n\n` horizontal-rule separators K2 (b)
 * injects between Codex item transitions. With pure content-hash keys,
 * a message containing two `---` blocks (e.g. body + summary + extra
 * agentMessage in one turn) produced two siblings with the SAME React
 * key; React's prod reconciler silently merged them, leaving the
 * rendered transcript missing chars / words and shuffled — the
 * "Route 120-second MCP I'm rer..." style garbling observed on Codex.
 * Including the position guarantees siblings always have distinct keys
 * regardless of content collisions. The `React.memo` short-circuit on
 * `raw` is preserved because position is stable for stable blocks
 * across append-only re-renders.
 *
 * The output HTML is byte-for-byte identical to the pre-L1a renderer
 * for any complete (non-streaming) message — the existing snapshot
 * tests verify that. The win is paid for entirely by the streaming
 * path; for a 5K-token reply we go from N parses per delta (where N
 * is total token count) to roughly 1 parse per delta (just the tail).
 *
 * The `AgentIdentityContext.Provider` wraps the whole markdown subtree
 * so `<AgentMention>` chips in any block can look up the chat's
 * identity registry without prop drilling.
 */
/**
 * The chat slices the markdown subtree's context consumers actually render
 * from. There are exactly two: `AgentMention` reads
 * `providerMetadata.agentIdentities`, and `ParticipantMention` reads
 * `ensemble.participants` (only `id`/`role`/`provider`/`model` — which drive
 * the chip's name, alias matching, and provider/brand tint — NOT the
 * per-participant `tokenTotals`/status, which churn on every IPC broadcast).
 * Compared BY VALUE so a no-op broadcast is
 * skipped but a chip refreshes the instant its identity, role, or provider
 * changes (e.g. a Boss replace/reorder or a roster edit mid-stream).
 *
 * This single predicate gates BOTH `propsAreEqual` and the `ctxRef` swap below,
 * so they can never diverge — a divergence would either skip a render while the
 * cached context differs (stale chip) or swap the context without re-rendering
 * the consumers (no visible effect).
 */
export function participantsChipEqual(
  a: ReadonlyArray<{ id: string; role: string; provider: string; model?: string }> | undefined,
  b: ReadonlyArray<{ id: string; role: string; provider: string; model?: string }> | undefined
): boolean {
  if (a === b) return true
  const aLen = a?.length ?? 0
  const bLen = b?.length ?? 0
  if (aLen !== bLen) return false
  for (let i = 0; i < aLen; i += 1) {
    const pa = a![i]
    const pb = b![i]
    if (
      pa.id !== pb.id ||
      pa.role !== pb.role ||
      pa.provider !== pb.provider ||
      pa.model !== pb.model
    ) {
      return false
    }
  }
  return true
}

export function identityContextEqual(
  a: ChatRecord | undefined,
  b: ChatRecord | undefined
): boolean {
  if (a?.appChatId !== b?.appChatId) return false
  if (!deepEqual(a?.providerMetadata?.agentIdentities, b?.providerMetadata?.agentIdentities)) {
    return false
  }
  return participantsChipEqual(a?.ensemble?.participants, b?.ensemble?.participants)
}

function MarkdownMessageImpl({
  content,
  chat,
  mediaRefs,
  workspacePath,
  onPreviewImage,
  streamRunId,
  allowSafeHtml = false,
  resolveProjectReferenceExtract,
  onOpenProjectReferenceCitation
}: MarkdownMessageProps) {
  const resolveExtractRef = useRef(resolveProjectReferenceExtract)
  resolveExtractRef.current = resolveProjectReferenceExtract
  const onOpenCitationRef = useRef(onOpenProjectReferenceCitation)
  onOpenCitationRef.current = onOpenProjectReferenceCitation

  const projectReferenceCitations = useMemo(() => {
    if (allowSafeHtml || !content.includes(PROJECT_REFERENCE_CITATION_OPEN)) return null
    return prepareProjectReferenceCitationsForRender({
      assistantText: content,
      resolveExtract: (referenceId) => resolveExtractRef.current?.(referenceId) ?? null,
      degradeMissingExtracts: true
    })
  }, [allowSafeHtml, content])

  const markdownContent = useMemo(() => {
    if (!projectReferenceCitations) return content
    return embedProjectReferenceCitationLinks(projectReferenceCitations.displayText)
  }, [content, projectReferenceCitations])

  const citationContext = useMemo(() => {
    if (!projectReferenceCitations || projectReferenceCitations.citations.length === 0) {
      return null
    }
    return {
      citations: projectReferenceCitations.citations,
      ...(onOpenProjectReferenceCitation
        ? {
            onOpen: (target: ProjectReferenceCitationOpenTarget) =>
              onOpenCitationRef.current?.(target)
          }
        : {})
    }
  }, [projectReferenceCitations, onOpenProjectReferenceCitation])

  // useMemo the block split so a re-render NOT caused by a content change
  // (e.g. an identity-registry update) doesn't re-run the O(n) string scan.
  const blocks = useMemo(
    () => (allowSafeHtml ? null : splitMarkdownIntoBlocks(markdownContent)),
    [allowSafeHtml, markdownContent]
  )
  const stable = blocks?.stable || []
  const tail = blocks?.tail || null
  // Stabilise the context value across the churning `chat` reference. `chat`
  // is a NEW object on every coalesced flush / ensemble broadcast, but the
  // markdown subtree's context consumers (<AgentMention>, <ParticipantMention>)
  // only read the identity/participant slices captured by `identityContextEqual`.
  // Handing the Provider a new value every render forces every chip to re-render
  // even when nothing they read changed. Cache the chat reference and swap it
  // only when one of those slices actually changes (a render-phase memo via ref
  // — deterministic + idempotent under StrictMode), so the chips stay put while
  // a message streams.
  const ctxRef = useRef(chat)
  if (!identityContextEqual(ctxRef.current, chat)) {
    ctxRef.current = chat
  }
  // Stabilise the media-context value: swap it only when the inline-render-
  // relevant slice of the refs (or the preview-handler presence) actually
  // changes, so a streaming re-render leaves the inline images put.
  const mediaCtx = useStableMarkdownMediaValue(mediaRefs, workspacePath, onPreviewImage)
  const commitReferenceCtx = useMarkdownCommitReferenceValue({
    workspacePath,
    chatId: chat?.appChatId
  })
  return (
    <AgentIdentityContext.Provider value={ctxRef.current}>
      <MarkdownMediaContext.Provider value={mediaCtx}>
        <ProjectReferenceCitationContext.Provider value={citationContext}>
          <MarkdownCommitReferenceContext.Provider value={commitReferenceCtx}>
            <div className="message-markdown message-markdown-pro">
              {allowSafeHtml ? (
                <StableMarkdownBlock
                  key="safe-html"
                  raw={content}
                  streamRunId={streamRunId}
                  allowSafeHtml
                />
              ) : (
                <>
                  {stable.map((block, index) => (
                    <StableMarkdownBlock
                      key={`${index}-${block.id}`}
                      raw={block.raw}
                      streamRunId={streamRunId}
                    />
                  ))}
                  {tail ? (
                    <StableMarkdownBlock
                      key={`tail-${stable.length}`}
                      raw={tail.raw}
                      streamRunId={streamRunId}
                    />
                  ) : null}
                </>
              )}
            </div>
          </MarkdownCommitReferenceContext.Provider>
        </ProjectReferenceCitationContext.Provider>
      </MarkdownMediaContext.Provider>
    </AgentIdentityContext.Provider>
  )
}

// Re-render only when the rendered output can actually change: the markdown
// `content`, the chat scope (appChatId), or the identity registry that
// <AgentMention> reads (chat.providerMetadata.agentIdentities). The `chat` prop
// is the whole currentChat — a NEW object on every coalesced flush (#1) — so
// comparing it by reference would defeat the memo; we compare only the
// identity-relevant slice. This skips re-rendering every other visible message
// while one message streams, which is the win that compounds with #1.
function propsAreEqual(prev: MarkdownMessageProps, next: MarkdownMessageProps): boolean {
  // Compare the identity/participant slices BY VALUE, not by `chat` reference:
  // `providerMetadata` + `ensemble` are re-deserialised on every IPC broadcast,
  // so a reference check is always false during ensemble streaming and
  // re-renders every markdown row (re-creating its mention Provider) ~100×/sec
  // even when nothing the chips read has changed. The compared slices are
  // small, so the value compare is far cheaper than the re-render it prevents.
  return (
    prev.content === next.content &&
    prev.allowSafeHtml === next.allowSafeHtml &&
    identityContextEqual(prev.chat, next.chat) &&
    prev.streamRunId === next.streamRunId &&
    prev.resolveProjectReferenceExtract === next.resolveProjectReferenceExtract &&
    prev.onOpenProjectReferenceCitation === next.onOpenProjectReferenceCitation &&
    markdownMediaSignature(prev.mediaRefs, prev.workspacePath) ===
      markdownMediaSignature(next.mediaRefs, next.workspacePath)
  )
}

export const MarkdownMessage = memo(MarkdownMessageImpl, propsAreEqual)

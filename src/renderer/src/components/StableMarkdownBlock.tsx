import {
  createContext,
  Fragment,
  Profiler,
  memo,
  useContext,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type Options
} from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { HighlightedCodeBlock } from './HighlightedCodeBlock'
import { MarkdownChartBlock } from './MarkdownChartBlock'
import { AgentMention } from './AgentMention'
import { AgentIdentityContext } from './AgentIdentityContext'
import { ParticipantMention } from './ParticipantMention'
import { ProjectReferenceCitationChip } from './ProjectReferenceCitationChip'
import {
  PROJECT_REFERENCE_CITATION_LINK_PREFIX,
  ProjectReferenceCitationContext
} from './ProjectReferenceCitationContext'
import { SeatChangeInlineStrip } from './SeatChangeRow'
import { ParticipantStatusIcon } from './icons/ParticipantStatusIcon'
import { SEAT_CHANGE_LINK_PREFIX, decodeSeatChangeLink } from '../../../shared/seatChange'
import { FaviconLink } from './FaviconLink'
import { MarkdownMediaContext } from './MarkdownMediaContext'
import { MarkdownCommitReference } from './MarkdownCommitReference'
import { MarkdownColorToken } from './MarkdownColorToken'
import { classifyMarkdownLink } from '../lib/classifyMarkdownLink'
import { tokeniseMentions } from '../lib/mentionHighlight'
import { resolveInlineMarkdownImage } from '../lib/resolveMarkdownImageRef'
import { rehypeInlineMarkdownDiffStats } from '../lib/inlineMarkdownDiffStats'
import {
  normalizeInlineMarkdownColor,
  rehypeInlineMarkdownColorTokens
} from '../lib/inlineMarkdownColorTokens'
import {
  isInlineMarkdownCommitHash,
  rehypeInlineMarkdownCommitReferences
} from '../lib/inlineMarkdownCommitReferences'
import {
  recordStreamMarkdownRenderMetric,
  recordStreamReactCommitMetric
} from '../lib/streamRenderMetrics'
import { useCopyFeedback } from '../lib/useCopyFeedback'
import type { ChatRecord } from '../../../main/store/types'

/*
 * StableMarkdownBlock — a `React.memo`'d wrapper that renders ONE
 * markdown block through `ReactMarkdown`. The point of this component
 * is shallow-equality short-circuit on `raw`. The streaming hot path
 * (assistant_message_delta) appends chars to the tail block, which
 * remounts (new key), while every block above it sees the same `raw`
 * prop and skips its render entirely.
 *
 * The `chat` prop is supplied via context by the parent
 * (`AgentIdentityContext.Provider` in `MarkdownMessage`), so we do NOT
 * include it in the memo equality. Including it would defeat the
 * short-circuit when the parent chat reference changes for unrelated
 * reasons (e.g. settings toggle).
 */

interface MarkdownRevealContextValue {
  enabled: boolean
  animatedWordWindow: number
  existingWordCount: number
  existingDelayMs: number
  rawEndOffset: number
}

const STATIC_MARKDOWN_REVEAL: MarkdownRevealContextValue = {
  enabled: false,
  animatedWordWindow: 0,
  existingWordCount: 0,
  existingDelayMs: 0,
  rawEndOffset: 0
}

const MarkdownRevealContext = createContext<MarkdownRevealContextValue>(STATIC_MARKDOWN_REVEAL)

function MarkdownCodeBlock({ content, language }: { content: string; language?: string }) {
  const [wrap, setWrap] = useState(false)
  const { copiedId, copy } = useCopyFeedback()
  const displayLanguage = language?.trim() || 'text'

  const isShellLanguage = (lang?: string): boolean => {
    const normalized = (lang || '').trim().toLowerCase().replace(/^[.`]+|[.`]+$/g, '')
    return ['sh', 'bash', 'zsh', 'shell', 'terminal'].includes(normalized)
  }

  const handleRunCommand = () => {
    if (!isShellLanguage(language)) return
    const command = content.trim()
    if (!command) return
    const event = new CustomEvent('runCodeBlockCommand', {
      detail: { command: command + '\n' }
    })
    window.dispatchEvent(event)
  }

  return (
    <div className={`message-code-shell ${wrap ? 'wrap' : ''}`}>
      <div className="message-code-header">
        <span className="message-code-language">{displayLanguage}</span>
        <div className="message-code-actions">
          {isShellLanguage(language) && (
            <button
              type="button"
              className="message-code-action message-code-action-run"
              onClick={handleRunCommand}
              title="Run this command in the workspace terminal"
            >
              Run
            </button>
          )}
          <button
            type="button"
            className="message-code-action"
            onClick={() => setWrap((current) => !current)}
          >
            {wrap ? 'No wrap' : 'Wrap'}
          </button>
          <button
            type="button"
            className="message-code-action"
            onClick={() => copy('code', content)}
          >
            {copiedId === 'code' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div className="message-code-block">
        <HighlightedCodeBlock content={content} language={language} />
      </div>
    </div>
  )
}

/**
 * The shared ReactMarkdown components map. Lifted out of the per-block
 * component so we don't re-allocate a fresh object on every render —
 * a stable reference helps ReactMarkdown's internal memoisation too.
 *
 * Behaviour intentionally identical to the pre-L1a `MarkdownMessage`:
 *   - `a` routes external links through `classifyMarkdownLink` + the
 *     preload bridge instead of letting the BrowserWindow navigate
 *     (Phase K1 fix); `agent://` hrefs render as `<AgentMention>`
 *     chips, and local/path-like hrefs are visible but inert because
 *     transcript markdown is agent-authored content.
 *   - `pre` is collapsed — the `code` override owns the shell.
 *   - block `code` (any fenced or multi-line code) renders inside a
 *     `MarkdownCodeBlock` shell (header + copy + wrap toggle).
 *   - `input` is forced read-only so transcript checkboxes can't be
 *     ticked by the user.
 */
function revealWordCount(value: string): number {
  return value.split(/(\s+)/).reduce(
    (count, piece) => count + (piece.length > 0 && !/^\s+$/.test(piece) ? 1 : 0),
    0
  )
}

function revealNewestWords(
  value: string,
  reveal: MarkdownRevealContextValue,
  wordOffset: number,
  firstAnimatedWord: number
): ReactNode {
  if (!reveal.enabled || !value || reveal.animatedWordWindow <= 0) return value
  const pieces = value.split(/(\s+)/)
  let wordIndex = wordOffset
  return pieces.map((piece, pieceIndex) => {
    if (!piece || /^\s+$/.test(piece)) return piece
    const currentWordIndex = wordIndex++
    if (currentWordIndex < firstAnimatedWord) return piece
    return (
      <span
        className="stream-reveal-token"
        key={`reveal-word-${currentWordIndex}-${pieceIndex}`}
        style={
          currentWordIndex < reveal.existingWordCount && reveal.existingDelayMs < 0
            ? { animationDelay: `${reveal.existingDelayMs}ms` }
            : undefined
        }
      >
        {piece}
      </span>
    )
  })
}

function tokeniseParticipantMentions(
  value: string,
  chat: ChatRecord | undefined,
  reveal: MarkdownRevealContextValue,
  wordOffset: number,
  firstAnimatedWord: number
): ReactNode {
  if (!value || !value.includes('@')) {
    return revealNewestWords(value, reveal, wordOffset, firstAnimatedWord)
  }
  const segments = tokeniseMentions(value, chat?.ensemble?.participants ?? [])
  if (segments.length === 1 && segments[0].kind === 'text') return value
  const parts = segments.map((segment, index) => {
    if (segment.kind === 'text') return segment.text
    if (segment.kind === 'user-mention') {
      return (
        <ParticipantMention
          key={`pm-user-${index}-${segment.text}`}
          reference={segment.text.replace(/^@+/, '')}
          displayText={segment.text}
        >
          {segment.text}
        </ParticipantMention>
      )
    }
    if (segment.kind === 'group-mention') {
      return (
        <ParticipantMention
          key={`pm-group-${index}-${segment.group}`}
          reference={segment.text.replace(/^@+/, '')}
          displayText={segment.text}
        >
          {segment.text}
        </ParticipantMention>
      )
    }
    return (
      <ParticipantMention
        key={`pm-${index}-${segment.participant.id}`}
        reference={segment.participant.id}
        participant={segment.participant}
        displayText={segment.text}
      >
        {segment.text}
      </ParticipantMention>
    )
  })
  return (
    <>
      {parts.map((part, idx) => (
        <Fragment key={idx}>{part}</Fragment>
      ))}
    </>
  )
}

function processMarkdownMentionChildren(
  children: ReactNode,
  chat: ChatRecord | undefined,
  reveal: MarkdownRevealContextValue
): ReactNode {
  if (children === null || children === undefined) return children
  const childArray = Array.isArray(children) ? children : [children]
  const totalWords = childArray.reduce(
    (count, child) => count + (typeof child === 'string' ? revealWordCount(child) : 0),
    0
  )
  const firstAnimatedWord = Math.max(0, totalWords - reveal.animatedWordWindow)
  let wordOffset = 0
  if (typeof children === 'string') {
    return tokeniseParticipantMentions(children, chat, reveal, 0, firstAnimatedWord)
  }
  if (Array.isArray(children)) {
    return children.map((child, idx) => {
      if (typeof child !== 'string') return <Fragment key={idx}>{child}</Fragment>
      const childOffset = wordOffset
      wordOffset += revealWordCount(child)
      return (
        <Fragment key={idx}>
          {tokeniseParticipantMentions(
            child,
            chat,
            reveal,
            childOffset,
            firstAnimatedWord
          )}
        </Fragment>
      )
    })
  }
  return children
}

function ProcessedMarkdownChildren({
  children,
  allowReveal = false,
  nodeEndOffset = -1
}: {
  children: ReactNode
  allowReveal?: boolean
  nodeEndOffset?: number
}): ReactElement {
  const chat = useContext(AgentIdentityContext)
  const reveal = useContext(MarkdownRevealContext)
  const effectiveReveal =
    allowReveal && nodeEndOffset >= reveal.rawEndOffset ? reveal : STATIC_MARKDOWN_REVEAL
  return (
    <>{processMarkdownMentionChildren(children, chat, effectiveReveal)}</>
  )
}

/**
 * Inline image renderer for markdown `![alt](src)` nodes. Replaces the inert
 * placeholder with the SAFE bounded thumbnail when `src` resolves (by path) to
 * a persisted media ref the main process already produced. Reads
 * `MarkdownMediaContext` because the ReactMarkdown component override can't be
 * given props directly — and `StableMarkdownBlock` is memoised on `raw` alone,
 * so a ref prop would go stale. Context updates re-render this consumer through
 * the memo, which is exactly what we want when a thumbnail arrives post-persist.
 *
 * H4: the only `<img src>` ever emitted is a `data:` URL (see
 * `resolveInlineMarkdownImage`); the raw markdown src is never loaded. No
 * resolution → the original inert placeholder span.
 */
function InlineMarkdownImage({ src, alt }: { src?: string; alt?: string }): ReactNode {
  const media = useContext(MarkdownMediaContext)
  const trimmedAlt = typeof alt === 'string' ? alt.trim() : ''
  const label = trimmedAlt ? `Image: ${trimmedAlt}` : 'Image'
  const resolved =
    src && media ? resolveInlineMarkdownImage(src, media.refs, media.workspacePath) : null
  if (!resolved) {
    return (
      <span className="markdown-image-placeholder" role="note" aria-label={label}>
        {label}
      </span>
    )
  }
  const { ref } = resolved
  const image = (
    <img
      className="markdown-inline-image"
      src={resolved.thumbnail}
      alt={trimmedAlt || ref.name}
      title={ref.name}
      loading="lazy"
      decoding="async"
    />
  )
  const onPreview = media?.onPreviewImage
  if (!onPreview) return image
  // Clickable → full-size preview overlay (so dedup'ing the strip below loses
  // no affordance). Plain <img> when no preview handler is wired.
  return (
    <button
      type="button"
      className="markdown-inline-image-button"
      title={`Preview ${ref.name}`}
      aria-label={`Preview image ${ref.name}`}
      onClick={() => onPreview(ref)}
    >
      {image}
    </button>
  )
}

function CanvasLinkGlyph(): ReactNode {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** Only http(s) targets are previewable in a Canvas (validateCanvasUrl rejects
 *  everything else main-side anyway; this gates the affordance's visibility). */
function isCanvasOpenableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

/** Turn a raw canvas-open failure into a short reason for the affordance tooltip
 *  (mirrors CanvasComposerButton's helper; the most common case here is an
 *  SSRF-blocked private host or a dead URL). */
function friendlyCanvasError(raw: string | undefined): string {
  const msg = raw || 'Could not open in Canvas.'
  if (/CONNECTION_REFUSED|ERR_|NAME_NOT_RESOLVED|timed out/i.test(msg)) {
    return "Couldn't load that URL in Canvas — is it reachable?"
  }
  return msg
}

/**
 * An external markdown link plus an explicit "Open in Canvas" affordance.
 *
 * The user's ask was to load transcript links into the Canvas; for safety this
 * is EXPLICIT-CLICK ONLY (never auto-load — the Canvas is a scriptable webview;
 * auto-following an agent-authored URL is a CSRF/SSRF vector). The click routes
 * through `window.api.canvas.openWindow`, which runs the full canvas SSRF stack
 * (validateCanvasUrl + per-request gate + hardened webview) — strictly safer
 * than the existing system-browser open for the same link. The affordance is a
 * SIBLING of the anchor (a <button> nested in an <a> is invalid HTML).
 */
function MarkdownExternalLink({
  href,
  resolved,
  onClick,
  children
}: {
  href: string
  resolved: string
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void
  children: ReactNode
}): ReactNode {
  const chat = useContext(AgentIdentityContext)
  const [canvasState, setCanvasState] = useState<'idle' | 'opening' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const link = (
    <FaviconLink
      href={href}
      resolvedUrl={resolved}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      data-link-kind="external"
    >
      {children}
    </FaviconLink>
  )
  if (!isCanvasOpenableUrl(resolved)) return link

  const openInCanvas = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (canvasState === 'opening') return // re-entrancy guard: don't spawn N windows
    const openWindow = (
      window as unknown as {
        api?: {
          canvas?: {
            openWindow?: (a: { url: string; chatId: string }) => Promise<{ ok: boolean; error?: string }>
          }
        }
      }
    ).api?.canvas?.openWindow
    if (!openWindow) return
    setCanvasState('opening')
    setErrorMsg(null)
    const fail = (raw: string | undefined): void => {
      setCanvasState('error')
      setErrorMsg(friendlyCanvasError(raw))
    }
    try {
      if (!chat?.appChatId) {
        fail('Canvas requires an active chat.')
        return
      }
      void openWindow({ url: resolved, chatId: chat.appChatId })
        .then((result) => (result?.ok ? setCanvasState('idle') : fail(result?.error)))
        .catch((err) => fail(err instanceof Error ? err.message : String(err)))
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <span className="markdown-external-link">
      {link}
      <button
        type="button"
        className="markdown-open-in-canvas"
        data-canvas-state={canvasState}
        disabled={canvasState === 'opening'}
        title={canvasState === 'error' ? errorMsg || 'Could not open in Canvas' : 'Open in Canvas'}
        aria-label="Open link in Canvas"
        onClick={openInCanvas}
      >
        <CanvasLinkGlyph />
      </button>
    </span>
  )
}

/** Close-out status glyph — literally the roster chip's icon and its colour
 * class, so the table and the participants-above row read as one vocabulary
 * rather than two lookalikes. It rides the END of the work cell ("37k Tks /
 * 1 Turn ✓") instead of owning a column, which never earned its width. The
 * link text stays the status word: it is the accessible name, and it is what
 * plain-text surfaces show. */
const ENSEMBLE_STATUS_LINK_PREFIX = 'ensemble-status://'

function EnsembleStatusGlyph({ status }: { status: string }): React.JSX.Element {
  const slug = status.toLowerCase().replace(/\s+/g, '-')
  return (
    <span
      className={`ensemble-above-chip-status status-${slug} closeout-status-glyph`}
      role="img"
      aria-label={status}
      title={status}
    >
      <ParticipantStatusIcon status={status} />
    </span>
  )
}

function ProjectReferenceCitationMarkdownChip({
  href,
  children
}: {
  href: string
  children: ReactNode
}): ReactNode {
  const ctx = useContext(ProjectReferenceCitationContext)
  const index = Number(href.slice(PROJECT_REFERENCE_CITATION_LINK_PREFIX.length).trim())
  const citation =
    ctx && Number.isInteger(index) && index >= 0 ? ctx.citations[index] : undefined
  if (!citation) return <>{children}</>
  return <ProjectReferenceCitationChip citation={citation} onOpen={ctx?.onOpen} />
}

const MARKDOWN_COMPONENTS: Components = {
  a({ href, children }) {
    if (typeof href === 'string' && href.startsWith('agent://')) {
      const agentId = href.slice('agent://'.length).trim()
      return <AgentMention agentId={agentId}>{children}</AgentMention>
    }
    if (typeof href === 'string' && href.startsWith('ensemble-dm://')) {
      const participantId = href.slice('ensemble-dm://'.length).trim()
      return <ParticipantMention reference={participantId}>{children}</ParticipantMention>
    }
    if (typeof href === 'string' && href.startsWith(PROJECT_REFERENCE_CITATION_LINK_PREFIX)) {
      return (
        <ProjectReferenceCitationMarkdownChip href={href}>
          {children}
        </ProjectReferenceCitationMarkdownChip>
      )
    }
    // Round close-out table: one seat element per participant in place of the
    // five plain-text columns it replaced. The link TEXT is the full
    // plain-text seat description, so a surface that does not intercept the
    // scheme (TUI, iOS, copy-paste) still reads every field.
    if (typeof href === 'string' && href.startsWith(ENSEMBLE_STATUS_LINK_PREFIX)) {
      const status = href.slice(ENSEMBLE_STATUS_LINK_PREFIX.length).trim()
      return status ? <EnsembleStatusGlyph status={status} /> : <>{children}</>
    }
    if (typeof href === 'string' && href.startsWith(SEAT_CHANGE_LINK_PREFIX)) {
      const link = decodeSeatChangeLink(href)
      return link ? <SeatChangeInlineStrip link={link} /> : <>{children}</>
    }
    const classification = classifyMarkdownLink(href)
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (classification.kind !== 'external') return
      const api = (
        window as unknown as { api?: { openExternalOrPath?: (h: string) => Promise<unknown> } }
      ).api
      try {
        void api?.openExternalOrPath?.(classification.resolved)
      } catch {
        // Best-effort: missing bridge in tests / SSR — no-op.
      }
    }
    const isExternal = classification.kind === 'external'
    if (isExternal) {
      return (
        <MarkdownExternalLink
          href={typeof href === 'string' ? href : '#'}
          resolved={classification.resolved}
          onClick={handleClick}
        >
          {children}
        </MarkdownExternalLink>
      )
    }
    return (
      <a
        href={typeof href === 'string' ? href : '#'}
        onClick={handleClick}
        data-link-kind={classification.kind}
        data-link-openable="false"
      >
        {children}
      </a>
    )
  },
  img({ alt, src }) {
    return (
      <InlineMarkdownImage
        src={typeof src === 'string' ? src : undefined}
        alt={typeof alt === 'string' ? alt : undefined}
      />
    )
  },
  span({ node, children, ...props }) {
    const color = node?.properties?.dataColorToken
    if (typeof color === 'string') {
      return <MarkdownColorToken color={color}>{children}</MarkdownColorToken>
    }
    const hash = node?.properties?.dataCommitReference
    if (typeof hash === 'string') {
      return <MarkdownCommitReference hash={hash}>{children}</MarkdownCommitReference>
    }
    return <span {...props}>{children}</span>
  },
  pre({ children }) {
    return <>{children}</>
  },
  table({ children }) {
    return (
      <div
        className="markdown-table-scroll"
        role="region"
        aria-label="Markdown table"
        tabIndex={0}
      >
        <table>{children}</table>
      </div>
    )
  },
  code({ className, children }) {
    const rawContent = String(children ?? '').replace(/\n$/, '')
    const languageMatch = /language-([\w-]+)/.exec(className || '')
    const isBlock = Boolean(languageMatch) || rawContent.includes('\n')
    if (!isBlock) {
      const color = normalizeInlineMarkdownColor(rawContent)
      if (color) {
        return (
          <MarkdownColorToken color={color}>
            <code className={className}>{children}</code>
          </MarkdownColorToken>
        )
      }
      if (isInlineMarkdownCommitHash(rawContent)) {
        return (
          <MarkdownCommitReference hash={rawContent}>
            <code className={className}>{children}</code>
          </MarkdownCommitReference>
        )
      }
      return <code className={className}>{children}</code>
    }
    const language = languageMatch?.[1]
    // ```chart``` fences are assistant-markdown presentation (all permission
    // tiers). Closed fences parse to SVG; invalid/incomplete bodies fall back
    // inside MarkdownChartBlock so streaming tails stay non-throwing.
    if ((language || '').toLowerCase() === 'chart') {
      return <MarkdownChartBlock content={rawContent} />
    }
    return <MarkdownCodeBlock content={rawContent} language={language} />
  },
  input({ checked, disabled, type }) {
    return <input type={type} checked={checked} disabled={disabled ?? true} readOnly />
  },
  // Plain-text containers — tokenise `@Role` in their string children
  // against the current ensemble's participant list so cross-
  // participant tags in transcript bodies render with the matching
  // provider tint. Unresolved references fall through to plain text
  // (the chip's own fallback) so non-ensemble content is unaffected.
  p({ children, node }) {
    return (
      <p>
        <ProcessedMarkdownChildren
          allowReveal
          nodeEndOffset={node?.position?.end.offset}
        >
          {children}
        </ProcessedMarkdownChildren>
      </p>
    )
  },
  li({ children }) {
    return <li><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></li>
  },
  td({ children, node: _node, ...props }) {
    return <td {...props}><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></td>
  },
  th({ children, node: _node, ...props }) {
    return <th {...props}><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></th>
  },
  // Headings tokenise `@Role` / `@user` too, so a mention in a
  // heading gets the same chip as body text (1.0.72 markdown-audit gap-fix —
  // previously only p/li/td/th tokenised, leaving @-tags in headings bare).
  h1({ children, node }) {
    return <h1><ProcessedMarkdownChildren allowReveal nodeEndOffset={node?.position?.end.offset}>{children}</ProcessedMarkdownChildren></h1>
  },
  h2({ children, node }) {
    return <h2><ProcessedMarkdownChildren allowReveal nodeEndOffset={node?.position?.end.offset}>{children}</ProcessedMarkdownChildren></h2>
  },
  h3({ children, node }) {
    return <h3><ProcessedMarkdownChildren allowReveal nodeEndOffset={node?.position?.end.offset}>{children}</ProcessedMarkdownChildren></h3>
  },
  h4({ children, node }) {
    return <h4><ProcessedMarkdownChildren allowReveal nodeEndOffset={node?.position?.end.offset}>{children}</ProcessedMarkdownChildren></h4>
  },
  h5({ children, node }) {
    return <h5><ProcessedMarkdownChildren allowReveal nodeEndOffset={node?.position?.end.offset}>{children}</ProcessedMarkdownChildren></h5>
  },
  h6({ children, node }) {
    return <h6><ProcessedMarkdownChildren allowReveal nodeEndOffset={node?.position?.end.offset}>{children}</ProcessedMarkdownChildren></h6>
  }
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeInlineMarkdownColorTokens,
  rehypeInlineMarkdownDiffStats,
  rehypeInlineMarkdownCommitReferences
]
// Raw HTML is opt-in for bounded, non-streaming surfaces such as the
// Blackboard. Parse it, then immediately apply the conservative GitHub-style
// sanitiser before React ever sees an element. Transcript messages retain the
// existing escaped-HTML posture unless their caller explicitly opts in.
const SAFE_HTML_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href || []),
      'agent',
      'ensemble-dm',
      'ensemble-seat',
      'ensemble-status',
      'project-ref-cite'
    ]
  }
}
const SAFE_HTML_REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, SAFE_HTML_SCHEMA],
  rehypeInlineMarkdownColorTokens,
  rehypeInlineMarkdownDiffStats,
  rehypeInlineMarkdownCommitReferences
]

// react-markdown's default urlTransform only allows http(s)/irc(s)/mailto/xmpp
// protocols and silently replaces anything else with an empty string — which
// strips our custom agent:// and ensemble-dm:// mention-link schemes before
// the components.a override below ever sees the real href. Allow those two
// schemes through unchanged; delegate everything else to the default
// sanitizer so external-link security posture (blocking javascript:, data:,
// etc.) is unchanged.
function markdownUrlTransform(value: string): string {
  if (
    value.startsWith('agent://') ||
    value.startsWith('ensemble-dm://') ||
    value.startsWith(PROJECT_REFERENCE_CITATION_LINK_PREFIX) ||
    value.startsWith(SEAT_CHANGE_LINK_PREFIX) ||
    value.startsWith(ENSEMBLE_STATUS_LINK_PREFIX)
  ) {
    return value
  }
  return defaultUrlTransform(value)
}

interface StableMarkdownBlockProps {
  /** The raw markdown for a single block. Memo equality is `prev.raw === next.raw`. */
  raw: string
  /** Run id for streaming render instrumentation. Omitted for static markdown. */
  streamRunId?: string
  /** Forwarded only for callsites that don't already wrap a provider.
   * MarkdownMessage installs the provider itself so this is unused in
   * the streaming path — kept for type compatibility / future direct
   * callers. */
  chat?: ChatRecord
  /** Animate only newly inserted words in this active streaming block. */
  revealTokens?: boolean
  /** Maximum number of newest words wrapped in animation spans. */
  animatedWordWindow?: number
  /** Used to resume old words at their prior fade progress after a Markdown reparse. */
  revealDurationMs?: number
  /** Parse raw HTML through rehype-sanitize. Off by default. */
  allowSafeHtml?: boolean
}

function StableMarkdownBlockImpl({
  raw,
  streamRunId,
  revealTokens = false,
  animatedWordWindow = 0,
  revealDurationMs = 175,
  allowSafeHtml = false
}: StableMarkdownBlockProps) {
  const previousRawRef = useRef(raw)
  const transitionRef = useRef({ existingWordCount: 0, existingDelayMs: 0 })
  const previousRaw = previousRawRef.current
  if (previousRaw !== raw) {
    const limit = Math.min(previousRaw.length, raw.length)
    let commonPrefixLength = 0
    while (
      commonPrefixLength < limit &&
      previousRaw[commonPrefixLength] === raw[commonPrefixLength]
    ) {
      commonPrefixLength += 1
    }
    const changedSuffix = `${previousRaw.slice(commonPrefixLength)}${raw.slice(commonPrefixLength)}`
    const changesMarkdownTopology =
      /[*_~`()]/u.test(changedSuffix) ||
      changedSuffix.includes('[') ||
      changedSuffix.includes(']')
    transitionRef.current = changesMarkdownTopology
      ? {
          existingWordCount: revealWordCount(previousRaw.slice(0, commonPrefixLength)),
          existingDelayMs: -Math.max(0, revealDurationMs)
        }
      : { existingWordCount: 0, existingDelayMs: 0 }
  }
  previousRawRef.current = raw

  const revealContext: MarkdownRevealContextValue = revealTokens
    ? {
        enabled: true,
        animatedWordWindow: Math.max(0, animatedWordWindow),
        existingWordCount: transitionRef.current.existingWordCount,
        existingDelayMs: transitionRef.current.existingDelayMs,
        rawEndOffset: raw.trimEnd().length
      }
    : STATIC_MARKDOWN_REVEAL
  const markdown = (
    <MarkdownRevealContext.Provider value={revealContext}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={allowSafeHtml ? SAFE_HTML_REHYPE_PLUGINS : REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        urlTransform={markdownUrlTransform}
      >
        {raw}
      </ReactMarkdown>
    </MarkdownRevealContext.Provider>
  )
  if (!streamRunId) return markdown
  return (
    <Profiler
      id={`markdown:${streamRunId}`}
      onRender={(_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
        recordStreamMarkdownRenderMetric(streamRunId, actualDuration, raw.length)
        recordStreamReactCommitMetric(streamRunId, commitTime - startTime)
      }}
    >
      {markdown}
    </Profiler>
  )
}

/**
 * `React.memo` short-circuits on a single string comparison. That's
 * the entire point — for stable blocks above the streaming tail, the
 * parent's re-render passes the same `raw` and this component returns
 * its memoised vDOM without re-running ReactMarkdown / remark / mdast.
 */
export const StableMarkdownBlock = memo(
  StableMarkdownBlockImpl,
  (prev, next) =>
    prev.raw === next.raw &&
    prev.streamRunId === next.streamRunId &&
    prev.revealTokens === next.revealTokens &&
    prev.animatedWordWindow === next.animatedWordWindow &&
    prev.revealDurationMs === next.revealDurationMs &&
    prev.allowSafeHtml === next.allowSafeHtml
)

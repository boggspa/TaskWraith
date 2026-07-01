import {
  Fragment,
  Profiler,
  memo,
  useContext,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HighlightedCodeBlock } from './HighlightedCodeBlock'
import { AgentMention } from './AgentMention'
import { AgentIdentityContext } from './AgentIdentityContext'
import { ParticipantMention } from './ParticipantMention'
import { FaviconLink } from './FaviconLink'
import { MarkdownMediaContext } from './MarkdownMediaContext'
import { classifyMarkdownLink } from '../lib/classifyMarkdownLink'
import { tokeniseMentions } from '../lib/mentionHighlight'
import { resolveInlineMarkdownImage } from '../lib/resolveMarkdownImageRef'
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

function MarkdownCodeBlock({ content, language }: { content: string; language?: string }) {
  const [wrap, setWrap] = useState(false)
  const { copiedId, copy } = useCopyFeedback()
  const displayLanguage = language?.trim() || 'text'

  return (
    <div className={`message-code-shell ${wrap ? 'wrap' : ''}`}>
      <div className="message-code-header">
        <span className="message-code-language">{displayLanguage}</span>
        <div className="message-code-actions">
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
function tokeniseParticipantMentions(value: string, chat: ChatRecord | undefined): ReactNode {
  if (!value || !value.includes('@')) return value
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
  chat: ChatRecord | undefined
): ReactNode {
  if (children === null || children === undefined) return children
  if (typeof children === 'string') return tokeniseParticipantMentions(children, chat)
  if (Array.isArray(children)) {
    return children.map((child, idx) =>
      typeof child === 'string' ? (
        <Fragment key={idx}>{tokeniseParticipantMentions(child, chat)}</Fragment>
      ) : (
        <Fragment key={idx}>{child}</Fragment>
      )
    )
  }
  return children
}

function ProcessedMarkdownChildren({ children }: { children: ReactNode }): ReactElement {
  const chat = useContext(AgentIdentityContext)
  return <>{processMarkdownMentionChildren(children, chat)}</>
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
          canvas?: { openWindow?: (a: { url: string }) => Promise<{ ok: boolean; error?: string }> }
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
      void openWindow({ url: resolved })
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
      return <code className={className}>{children}</code>
    }
    return <MarkdownCodeBlock content={rawContent} language={languageMatch?.[1]} />
  },
  input({ checked, disabled, type }) {
    return <input type={type} checked={checked} disabled={disabled ?? true} readOnly />
  },
  // Plain-text containers — tokenise `@Role` in their string children
  // against the current ensemble's participant list so cross-
  // participant tags in transcript bodies render with the matching
  // provider tint. Unresolved references fall through to plain text
  // (the chip's own fallback) so non-ensemble content is unaffected.
  p({ children }) {
    return <p><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></p>
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
  h1({ children }) {
    return <h1><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></h1>
  },
  h2({ children }) {
    return <h2><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></h2>
  },
  h3({ children }) {
    return <h3><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></h3>
  },
  h4({ children }) {
    return <h4><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></h4>
  },
  h5({ children }) {
    return <h5><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></h5>
  },
  h6({ children }) {
    return <h6><ProcessedMarkdownChildren>{children}</ProcessedMarkdownChildren></h6>
  }
}

const REMARK_PLUGINS = [remarkGfm]

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
}

function StableMarkdownBlockImpl({ raw, streamRunId }: StableMarkdownBlockProps) {
  const markdown = (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {raw}
    </ReactMarkdown>
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
  (prev, next) => prev.raw === next.raw && prev.streamRunId === next.streamRunId
)

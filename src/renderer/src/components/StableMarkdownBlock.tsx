import { Fragment, memo, useContext, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HighlightedCodeBlock } from './HighlightedCodeBlock'
import { AgentMention } from './AgentMention'
import { ParticipantMention } from './ParticipantMention'
import { FaviconLink } from './FaviconLink'
import { MarkdownMediaContext } from './MarkdownMediaContext'
import { classifyMarkdownLink } from '../lib/classifyMarkdownLink'
import { resolveInlineMarkdownImage } from '../lib/resolveMarkdownImageRef'
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
 *   - `a` routes through `classifyMarkdownLink` + the preload bridge
 *     instead of letting the BrowserWindow navigate (Phase K1 fix);
 *     `agent://` hrefs render as `<AgentMention>` chips.
 *   - `pre` is collapsed — the `code` override owns the shell.
 *   - block `code` (any fenced or multi-line code) renders inside a
 *     `MarkdownCodeBlock` shell (header + copy + wrap toggle).
 *   - `input` is forced read-only so transcript checkboxes can't be
 *     ticked by the user.
 */
/**
 * Tokenise a plain-text node into a mix of text and
 * `<ParticipantMention>` chips. The regex matches `@<name>` at word
 * boundaries with letters/digits/dashes — narrow enough to skip
 * common false positives like `email@example.com` (the `@` there is
 * preceded by `l`, not a boundary).
 *
 * Returns the input wrapped in a fragment of strings + chips. The
 * chip itself decides whether the reference resolves to a participant
 * — unresolved references render as raw text via the chip's
 * fallback, so a stray `@somethingelse` in an LLM reply never
 * vanishes.
 *
 * Only runs against `text` nodes whose host message is in an
 * ensemble chat (gated by the chat's `chatKind` via the
 * `AgentIdentityContext` — but ParticipantMention itself is the
 * gate; this tokeniser is cheap enough to always run, the chip
 * collapses to text when no participants exist).
 */
const PARTICIPANT_MENTION_REGEX = /(^|[\s([{<>"'`!?,;:.])@([A-Za-z][A-Za-z0-9_-]{0,32})/g

function tokeniseParticipantMentions(value: string): ReactNode {
  if (!value || !value.includes('@')) return value
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  PARTICIPANT_MENTION_REGEX.lastIndex = 0
  while ((match = PARTICIPANT_MENTION_REGEX.exec(value)) !== null) {
    const [whole, prefix, reference] = match
    // Position of the `@` (skip the boundary char).
    const atIndex = match.index + prefix.length
    if (atIndex > lastIndex) {
      parts.push(value.slice(lastIndex, atIndex))
    }
    parts.push(
      <ParticipantMention key={`pm-${atIndex}-${reference}`} reference={reference}>
        @{reference}
      </ParticipantMention>
    )
    lastIndex = atIndex + 1 + reference.length
    // Guard against zero-length matches (shouldn't happen with this
    // pattern but cheap insurance against infinite loops).
    if (whole.length === 0) break
  }
  if (parts.length === 0) return value
  if (lastIndex < value.length) parts.push(value.slice(lastIndex))
  return (
    <>
      {parts.map((part, idx) => (
        <Fragment key={idx}>{part}</Fragment>
      ))}
    </>
  )
}

/**
 * Walk the children handed to a ReactMarkdown component override and
 * tokenise every string child against `tokeniseParticipantMentions`.
 * Non-string children (other chips, code, links) pass through
 * untouched so we don't double-tokenise.
 */
function processChildren(children: ReactNode): ReactNode {
  if (children === null || children === undefined) return children
  if (typeof children === 'string') return tokeniseParticipantMentions(children)
  if (Array.isArray(children)) {
    return children.map((child, idx) =>
      typeof child === 'string' ? (
        <Fragment key={idx}>{tokeniseParticipantMentions(child)}</Fragment>
      ) : (
        <Fragment key={idx}>{child}</Fragment>
      )
    )
  }
  return children
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
      if (classification.kind === 'unknown') return
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
    return <p>{processChildren(children)}</p>
  },
  li({ children }) {
    return <li>{processChildren(children)}</li>
  },
  td({ children, node: _node, ...props }) {
    return <td {...props}>{processChildren(children)}</td>
  },
  th({ children, node: _node, ...props }) {
    return <th {...props}>{processChildren(children)}</th>
  },
  // Headings tokenise `@Role` / `@user` too, so a mention in a
  // heading gets the same chip as body text (1.0.72 markdown-audit gap-fix —
  // previously only p/li/td/th tokenised, leaving @-tags in headings bare).
  h1({ children }) {
    return <h1>{processChildren(children)}</h1>
  },
  h2({ children }) {
    return <h2>{processChildren(children)}</h2>
  },
  h3({ children }) {
    return <h3>{processChildren(children)}</h3>
  },
  h4({ children }) {
    return <h4>{processChildren(children)}</h4>
  },
  h5({ children }) {
    return <h5>{processChildren(children)}</h5>
  },
  h6({ children }) {
    return <h6>{processChildren(children)}</h6>
  }
}

const REMARK_PLUGINS = [remarkGfm]

interface StableMarkdownBlockProps {
  /** The raw markdown for a single block. Memo equality is `prev.raw === next.raw`. */
  raw: string
  /** Forwarded only for callsites that don't already wrap a provider.
   * MarkdownMessage installs the provider itself so this is unused in
   * the streaming path — kept for type compatibility / future direct
   * callers. */
  chat?: ChatRecord
}

function StableMarkdownBlockImpl({ raw }: StableMarkdownBlockProps) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {raw}
    </ReactMarkdown>
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
  (prev, next) => prev.raw === next.raw
)

import { useMemo, useState, type ReactElement } from 'react'
import { parseCanvasChartFence, type CanvasChartDocument } from '../../../shared/canvasChart'
import {
  CANVAS_CHART_SVG_DEFAULT_HEIGHT,
  CANVAS_CHART_SVG_DEFAULT_WIDTH,
  chartDocumentToSvg
} from '../lib/canvasChartSvg'
import { useCopyFeedback } from '../lib/useCopyFeedback'
import { HighlightedCodeBlock } from './HighlightedCodeBlock'
import './MarkdownChartBlock.css'

/** Transcript chart viewport cap — keeps closed fences from blowing scroll density. */
export const MARKDOWN_CHART_MAX_HEIGHT_PX = 280

type MarkdownChartBlockProps = {
  /** Raw fence body (JSON), not including the ```chart fences. */
  content: string
}

function ChartFallback({ content, reason }: { content: string; reason: string }): ReactElement {
  const [wrap, setWrap] = useState(false)
  const { copiedId, copy } = useCopyFeedback()
  return (
    <div className={`markdown-chart-fallback ${wrap ? 'wrap' : ''}`}>
      <div className="markdown-chart-error" role="note">
        Chart unavailable: {reason}
      </div>
      <div className={`message-code-shell ${wrap ? 'wrap' : ''}`}>
        <div className="message-code-header">
          <span className="message-code-language">chart</span>
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
              onClick={() => copy('chart', content)}
            >
              {copiedId === 'chart' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div className="message-code-block">
          <HighlightedCodeBlock content={content} language="json" />
        </div>
      </div>
    </div>
  )
}

function ChartFigure({ document }: { document: CanvasChartDocument }): ReactElement {
  const svg = useMemo(
    () =>
      chartDocumentToSvg(document, {
        width: CANVAS_CHART_SVG_DEFAULT_WIDTH,
        height: Math.min(CANVAS_CHART_SVG_DEFAULT_HEIGHT, MARKDOWN_CHART_MAX_HEIGHT_PX - 8)
      }),
    [document]
  )

  return (
    <figure
      className="markdown-chart-block"
      style={{ maxHeight: MARKDOWN_CHART_MAX_HEIGHT_PX }}
      data-chart-kind={document.kind}
    >
      <div
        className="markdown-chart-viewport"
        style={{ maxHeight: MARKDOWN_CHART_MAX_HEIGHT_PX }}
        // SVG comes from the shared escaped builder over validated chart documents only.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </figure>
  )
}

/**
 * In-transcript ```chart``` fence renderer.
 *
 * Presentation of assistant markdown — not an MCP tool — so every permission
 * tier can show the chart. Invalid / incomplete fence bodies fall back to a
 * code shell (streaming-friendly: open fences stay as source until valid JSON).
 */
export function MarkdownChartBlock({ content }: MarkdownChartBlockProps): ReactElement {
  const parsed = useMemo(() => {
    try {
      return parseCanvasChartFence(content)
    } catch (error) {
      return {
        ok: false as const,
        reason: error instanceof Error ? error.message : 'Chart parse failed'
      }
    }
  }, [content])

  if (!parsed.ok) {
    return <ChartFallback content={content} reason={parsed.reason} />
  }
  return <ChartFigure document={parsed.document} />
}

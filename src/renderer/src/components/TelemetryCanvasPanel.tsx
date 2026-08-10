/**
 * TelemetryCanvasPanel — native chart body for Canvas Dock `kind: 'chart'`
 * session tabs. Renders a validated CanvasChartDocument as SVG via Seat 7's
 * canvasChartSvg helper. No WebContentsView, no browser chrome, no pop-out.
 *
 * Document sources (first hit wins):
 * 1. `document` prop (parent decoded from list/status `chartDocument`)
 * 2. Optional preload bridge `canvas.chartDocument(chatId, canvasId)` when Seat
 *    5/6 exposes it (duck-typed — missing bridge is not an error)
 * 3. Title-only empty state until a document arrives
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { validateCanvasChart, type CanvasChartDocument } from '../../../shared/canvasChart'
import {
  CANVAS_CHART_SERIES_COLORS,
  CANVAS_CHART_SVG_DEFAULT_HEIGHT,
  CANVAS_CHART_SVG_DEFAULT_WIDTH,
  chartDocumentToSvg
} from '../lib/canvasChartSvg'

export interface TelemetryCanvasPanelProps {
  chatId: string
  canvasId: string
  title?: string
  /** When list/status already carried the structured document. */
  document?: CanvasChartDocument | null
  onClose?: () => void
}

type ChartBridge = {
  chartDocument?: (chatId: string, canvasId: string) => Promise<unknown>
  getChartDocument?: (chatId: string, canvasId: string) => Promise<unknown>
}

function seriesColor(index: number): string {
  return CANVAS_CHART_SERIES_COLORS[index % CANVAS_CHART_SERIES_COLORS.length] || '#8ab4ff'
}

async function fetchChartDocument(
  chatId: string,
  canvasId: string
): Promise<CanvasChartDocument | null> {
  const api = window.api?.canvas as (typeof window.api.canvas & ChartBridge) | undefined
  if (!api) return null
  const loader = api.chartDocument ?? api.getChartDocument
  if (typeof loader !== 'function') return null
  try {
    const raw = await loader(chatId, canvasId)
    const verdict = validateCanvasChart(raw)
    return verdict.ok ? verdict.document : null
  } catch {
    return null
  }
}

export function TelemetryCanvasPanel({
  chatId,
  canvasId,
  title,
  document: documentProp,
  onClose
}: TelemetryCanvasPanelProps): ReactElement {
  const [document, setDocument] = useState<CanvasChartDocument | null>(documentProp ?? null)
  const [issue, setIssue] = useState<string | null>(null)
  const [loading, setLoading] = useState(!documentProp)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  useEffect(() => {
    if (documentProp) {
      setDocument(documentProp)
      setLoading(false)
      setIssue(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void fetchChartDocument(chatId, canvasId).then((next) => {
      if (cancelled || chatIdRef.current !== chatId) return
      setDocument(next)
      setLoading(false)
      setIssue(next ? null : 'Chart document is not available in this build yet.')
    })
    return () => {
      cancelled = true
    }
  }, [chatId, canvasId, documentProp])

  const svg = useMemo(
    () =>
      document
        ? chartDocumentToSvg(document, {
            width: CANVAS_CHART_SVG_DEFAULT_WIDTH,
            height: CANVAS_CHART_SVG_DEFAULT_HEIGHT
          })
        : null,
    [document]
  )

  const heading = document?.title || title || 'Chart'

  return (
    <section className="canvas-dock-telemetry" aria-label="Telemetry chart">
      <div className="canvas-dock-telemetry-toolbar">
        <div className="canvas-dock-telemetry-heading">
          <div className="canvas-dock-telemetry-title">{heading}</div>
          <div className="canvas-dock-telemetry-subtitle">
            {document
              ? `${document.kind} · ${document.series.length} series`
              : 'Structured chart from the agent'}
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            className="canvas-dock-telemetry-close"
            onClick={onClose}
            aria-label="Close chart tab"
            title="Close chart"
          >
            ×
          </button>
        ) : null}
      </div>
      {loading && !document ? (
        <div className="canvas-dock-telemetry-empty">Loading chart…</div>
      ) : null}
      {issue && !document ? (
        <div className="canvas-dock-telemetry-empty" role="status">
          {issue}
        </div>
      ) : null}
      {document && svg ? (
        <>
          <div
            className="canvas-dock-telemetry-viewport"
            data-chart-kind={document.kind}
            // SVG is built from validated chart data with XML escaping.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <ul className="canvas-dock-telemetry-legend">
            {document.series.map((series, index) => (
              <li key={series.id}>
                <span
                  className="canvas-dock-telemetry-swatch"
                  style={{ background: seriesColor(index) }}
                  aria-hidden="true"
                />
                {series.label}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

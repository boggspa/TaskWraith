/**
 * Renderer re-export of the shared pure SVG chart builder.
 * Prefer importing from here in UI code; main/screenshot should import
 * `src/shared/canvasChartSvg` directly for the same geometry.
 */
export {
  CANVAS_CHART_SERIES_COLORS,
  CANVAS_CHART_SVG_DEFAULT_HEIGHT,
  CANVAS_CHART_SVG_DEFAULT_WIDTH,
  chartDocumentToSvg,
  type ChartDocumentToSvgOptions
} from '../../../shared/canvasChartSvg'

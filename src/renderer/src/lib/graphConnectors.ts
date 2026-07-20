/**
 * Pure geometry for the read-only SVG connector overlay shared by the node/graph
 * panes (thread graph, and — once re-hosted — the Execution Map).
 *
 * Connectors are DERIVED from measured node positions, never stored: they draw
 * the already-topological layout's edges, they do not turn the pane into a
 * free-position canvas. `from`/`to` are opaque node keys (a chatId for the
 * thread graph, a stepId for the Execution Map).
 */

export interface NodeBox {
  /** Top-left of the node in the host's content coordinate space. */
  x: number
  y: number
  width: number
  height: number
}

export interface ConnectorEdgeInput {
  id: string
  from: string
  to: string
  /** Styling bucket, e.g. 'user' | 'derived' (thread graph) or an edge kind. */
  variant?: string
}

export interface ConnectorPath {
  id: string
  d: string
  variant: string
}

const round = (value: number): number => Math.round(value * 10) / 10

/**
 * Build one cubic-bezier path per edge whose endpoints are both measured,
 * anchored right-edge-centre → left-edge-centre (the stages flow left→right).
 * Edges with a missing endpoint (a node not yet laid out) are skipped.
 */
export function buildGraphConnectorPaths(
  nodeBoxes: ReadonlyMap<string, NodeBox>,
  edges: readonly ConnectorEdgeInput[]
): ConnectorPath[] {
  const paths: ConnectorPath[] = []
  for (const edge of edges) {
    const from = nodeBoxes.get(edge.from)
    const to = nodeBoxes.get(edge.to)
    if (!from || !to) continue
    const x1 = from.x + from.width
    const y1 = from.y + from.height / 2
    const x2 = to.x
    const y2 = to.y + to.height / 2
    // Horizontal control-point reach scales with the gap so forward edges sweep
    // gently and same-column / back edges still bow out instead of collapsing.
    const reach = Math.max(24, Math.abs(x2 - x1) * 0.4)
    const d = `M ${round(x1)} ${round(y1)} C ${round(x1 + reach)} ${round(y1)}, ${round(
      x2 - reach
    )} ${round(y2)}, ${round(x2)} ${round(y2)}`
    paths.push({ id: edge.id, d, variant: edge.variant ?? 'default' })
  }
  return paths
}

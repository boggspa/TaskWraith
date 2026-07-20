import { useLayoutEffect, useState, type JSX, type RefObject } from 'react'
import {
  buildGraphConnectorPaths,
  type ConnectorEdgeInput,
  type ConnectorPath,
  type NodeBox
} from '../lib/graphConnectors'

export interface GraphConnectorsProps {
  /** Relative-positioned wrapper that is the measurement origin + SVG host. */
  hostRef: RefObject<HTMLElement | null>
  /** Scrollable descendant (the stages strip); connectors recompute on its scroll. */
  scrollRef?: RefObject<HTMLElement | null>
  /** Live node-element registry keyed by the same key the edges reference. */
  nodeRefs: RefObject<Map<string, HTMLElement>>
  edges: readonly ConnectorEdgeInput[]
}

/**
 * Read-only SVG overlay that draws one curved connector per edge from measured
 * node positions. It stores nothing: positions are re-measured on layout,
 * resize, and scroll, so it tracks the derived topological layout rather than
 * turning the pane into a coordinate canvas.
 */
export function GraphConnectors({
  hostRef,
  scrollRef,
  nodeRefs,
  edges
}: GraphConnectorsProps): JSX.Element | null {
  const [paths, setPaths] = useState<ConnectorPath[]>([])

  useLayoutEffect(() => {
    // This component is a CHILD of the host (canvas) it measures against, so its
    // layout effect runs BEFORE the host's ref is attached (React commits
    // bottom-up). All ref reads are therefore deferred into rAF/observer
    // callbacks, which fire after the commit when the host + node refs exist.
    let frame = 0
    let observer: ResizeObserver | null = null
    const compute = (): void => {
      const host = hostRef.current
      if (!host) return
      const hostRect = host.getBoundingClientRect()
      const boxes = new Map<string, NodeBox>()
      const registry = nodeRefs.current
      if (registry) {
        for (const [key, element] of registry) {
          if (!element || !element.isConnected) continue
          const rect = element.getBoundingClientRect()
          boxes.set(key, {
            x: rect.left - hostRect.left,
            y: rect.top - hostRect.top,
            width: rect.width,
            height: rect.height
          })
        }
      }
      setPaths(buildGraphConnectorPaths(boxes, edges))
    }
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') {
        compute()
        return
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(compute)
    }
    const scroller = scrollRef?.current
    const setup = (): void => {
      const host = hostRef.current
      if (host && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedule)
        observer.observe(host)
      }
      compute()
    }
    // Defer setup one frame so the host/node refs are attached.
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(setup)
    else setup()
    scroller?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      observer?.disconnect()
      scroller?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [edges, hostRef, scrollRef, nodeRefs])

  if (paths.length === 0) return null
  return (
    <svg className="graph-connectors" aria-hidden="true" focusable="false">
      <defs>
        <marker
          id="graph-connector-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="5.5"
          markerHeight="5.5"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          key={path.id}
          className={`graph-connector variant-${path.variant}`}
          d={path.d}
          markerEnd="url(#graph-connector-arrow)"
        />
      ))}
    </svg>
  )
}

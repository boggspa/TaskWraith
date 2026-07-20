import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  ProjectThreadGraphProjection,
  ThreadGraphNodeProjection
} from '../lib/projectThreadGraphProjection'
import { GraphConnectors } from './GraphConnectors'

/** Map the thread-graph's domain tones onto the shared execution-map tone
 * classes so the node cards and status tokens inherit the existing styling. */
const TOKEN_TONE: Record<ThreadGraphNodeProjection['statusTone'], string> = {
  idle: 'pending',
  running: 'active',
  muted: 'muted'
}

export interface ProjectThreadGraphViewProps {
  projection: ProjectThreadGraphProjection | null
  projectName: string
  selectedChatId?: string
  onSelectNode?: (chatId: string) => void
  onOpenThread?: (chatId: string) => void
  onBack?: () => void
  /** `fromChatId` is the upstream prerequisite; `toChatId` is the dependent. */
  onAddDependency?: (fromChatId: string, toChatId: string) => void
  onRemoveDependency?: (edgeId: string) => void
}

function ThreadNode({
  node,
  selected,
  onSelect,
  registerRef
}: {
  node: ThreadGraphNodeProjection
  selected: boolean
  onSelect: () => void
  registerRef: (element: HTMLElement | null) => void
}): JSX.Element {
  return (
    <li className="execution-map-node-item">
      <button
        ref={registerRef}
        type="button"
        className={`execution-map-node tone-${TOKEN_TONE[node.statusTone]} ${selected ? 'is-selected' : ''} ${
          node.isPlaceholder ? 'thread-graph-node-placeholder' : ''
        }`}
        onClick={onSelect}
        aria-pressed={selected}
        data-chat-id={node.chatId}
      >
        <span className="execution-map-node-topline">
          <span className="execution-map-node-kind">{node.kindLabel}</span>
          <span className="thread-graph-node-badges">
            {node.isHome && <span className="thread-graph-badge is-home">Home</span>}
            {node.relationBadge && (
              <span className="thread-graph-badge">{node.relationBadge}</span>
            )}
            {node.inCycle && <span className="thread-graph-badge is-cycle">In cycle</span>}
          </span>
        </span>
        <span className="execution-map-node-title">{node.title}</span>
        {node.dependencies.length > 0 && (
          <span className="execution-map-node-dependencies">
            {node.dependencies.map((dependency) => (
              <span key={dependency.edgeId}>
                {dependency.label}: {dependency.fromTitle}
              </span>
            ))}
          </span>
        )}
        <span className="execution-map-node-footer">
          <span className={`execution-status-token tone-${TOKEN_TONE[node.statusTone]}`}>
            {node.statusLabel}
          </span>
          {node.provider && <span>{node.provider}</span>}
        </span>
      </button>
    </li>
  )
}

function ThreadInspector({
  node,
  projection,
  onOpenThread,
  onAddDependency,
  onRemoveDependency
}: {
  node: ThreadGraphNodeProjection
  projection: ProjectThreadGraphProjection
  onOpenThread?: ProjectThreadGraphViewProps['onOpenThread']
  onAddDependency?: ProjectThreadGraphViewProps['onAddDependency']
  onRemoveDependency?: ProjectThreadGraphViewProps['onRemoveDependency']
}): JSX.Element {
  const existingUpstream = new Set(node.dependencies.map((dependency) => dependency.fromChatId))
  const candidateTargets = projection.orderedNodes.filter(
    (candidate) => candidate.chatId !== node.chatId && !existingUpstream.has(candidate.chatId)
  )
  return (
    <aside className="execution-map-inspector" aria-label={`Details for ${node.title}`}>
      <header className="execution-map-inspector-header">
        <span>{node.kindLabel}</span>
        <h2>{node.title}</h2>
        <span className={`execution-status-token tone-${TOKEN_TONE[node.statusTone]}`}>{node.statusLabel}</span>
      </header>

      <section className="execution-map-inspector-section">
        <h3>Thread</h3>
        <dl className="execution-map-inspector-facts">
          {node.provider && (
            <div>
              <dt>Provider</dt>
              <dd>{node.provider}</dd>
            </div>
          )}
          <div>
            <dt>Kind</dt>
            <dd>{node.kindLabel}</dd>
          </div>
          {node.isHome && (
            <div>
              <dt>Role</dt>
              <dd>Project home</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="execution-map-inspector-section">
        <h3>Depends on</h3>
        {node.dependencies.length === 0 ? (
          <p className="thread-graph-inspector-empty">No upstream dependencies.</p>
        ) : (
          <ul className="execution-map-inspector-list">
            {node.dependencies.map((dependency) => {
              const edge = projection.edges.find((candidate) => candidate.id === dependency.edgeId)
              return (
                <li key={dependency.edgeId}>
                  <span>{dependency.fromTitle}</span>
                  <span>{dependency.label}</span>
                  {edge?.removable && onRemoveDependency && (
                    <button
                      type="button"
                      className="thread-graph-remove-edge"
                      onClick={() => onRemoveDependency(dependency.edgeId)}
                      aria-label={`Remove dependency on ${dependency.fromTitle}`}
                    >
                      Remove
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {onAddDependency && candidateTargets.length > 0 && (
          <label className="thread-graph-add-dependency">
            <span>Add dependency</span>
            <select
              value=""
              onChange={(event) => {
                const target = event.target.value
                if (target) onAddDependency(target, node.chatId)
              }}
            >
              <option value="">This thread depends on…</option>
              {candidateTargets.map((candidate) => (
                <option key={candidate.chatId} value={candidate.chatId}>
                  {candidate.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {onOpenThread && !node.isPlaceholder && (
        <button
          type="button"
          className="execution-map-open-thread"
          onClick={() => onOpenThread(node.chatId)}
        >
          Open thread
        </button>
      )}
    </aside>
  )
}

export function ProjectThreadGraphView({
  projection,
  projectName,
  selectedChatId,
  onSelectNode,
  onOpenThread,
  onBack,
  onAddDependency,
  onRemoveDependency
}: ProjectThreadGraphViewProps): JSX.Element {
  const [internalSelectedChatId, setInternalSelectedChatId] = useState<string | null>(null)
  const mapRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const stagesRef = useRef<HTMLOListElement>(null)
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map())
  useEffect(() => {
    mapRef.current?.focus()
  }, [projection?.projectId])

  const connectorEdges = useMemo(
    () =>
      projection
        ? projection.edges.map((edge) => ({
            id: edge.id,
            from: edge.fromChatId,
            to: edge.toChatId,
            variant: edge.source
          }))
        : [],
    [projection]
  )

  const selectedNode = useMemo(() => {
    if (!projection) return null
    const preferredId = selectedChatId ?? internalSelectedChatId
    return (
      projection.orderedNodes.find((node) => node.chatId === preferredId) ??
      projection.orderedNodes[0] ??
      null
    )
  }, [internalSelectedChatId, projection, selectedChatId])

  if (!projection || projection.orderedNodes.length === 0) {
    return (
      <main
        ref={mapRef}
        className="execution-map-view is-empty"
        aria-label={`${projectName} thread graph`}
        tabIndex={-1}
      >
        {onBack && (
          <button type="button" className="execution-map-back" onClick={onBack}>
            Back
          </button>
        )}
        <div className="execution-map-empty-state">
          <h1>No threads yet</h1>
          <p>Add threads to this project to map how they depend on each other.</p>
        </div>
      </main>
    )
  }

  const handleSelect = (chatId: string): void => {
    setInternalSelectedChatId(chatId)
    onSelectNode?.(chatId)
  }

  return (
    <main
      ref={mapRef}
      className="execution-map-view thread-graph-view"
      aria-label={`${projection.title} thread graph`}
      data-project-id={projection.projectId}
      tabIndex={-1}
    >
      <header className="execution-map-header">
        <span className="execution-map-header-leading">
          {onBack && (
            <button type="button" className="execution-map-back" onClick={onBack}>
              Back
            </button>
          )}
          <span>
            <span className="execution-map-kicker">Thread graph</span>
            <h1>{projection.title}</h1>
          </span>
        </span>
        <span className="execution-map-header-actions">
          <span className="execution-status-token tone-muted">
            {projection.nodeCount} thread{projection.nodeCount === 1 ? '' : 's'} ·{' '}
            {projection.edgeCount} link{projection.edgeCount === 1 ? '' : 's'}
          </span>
        </span>
      </header>

      <span className="execution-visually-hidden" role="status" aria-live="polite">
        {projection.runningCount} running of {projection.nodeCount} threads.
      </span>

      {projection.issues.length > 0 && (
        <div className="execution-map-issues" role="alert">
          {projection.issues.join(' ')}
        </div>
      )}

      <div className="execution-map-body">
        <div className="graph-node-canvas" ref={canvasRef}>
          <GraphConnectors
            hostRef={canvasRef}
            scrollRef={stagesRef}
            nodeRefs={nodeRefs}
            edges={connectorEdges}
          />
          <ol
            className="execution-map-stages"
            ref={stagesRef}
            aria-label="Thread dependency stages"
          >
            {projection.stages.map((stage) => (
              <li key={stage.index} className="execution-map-stage">
                <section
                  aria-labelledby={`thread-graph-${projection.projectId}-stage-${stage.index}`}
                >
                  <h2 id={`thread-graph-${projection.projectId}-stage-${stage.index}`}>
                    {stage.label}
                  </h2>
                  <ol className="execution-map-stage-steps">
                    {stage.nodes.map((node) => (
                      <ThreadNode
                        key={node.chatId}
                        node={node}
                        selected={selectedNode?.chatId === node.chatId}
                        onSelect={() => handleSelect(node.chatId)}
                        registerRef={(element) => {
                          if (element) nodeRefs.current.set(node.chatId, element)
                          else nodeRefs.current.delete(node.chatId)
                        }}
                      />
                    ))}
                  </ol>
                </section>
              </li>
            ))}
          </ol>
        </div>

        {selectedNode && (
          <ThreadInspector
            node={selectedNode}
            projection={projection}
            onOpenThread={onOpenThread}
            onAddDependency={onAddDependency}
            onRemoveDependency={onRemoveDependency}
          />
        )}
      </div>
    </main>
  )
}

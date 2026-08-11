import React, { useEffect, useMemo, useState } from 'react'
import type { ChatRecord, ChatRun } from '../../../main/store/types'
import type {
  PromptEnvelopeLayerSnapshot,
  PromptEnvelopeSnapshot,
  WirePromptCapture
} from '../../../shared/instructions/InstructionTypes'

/** Extract wire captures for one run from durable run events (payload
 * `type: 'wire_prompt'`, emitted by main at provider launch boundaries). */
function wireCapturesFromRunEvents(events: unknown[], runId: string): WirePromptCapture[] {
  const captures: WirePromptCapture[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const record = event as { runId?: unknown; timestamp?: unknown; payload?: unknown }
    if (record.runId !== runId) continue
    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue
    const data = payload as Record<string, unknown>
    if (data.type !== 'wire_prompt') continue
    if (typeof data.transport !== 'string' || typeof data.sha256 !== 'string') continue
    captures.push({
      transport: data.transport,
      attempt: typeof data.attempt === 'number' ? data.attempt : 1,
      capturedAt: typeof record.timestamp === 'string' ? record.timestamp : '',
      part: typeof data.part === 'string' ? data.part : 'user',
      sha256: data.sha256,
      bytes: typeof data.bytes === 'number' ? data.bytes : 0,
      ...(typeof data.content === 'string' ? { content: data.content } : {}),
      ...(Array.isArray(data.transforms)
        ? { transforms: data.transforms.filter((t): t is string => typeof t === 'string') }
        : {})
    })
  }
  return captures
}

/**
 * Inspector → Prompt.
 *
 * Two read-only views over a run's prompt-envelope snapshot:
 *  - Layers: what composed the TaskWraith request (per-layer provenance,
 *    digests, applied/inherited/skipped states).
 *  - Wire: what the provider adapter actually dispatched, per attempt,
 *    when wire captures exist for the run.
 *
 * Accuracy labels are the product contract: the composed snapshot is the
 * "Exact TaskWraith request" BEFORE the provider adapter; provider-owned
 * native system context is never claimed ("Provider-owned context
 * unavailable"). Post-dispatch inspection reads the SNAPSHOT — never the
 * live instruction files, which may have changed since.
 */

const LAYER_STATE_LABEL: Record<PromptEnvelopeLayerSnapshot['state'], string> = {
  applied: 'Applied',
  skipped: 'Skipped',
  inherited: 'Inherited',
  opaque: 'Opaque',
  redacted: 'Redacted'
}

function shortDigest(sha?: string): string | null {
  return sha ? sha.slice(0, 12) : null
}

function LayerRow({ layer }: { layer: PromptEnvelopeLayerSnapshot }): React.JSX.Element {
  const digest = shortDigest(layer.sha256)
  return (
    <article className="settings-user-mcp-row">
      <div className="settings-user-mcp-main">
        <strong>{layer.label}</strong>
        {layer.reason && <span>{layer.reason}</span>}
        <div className="settings-mcp-server-meta">
          <span>{LAYER_STATE_LABEL[layer.state]}</span>
          {typeof layer.bytes === 'number' && <span>{layer.bytes.toLocaleString()} bytes</span>}
          {digest && <span title={layer.sha256}>sha256 {digest}…</span>}
        </div>
        {layer.content !== undefined && (
          <details>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-secondary)'
              }}
            >
              Show layer text
            </summary>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--font-size-xs)',
                maxHeight: 260,
                overflow: 'auto'
              }}
            >
              {layer.content}
            </pre>
          </details>
        )}
      </div>
    </article>
  )
}

function WireRow({ capture }: { capture: WirePromptCapture }): React.JSX.Element {
  return (
    <article className="settings-user-mcp-row">
      <div className="settings-user-mcp-main">
        <strong>
          Attempt {capture.attempt} — {capture.transport} ({capture.part})
        </strong>
        <div className="settings-mcp-server-meta">
          <span>{capture.capturedAt}</span>
          <span>{capture.bytes.toLocaleString()} bytes</span>
          <span title={capture.sha256}>sha256 {shortDigest(capture.sha256)}…</span>
        </div>
        {capture.transforms && capture.transforms.length > 0 && (
          <span>Host transforms after composition: {capture.transforms.join(', ')}</span>
        )}
        {capture.content !== undefined && (
          <details>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-secondary)'
              }}
            >
              Show wire text
            </summary>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--font-size-xs)',
                maxHeight: 260,
                overflow: 'auto'
              }}
            >
              {capture.content}
            </pre>
          </details>
        )}
      </div>
    </article>
  )
}

export function InspectorPromptTab({
  currentChat
}: {
  currentChat?: ChatRecord | null
}): React.JSX.Element {
  const runsWithEnvelopes = useMemo(
    () =>
      ((currentChat?.runs || []) as ChatRun[])
        .filter((run) => run.promptEnvelope)
        .slice(-20)
        .reverse(),
    [currentChat]
  )
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const selectedRun =
    runsWithEnvelopes.find((run) => run.runId === selectedRunId) || runsWithEnvelopes[0]
  const baseEnvelope: PromptEnvelopeSnapshot | undefined = selectedRun?.promptEnvelope

  // Wire captures live in the durable run-event store (main-owned); join
  // them to the composed envelope at view time so each store keeps a single
  // writer. Any snapshot-embedded captures win over the event-derived ones.
  const [eventWire, setEventWire] = useState<WirePromptCapture[]>([])
  useEffect(() => {
    setEventWire([])
    const runId = selectedRun?.runId
    const chatId = currentChat?.appChatId
    if (!runId || !chatId || typeof window.api?.getRunEvents !== 'function') return
    let cancelled = false
    void window.api
      .getRunEvents({ chatId, runId, limit: 1000 })
      .then((events) => {
        if (!cancelled && Array.isArray(events)) {
          setEventWire(wireCapturesFromRunEvents(events, runId))
        }
      })
      .catch(() => {
        /* evidence view only — leave the composed envelope standing */
      })
    return () => {
      cancelled = true
    }
  }, [selectedRun?.runId, currentChat?.appChatId])

  const envelope: PromptEnvelopeSnapshot | undefined = useMemo(() => {
    if (!baseEnvelope) return undefined
    if (baseEnvelope.wire?.length || eventWire.length === 0) return baseEnvelope
    return { ...baseEnvelope, wire: eventWire }
  }, [baseEnvelope, eventWire])

  if (!envelope) {
    return (
      <div className="safety-panel">
        <div className="safety-card">
          <h4>Prompt</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: 0
            }}
          >
            No prompt envelope is recorded for this chat yet. Envelopes are captured per run at
            composition time; runs made before this feature (or by producers that do not compose
            through the run composer) have none.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="safety-panel">
      <div className="safety-card">
        <div className="settings-section-title-row">
          <h4 style={{ margin: 0 }}>Prompt — {envelope.provider}</h4>
          <span className="settings-editable-pill">
            {envelope.wire && envelope.wire.length > 0
              ? 'Wire captured'
              : 'Exact TaskWraith request (before provider adapter)'}
          </span>
        </div>
        {runsWithEnvelopes.length > 1 && (
          <label className="settings-field-label" style={{ display: 'block' }}>
            Run
            <select
              value={selectedRun?.runId}
              onChange={(event) => setSelectedRunId(event.target.value)}
              style={{ marginLeft: 'var(--space-sm)' }}
            >
              {runsWithEnvelopes.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.startedAt} — {run.provider || envelope.provider}
                  {run.requestedModel ? ` (${run.requestedModel})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="settings-mcp-server-meta">
          <span>Composed {envelope.composedAt}</span>
          {envelope.model && <span>{envelope.model}</span>}
          <span>{envelope.composedBytes.toLocaleString()} bytes</span>
          <span title={envelope.composedSha256}>
            sha256 {shortDigest(envelope.composedSha256)}…
          </span>
          <span>instructions digest: {envelope.instructionsDigest}</span>
        </div>
        <p
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-secondary)',
            margin: 'var(--space-sm) 0 0 0'
          }}
        >
          This snapshot was taken at composition and is authoritative for what TaskWraith sent.
          Provider-native system prompts and private session context are provider-owned and not
          claimed here (provider-owned context unavailable).
          {!envelope.contentStored &&
            ' Layer text was not stored for this run — enable “store raw events” in Safety & Privacy to keep full content with future runs; digests and states persist regardless.'}
        </p>
      </div>

      <div className="safety-card">
        <h4>Layers</h4>
        {envelope.layers.map((layer, index) => (
          <LayerRow key={`${layer.id}-${index}`} layer={layer} />
        ))}
      </div>

      <div className="safety-card">
        <h4>Wire</h4>
        {envelope.wire && envelope.wire.length > 0 ? (
          envelope.wire.map((capture, index) => (
            <WireRow
              key={`${capture.transport}-${capture.part}-${capture.attempt}-${index}`}
              capture={capture}
            />
          ))
        ) : (
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: 0
            }}
          >
            No wire-boundary capture for this run. The composed request above is exact as TaskWraith
            produced it; the provider adapter may still add transport preambles at dispatch. Wire
            captures appear here for transports instrumented at their launch boundary.
          </p>
        )}
      </div>
    </div>
  )
}

import { memo, useMemo } from 'react'
import type {
  WorkProvenanceActor,
  WorkProvenanceAttributionPath,
  WorkProvenanceConfidence,
  WorkProvenanceContributor,
  WorkProvenanceEvidence,
  WorkProvenanceItem,
  WorkProvenanceLifecycle,
  WorkProvenanceLiveness,
  WorkProvenanceSnapshot
} from '../../../shared/workProvenance'
import { DigitOdometer } from './DigitOdometer'

const NUMBER_FORMAT = new Intl.NumberFormat('en-GB')

type WorkspaceProvenanceRowKind = 'unique' | 'shared' | 'unknown'

export interface WorkspaceProvenanceRow {
  key: string
  kind: WorkspaceProvenanceRowKind
  confidence: WorkProvenanceConfidence
  lifecycle: WorkProvenanceLifecycle | null
  liveness: WorkProvenanceLiveness | null
  paths: WorkProvenanceAttributionPath[]
  workItems: WorkProvenanceItem[]
  contributors: WorkProvenanceContributor[]
  additions: number
  deletions: number
  hasNumericDiff: boolean
}

type ContributorRelationship = NonNullable<WorkProvenanceEvidence['relationship']>

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export function workspaceProvenanceActorKey(actor: WorkProvenanceActor): string {
  return (
    actor.markerObservationId ??
    actor.lockOwnerId ??
    actor.runId ??
    actor.sessionId ??
    actor.taskId ??
    actor.chatId ??
    actor.participantId ??
    actor.displayName ??
    actor.chatTitle ??
    'unknown-actor'
  )
}

function contributorRelationships(
  contributor: WorkProvenanceContributor
): ContributorRelationship[] {
  return [
    ...new Set(
      contributor.evidence.flatMap((entry) => (entry.relationship ? [entry.relationship] : []))
    )
  ]
}

function isCurrentContributor(contributor: WorkProvenanceContributor): boolean {
  const relationships = contributorRelationships(contributor)
  return relationships.length === 0 || relationships.includes('current')
}

function contributorsForItem(item: WorkProvenanceItem): WorkProvenanceContributor[] {
  if (item.lifecycle === 'unresolved' || item.currentDirty) {
    return item.currentContributors ?? item.contributors
  }
  return item.contributors
}

function contributorReferenceKey(actor: WorkProvenanceActor): string {
  if (actor.taskId) return `task:${actor.taskId}`
  if (actor.chatId) return `chat:${actor.chatId}`
  if (actor.markerFile) return `marker:${actor.markerFile}`
  if (actor.sessionId) return `session:${actor.sessionId}`
  if (actor.runId) return `run:${actor.runId}`
  if (actor.lockOwnerId) return `lock:${actor.lockOwnerId}`
  if (actor.markerObservationId) return `observation:${actor.markerObservationId}`
  if (actor.participantId) return `participant:${actor.participantId}`
  return `actor:${actor.displayName ?? actor.chatTitle ?? 'unknown'}`
}

function rowReferenceSet(item: WorkProvenanceItem | undefined): string {
  if (!item) return 'no-contributor'
  const contributors = contributorsForItem(item)
  const current = contributors.filter(isCurrentContributor)
  return (current.length > 0 ? current : contributors)
    .map((contributor) => contributorReferenceKey(contributor.actor))
    .sort()
    .join('|')
}

function mergeContributors(items: WorkProvenanceItem[]): WorkProvenanceContributor[] {
  const contributors = new Map<string, WorkProvenanceContributor>()
  for (const item of items) {
    for (const contributor of contributorsForItem(item)) {
      const key = workspaceProvenanceActorKey(contributor.actor)
      const current = contributors.get(key)
      if (!current) {
        contributors.set(key, contributor)
        continue
      }
      const evidence = new Map(
        current.evidence.map((entry) => [
          [
            entry.originEventId,
            entry.source,
            entry.operation?.id,
            entry.relationship,
            entry.recordedAt
          ].join(':'),
          entry
        ])
      )
      for (const entry of contributor.evidence) {
        const evidenceKey = [
          entry.originEventId,
          entry.source,
          entry.operation?.id,
          entry.relationship,
          entry.recordedAt
        ].join(':')
        if (!evidence.has(evidenceKey)) evidence.set(evidenceKey, entry)
      }
      contributors.set(key, { ...current, evidence: [...evidence.values()] })
    }
  }
  return [...contributors.values()]
}

function currentRowKey(
  kind: WorkspaceProvenanceRowKind,
  path: WorkProvenanceAttributionPath,
  item: WorkProvenanceItem | undefined
): string {
  if (kind === 'unknown') return `unknown:${path.confidence}`
  return [
    kind,
    rowReferenceSet(item),
    path.confidence,
    item?.lifecycle ?? 'current',
    item?.liveness ?? 'outside-window'
  ].join(':')
}

export function buildWorkspaceProvenanceRows(
  snapshot: WorkProvenanceSnapshot
): WorkspaceProvenanceRow[] {
  if (!snapshot.available) return []
  const itemById = new Map(snapshot.workItems.map((item) => [item.workItemId, item]))
  const groups = new Map<string, WorkspaceProvenanceRow>()
  const partitions: Array<{
    kind: WorkspaceProvenanceRowKind
    paths: WorkProvenanceAttributionPath[]
  }> = [
    { kind: 'unique', paths: snapshot.attribution.unique.paths },
    { kind: 'shared', paths: snapshot.attribution.sharedAmbiguous.paths },
    { kind: 'unknown', paths: snapshot.attribution.unclaimedUnknown.paths }
  ]

  for (const partition of partitions) {
    for (const path of partition.paths) {
      const item = path.workItemId ? itemById.get(path.workItemId) : undefined
      const key = currentRowKey(partition.kind, path, item)
      const existing = groups.get(key)
      if (existing) {
        existing.paths.push(path)
        existing.additions += path.additions ?? 0
        existing.deletions += path.deletions ?? 0
        existing.hasNumericDiff ||= path.additions !== null || path.deletions !== null
        if (item && !existing.workItems.some((entry) => entry.workItemId === item.workItemId)) {
          existing.workItems.push(item)
          existing.contributors = mergeContributors(existing.workItems)
        }
        continue
      }
      const workItems = item ? [item] : []
      groups.set(key, {
        key,
        kind: partition.kind,
        confidence: path.confidence,
        lifecycle: item?.lifecycle ?? null,
        liveness: item?.liveness ?? null,
        paths: [path],
        workItems,
        contributors: mergeContributors(workItems),
        additions: path.additions ?? 0,
        deletions: path.deletions ?? 0,
        hasNumericDiff: path.additions !== null || path.deletions !== null
      })
    }
  }

  const rank: Record<WorkspaceProvenanceRowKind, number> = {
    shared: 0,
    unique: 1,
    unknown: 2
  }
  return [...groups.values()].sort(
    (left, right) =>
      rank[left.kind] - rank[right.kind] ||
      provenanceRowTitle(left).localeCompare(provenanceRowTitle(right))
  )
}

export function activeWorkspaceProvenanceContributorCount(
  snapshot: WorkProvenanceSnapshot
): number {
  if (!snapshot.available) return 0
  const actors = new Set<string>()
  for (const item of snapshot.workItems) {
    if (item.lifecycle !== 'unresolved' || !['live', 'runtime'].includes(item.liveness)) continue
    for (const contributor of contributorsForItem(item)) {
      if (isCurrentContributor(contributor)) {
        actors.add(workspaceProvenanceActorKey(contributor.actor))
      }
    }
  }
  return actors.size
}

function actorLabel(actor: WorkProvenanceActor): string {
  return (
    actor.chatTitle ??
    actor.displayName ??
    actor.participantRole ??
    actor.participantId ??
    actor.provider ??
    'Unidentified contributor'
  )
}

function actorSummary(actor: WorkProvenanceActor): string {
  return (
    [
      actor.provider,
      actor.participantRole,
      actor.laneId ? `lane ${actor.laneId}` : null,
      actor.sessionId ? `session ${shortId(actor.sessionId)}` : null,
      actor.runId ? `run ${shortId(actor.runId)}` : null
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(' · ') || 'No runtime identity exported'
  )
}

function provenanceRowTitle(row: WorkspaceProvenanceRow): string {
  if (row.kind === 'unknown') return 'Unclaimed changes'
  const labels = row.contributors.map((contributor) => actorLabel(contributor.actor))
  if (labels.length === 0) {
    return row.kind === 'shared' ? 'Shared attribution' : 'Contributor outside the tracked window'
  }
  if (row.kind === 'shared') {
    return labels.length === 1
      ? `Shared claim · ${labels[0]}`
      : `${labels[0]} + ${labels.length - 1}`
  }
  return labels.length === 1 ? labels[0] : `${labels[0]} + ${labels.length - 1}`
}

function provenanceRowSubtitle(row: WorkspaceProvenanceRow): string {
  if (row.kind === 'unknown') return 'No contributor evidence for these changes'
  const current = row.contributors.filter(isCurrentContributor).length
  const predecessors = row.contributors.filter((contributor) =>
    contributorRelationships(contributor).includes('predecessor')
  ).length
  const parts = [
    current > 0 ? `${current} current` : null,
    predecessors > 0 ? `${predecessors} predecessor${predecessors === 1 ? '' : 's'}` : null
  ].filter((entry): entry is string => Boolean(entry))
  if (parts.length > 0) return parts.join(' · ')
  if (row.contributors.length === 1) return actorSummary(row.contributors[0].actor)
  return `${row.contributors.length} contributors`
}

/* The class names stay keyed on the raw classifier vocabulary; only the
 * rendered text and tooltips use these display labels. */
const STATE_DISPLAY: Record<string, { label: string; title: string }> = {
  live: { label: 'Live', title: 'Backed by a live TaskWraith lane right now' },
  runtime: { label: 'Running', title: 'Backed by a running TaskWraith session' },
  decayed: { label: 'Ended', title: 'The contributing session has ended; its evidence remains' },
  absent: { label: 'Inactive', title: 'No live backing remains for this evidence' },
  observed: { label: 'Observed', title: 'Recorded evidence without a liveness signal' },
  unclaimed: { label: 'Unclaimed', title: 'No TaskWraith contributor claims these changes' }
}

const CONFIDENCE_DISPLAY: Record<WorkProvenanceConfidence, { label: string; title: string }> = {
  exact: { label: 'Exact match', title: 'Current bytes match the recorded claim exactly' },
  'observed-native': {
    label: 'Direct',
    title: 'Observed directly from a TaskWraith-run operation'
  },
  'correlated-claim': {
    label: 'Correlated',
    title: 'A recorded claim correlates with these changes'
  },
  ambiguous: {
    label: 'Ambiguous',
    title: "More than one contributor's evidence overlaps these changes"
  },
  unknown: { label: 'No evidence', title: 'No contributor evidence ties these changes to a run' }
}

function stateKey(row: WorkspaceProvenanceRow): string {
  if (row.kind === 'unknown') return 'unclaimed'
  return row.liveness ?? 'observed'
}

const STATUS_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflicted',
  T: 'type changed'
}

function describePathStatus(path: WorkProvenanceAttributionPath): string {
  const raw = path.status.trim()
  if (path.untracked || raw === '??') return 'untracked'
  const words = [...new Set(raw.split(''))]
    .map((code) => STATUS_WORDS[code])
    .filter((word): word is string => Boolean(word))
  return words.join(' + ') || raw || 'modified'
}

function actorIdentifiers(actor: WorkProvenanceActor): Array<[string, string]> {
  return [
    ['task', actor.taskId],
    ['chat', actor.chatId],
    ['session', actor.sessionId],
    ['run', actor.runId],
    ['participant', actor.participantId],
    ['lane', actor.laneId],
    ['marker', actor.markerObservationId],
    ['lock', actor.lockOwnerId]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))
}

function ProvenanceDiff({ row }: { row: WorkspaceProvenanceRow }): React.JSX.Element {
  if (!row.hasNumericDiff) {
    const untracked = row.paths.filter((path) => path.untracked).length
    return (
      <span className="workspace-provenance-diff is-unavailable">
        {untracked > 0 ? `${NUMBER_FORMAT.format(untracked)} untracked` : 'No line counts'}
      </span>
    )
  }
  return (
    <span className="workspace-provenance-diff" aria-label="Line changes attributed to this row">
      <span className="workspace-stats-addition">
        <DigitOdometer value={row.additions} sign="+" />
      </span>
      <span className="workspace-stats-deletion">
        <DigitOdometer value={row.deletions} sign="-" />
      </span>
    </span>
  )
}

const WorkspaceProvenanceRowView = memo(function WorkspaceProvenanceRowView({
  row
}: {
  row: WorkspaceProvenanceRow
}): React.JSX.Element {
  const pathPreview = row.paths.map((path) => path.path).join(', ')
  const evidence = row.workItems.flatMap((item) =>
    contributorsForItem(item).flatMap((contributor) => contributor.evidence)
  )
  const confidenceReasons = [
    ...new Set(
      row.workItems
        .flatMap((item) => [
          item.confidenceReason,
          ...contributorsForItem(item).map((contributor) => contributor.confidenceReason)
        ])
        .filter(Boolean)
    )
  ]
  const recoveries = row.workItems.flatMap((item) => (item.recovery ? [item.recovery] : []))

  return (
    <details className={`workspace-provenance-row state-${stateKey(row)}`}>
      <summary>
        <span className="workspace-provenance-state" title={STATE_DISPLAY[stateKey(row)]?.title}>
          {STATE_DISPLAY[stateKey(row)]?.label ?? stateKey(row)}
        </span>
        <span
          className="workspace-provenance-identity"
          title={`${provenanceRowTitle(row)} — ${provenanceRowSubtitle(row)}`}
        >
          <strong>{provenanceRowTitle(row)}</strong>
          <small>{provenanceRowSubtitle(row)}</small>
        </span>
        <ProvenanceDiff row={row} />
        <span
          className={`workspace-provenance-confidence confidence-${row.confidence}`}
          title={CONFIDENCE_DISPLAY[row.confidence]?.title}
        >
          {CONFIDENCE_DISPLAY[row.confidence]?.label ?? row.confidence}
        </span>
        <span className="workspace-provenance-paths" title={pathPreview}>
          {pathPreview}
        </span>
        <span className="workspace-provenance-disclosure" aria-hidden />
      </summary>
      <div className="workspace-provenance-details">
        <section>
          <h4>Paths in this Git generation</h4>
          {row.paths.map((path) => (
            <p key={`${row.key}:${path.path}`}>
              <code>{path.path}</code>
              <small>
                {describePathStatus(path)}
                {path.renamedFrom ? ` · renamed from ${path.renamedFrom}` : ''}
                {path.additions === null || path.deletions === null
                  ? path.untracked
                    ? ''
                    : ' · binary or no line counts'
                  : ` · +${NUMBER_FORMAT.format(path.additions)} −${NUMBER_FORMAT.format(path.deletions)}`}
              </small>
            </p>
          ))}
        </section>
        <section>
          <h4>Contributors and local IDs</h4>
          {row.contributors.length === 0 ? (
            <p>No defensible contributor identity is attached.</p>
          ) : (
            row.contributors.map((contributor) => (
              <p key={workspaceProvenanceActorKey(contributor.actor)}>
                <strong>{actorLabel(contributor.actor)}</strong>
                <small>{actorSummary(contributor.actor)}</small>
                {actorIdentifiers(contributor.actor).map(([label, value]) => (
                  <code key={`${label}:${value}`} title={value}>
                    {label} {shortId(value)}
                  </code>
                ))}
              </p>
            ))
          )}
        </section>
        <section>
          <h4>Evidence and confidence</h4>
          <p>{confidenceReasons.join(' ') || 'No confidence reason returned by core.'}</p>
          {evidence.map((entry, index) => (
            <code key={`${entry.originEventId ?? entry.source}:${index}`}>
              {entry.relationship ? `${entry.relationship} · ` : ''}
              {entry.source}
              {entry.originEventId ? ` · ${shortId(entry.originEventId)}` : ''}
            </code>
          ))}
        </section>
        {recoveries.length > 0 && (
          <section>
            <h4>Recovery evidence</h4>
            {recoveries.map((recovery) => (
              <p key={`${recovery.ref}:${recovery.commit}`}>
                <code>{recovery.ref}</code>
                <small>
                  {recovery.available ? 'Available' : 'Unavailable'} ·{' '}
                  {recovery.pinned ? 'pinned' : 'unpinned'} · {shortId(recovery.commit)}
                </small>
              </p>
            ))}
          </section>
        )}
      </div>
    </details>
  )
})

export function WorkspaceProvenanceList({
  snapshot
}: {
  snapshot: WorkProvenanceSnapshot
}): React.JSX.Element {
  const rows = useMemo(() => buildWorkspaceProvenanceRows(snapshot), [snapshot])
  if (rows.length === 0) {
    return (
      <div className="workspace-provenance-empty">
        <span aria-hidden />
        <div>
          <strong>No current work evidence</strong>
          <small>The coherent Git generation has no dirty paths to classify.</small>
        </div>
      </div>
    )
  }
  return (
    <div className="workspace-provenance-list" role="list" aria-label="Current work evidence">
      {rows.map((row) => (
        <WorkspaceProvenanceRowView key={row.key} row={row} />
      ))}
    </div>
  )
}

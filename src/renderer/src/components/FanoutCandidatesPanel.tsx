import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiffFileSummary, FanoutWorktreeCandidate } from '../../../main/store/types'
import {
  fanoutCandidateCanResolve,
  fanoutCandidateStatusLabel,
  fanoutCandidateTitle,
  formatFanoutDiffStat,
  groupFanoutCandidates,
  type FanoutCandidateGroups
} from '../lib/fanoutCandidatesModel'
import { DiffViewer } from './DiffViewer'
import { PillButton } from './PillButton'

/**
 * "Compare" dock surface — adjudicate worktree-isolated fan-out candidates:
 * review each lane's diff, promote ONE onto the workspace working tree
 * (uncommitted), discard the rest. Data is panel-owned: candidates are a
 * main-owned chat field written by async patchers, so this surface fetches on
 * mount/chat change, after every action, and on a slow poll while lanes are
 * still running.
 */

export interface FanoutCandidateDiffResult {
  type: string
  text?: string
  statusText?: string
  diffText?: string
  summaries?: DiffFileSummary[]
}

export interface FanoutCandidatesApi {
  listFanoutCandidates: (chatId: string) => Promise<FanoutWorktreeCandidate[]>
  fanoutCandidateDiff: (chatId: string, candidateId: string) => Promise<FanoutCandidateDiffResult>
  promoteFanoutCandidate: (
    chatId: string,
    candidateId: string
  ) => Promise<{ ok: boolean; error?: string; applied?: boolean }>
  discardFanoutCandidate: (
    chatId: string,
    candidateId: string
  ) => Promise<{ ok: boolean; error?: string }>
}

const RUNNING_POLL_INTERVAL_MS = 5_000

function defaultApi(): FanoutCandidatesApi | null {
  const api = (window as { api?: unknown }).api as FanoutCandidatesApi | undefined
  return api && typeof api.listFanoutCandidates === 'function' ? api : null
}

export function FanoutCandidatesPanel(props: {
  chatId: string
  workspacePath?: string
  api?: FanoutCandidatesApi
}) {
  const api = useMemo(() => props.api ?? defaultApi(), [props.api])
  const [candidates, setCandidates] = useState<FanoutWorktreeCandidate[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [reviewCandidateId, setReviewCandidateId] = useState<string | null>(null)
  const [reviewDiff, setReviewDiff] = useState<FanoutCandidateDiffResult | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const next = await api.listFanoutCandidates(props.chatId)
      if (!aliveRef.current) return
      setCandidates(next)
      setLoadError(null)
    } catch (error) {
      if (!aliveRef.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (aliveRef.current) setLoaded(true)
    }
  }, [api, props.chatId])

  // Chat switches remount this panel (keyed by chatId at the mount site), so
  // state resets are automatic and this effect only performs the fetch.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const hasRunningLanes = candidates.some((candidate) => candidate.status === 'active')
  useEffect(() => {
    if (!hasRunningLanes) return
    const timer = window.setInterval(() => void refresh(), RUNNING_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [hasRunningLanes, refresh])

  const openReview = useCallback(
    async (candidateId: string) => {
      if (!api) return
      if (reviewCandidateId === candidateId) {
        setReviewCandidateId(null)
        setReviewDiff(null)
        setReviewError(null)
        return
      }
      setReviewCandidateId(candidateId)
      setReviewDiff(null)
      setReviewError(null)
      try {
        const diff = await api.fanoutCandidateDiff(props.chatId, candidateId)
        if (!aliveRef.current) return
        setReviewDiff(diff)
      } catch (error) {
        if (!aliveRef.current) return
        setReviewError(error instanceof Error ? error.message : String(error))
      }
    },
    [api, props.chatId, reviewCandidateId]
  )

  const resolveCandidate = useCallback(
    async (candidateId: string, action: 'promote' | 'discard') => {
      if (!api || busyCandidateId) return
      setBusyCandidateId(candidateId)
      setActionNotice(null)
      try {
        const result: { ok: boolean; error?: string; applied?: boolean } =
          action === 'promote'
            ? await api.promoteFanoutCandidate(props.chatId, candidateId)
            : await api.discardFanoutCandidate(props.chatId, candidateId)
        if (!aliveRef.current) return
        if (!result.ok) {
          setActionNotice(result.error || `Could not ${action} the candidate.`)
        } else if (action === 'promote') {
          setActionNotice(
            result.applied === false
              ? 'Candidate had no changes; its worktree was cleaned up.'
              : 'Winner applied to the workspace as uncommitted changes. Review and commit when ready.'
          )
        } else {
          setActionNotice(null)
        }
        if (reviewCandidateId === candidateId) {
          setReviewCandidateId(null)
          setReviewDiff(null)
          setReviewError(null)
        }
      } catch (error) {
        if (!aliveRef.current) return
        setActionNotice(error instanceof Error ? error.message : String(error))
      } finally {
        if (aliveRef.current) {
          setBusyCandidateId(null)
          void refresh()
        }
      }
    },
    [api, busyCandidateId, props.chatId, refresh, reviewCandidateId]
  )

  const groups = useMemo(() => groupFanoutCandidates(candidates), [candidates])

  return (
    <FanoutCandidatesView
      groups={groups}
      loaded={loaded}
      loadError={loadError}
      apiAvailable={Boolean(api)}
      busyCandidateId={busyCandidateId}
      actionNotice={actionNotice}
      reviewCandidateId={reviewCandidateId}
      reviewDiff={reviewDiff}
      reviewError={reviewError}
      workspacePath={props.workspacePath}
      onRefresh={() => void refresh()}
      onReview={(candidateId) => void openReview(candidateId)}
      onPromote={(candidateId) => void resolveCandidate(candidateId, 'promote')}
      onDiscard={(candidateId) => void resolveCandidate(candidateId, 'discard')}
    />
  )
}

/** Presentational layer, exported for DOM-free renderToStaticMarkup tests. */
export function FanoutCandidatesView(props: {
  groups: FanoutCandidateGroups
  loaded: boolean
  loadError: string | null
  apiAvailable: boolean
  busyCandidateId: string | null
  actionNotice: string | null
  reviewCandidateId: string | null
  reviewDiff: FanoutCandidateDiffResult | null
  reviewError: string | null
  workspacePath?: string
  onRefresh: () => void
  onReview: (candidateId: string) => void
  onPromote: (candidateId: string) => void
  onDiscard: (candidateId: string) => void
}) {
  const { groups } = props
  const total = groups.awaiting.length + groups.running.length + groups.resolved.length
  return (
    <div
      className="fanout-candidates-panel"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-sm)',
          padding: 'var(--space-sm) var(--space-md)'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
            Fan-out candidates
          </span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
            {groups.awaiting.length > 0
              ? `${groups.awaiting.length} awaiting your decision`
              : groups.running.length > 0
                ? `${groups.running.length} lane(s) still working`
                : 'Isolated lanes land here to compare & promote'}
          </span>
        </div>
        <PillButton variant="ghost" size="compact" onClick={props.onRefresh}>
          Refresh
        </PillButton>
      </div>

      {props.actionNotice && (
        <div
          style={{
            margin: '0 var(--space-md) var(--space-sm)',
            padding: 'var(--space-xs) var(--space-sm)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-soft, rgba(127,127,127,0.25))',
            borderRadius: '8px'
          }}
        >
          {props.actionNotice}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 var(--space-md) var(--space-md)' }}>
        {!props.apiAvailable ? (
          <EmptyNote text="Candidate actions are unavailable in this window." />
        ) : props.loadError ? (
          <EmptyNote text={props.loadError} danger />
        ) : !props.loaded ? (
          <EmptyNote text="Loading candidates…" />
        ) : total === 0 ? (
          <EmptyNote text="No candidates yet. Run a fan-out with worktree isolation (Boss tool ensemble_fanout_all with isolation=worktree, or the chat's fan-out isolation setting) and each write lane's result will land here for review." />
        ) : (
          <>
            <CandidateGroup
              title="Awaiting decision"
              candidates={groups.awaiting}
              {...groupHandlers(props)}
            />
            <CandidateGroup
              title="Still running"
              candidates={groups.running}
              {...groupHandlers(props)}
            />
            <CandidateGroup
              title="Resolved"
              candidates={groups.resolved}
              {...groupHandlers(props)}
            />
          </>
        )}
      </div>
    </div>
  )
}

function groupHandlers(props: {
  busyCandidateId: string | null
  reviewCandidateId: string | null
  reviewDiff: FanoutCandidateDiffResult | null
  reviewError: string | null
  workspacePath?: string
  onReview: (candidateId: string) => void
  onPromote: (candidateId: string) => void
  onDiscard: (candidateId: string) => void
}) {
  return {
    busyCandidateId: props.busyCandidateId,
    reviewCandidateId: props.reviewCandidateId,
    reviewDiff: props.reviewDiff,
    reviewError: props.reviewError,
    workspacePath: props.workspacePath,
    onReview: props.onReview,
    onPromote: props.onPromote,
    onDiscard: props.onDiscard
  }
}

function CandidateGroup(props: {
  title: string
  candidates: FanoutWorktreeCandidate[]
  busyCandidateId: string | null
  reviewCandidateId: string | null
  reviewDiff: FanoutCandidateDiffResult | null
  reviewError: string | null
  workspacePath?: string
  onReview: (candidateId: string) => void
  onPromote: (candidateId: string) => void
  onDiscard: (candidateId: string) => void
}) {
  if (props.candidates.length === 0) return null
  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          margin: 'var(--space-sm) 0'
        }}
      >
        {props.title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        {props.candidates.map((candidate) => (
          <CandidateCard key={candidate.candidateId} candidate={candidate} {...props} />
        ))}
      </div>
    </div>
  )
}

function CandidateCard(props: {
  candidate: FanoutWorktreeCandidate
  busyCandidateId: string | null
  reviewCandidateId: string | null
  reviewDiff: FanoutCandidateDiffResult | null
  reviewError: string | null
  workspacePath?: string
  onReview: (candidateId: string) => void
  onPromote: (candidateId: string) => void
  onDiscard: (candidateId: string) => void
}) {
  const { candidate } = props
  const busy = props.busyCandidateId === candidate.candidateId
  const reviewing = props.reviewCandidateId === candidate.candidateId
  const resolvable = fanoutCandidateCanResolve(candidate) && !props.busyCandidateId
  const diffStat = formatFanoutDiffStat(candidate.diffStat)
  return (
    <div
      className="fanout-candidate-card"
      style={{
        border: '1px solid var(--border-soft, rgba(127,127,127,0.25))',
        borderRadius: '10px',
        padding: 'var(--space-sm)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-sm)'
        }}
      >
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
          {fanoutCandidateTitle(candidate)}
        </span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          {fanoutCandidateStatusLabel(candidate)}
        </span>
      </div>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-muted)',
          marginTop: '2px',
          display: 'flex',
          gap: 'var(--space-sm)',
          flexWrap: 'wrap'
        }}
      >
        <span>{candidate.provider}</span>
        {diffStat && <span>{diffStat}</span>}
        <span>{candidate.branch}</span>
      </div>
      {candidate.reason && (
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--danger)',
            marginTop: 'var(--space-xs)'
          }}
        >
          {candidate.reason}
        </div>
      )}
      {candidate.status === 'settled' && (
        <div style={{ display: 'flex', gap: 'var(--space-xs)', marginTop: 'var(--space-sm)' }}>
          <PillButton
            variant="ghost"
            size="compact"
            onClick={() => props.onReview(candidate.candidateId)}
          >
            {reviewing ? 'Hide diff' : 'Review diff'}
          </PillButton>
          <PillButton
            size="compact"
            disabled={!resolvable}
            onClick={() => props.onPromote(candidate.candidateId)}
          >
            {busy ? 'Working…' : 'Promote'}
          </PillButton>
          <PillButton
            variant="ghost"
            size="compact"
            disabled={!resolvable}
            onClick={() => props.onDiscard(candidate.candidateId)}
          >
            Discard
          </PillButton>
        </div>
      )}
      {reviewing && (
        <div
          style={{
            marginTop: 'var(--space-sm)',
            height: '320px',
            overflow: 'hidden',
            border: '1px solid var(--border-soft, rgba(127,127,127,0.2))',
            borderRadius: '8px'
          }}
        >
          {props.reviewError ? (
            <EmptyNote text={props.reviewError} danger />
          ) : !props.reviewDiff ? (
            <EmptyNote text="Loading diff…" />
          ) : (
            <DiffViewer diff={props.reviewDiff} workspacePath={candidate.worktreePath} />
          )}
        </div>
      )}
    </div>
  )
}

function EmptyNote(props: { text: string; danger?: boolean }) {
  return (
    <div
      style={{
        padding: 'var(--space-md)',
        color: props.danger ? 'var(--danger)' : 'var(--text-muted)',
        fontSize: 'var(--font-size-sm)'
      }}
    >
      {props.text}
    </div>
  )
}

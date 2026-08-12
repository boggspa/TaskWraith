import { useEffect, useState } from 'react'

import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import type {
  HostCommandController,
  HostCommandControllerState
} from '../lib/host/HostCommandController'
import type {
  HostProjectedMission,
  HostProjectedParticipant,
  HostProjectedQuestion,
  HostProjectedRound,
  HostProjectedRun
} from '../lib/host/hostSnapshotProjection'

export interface HostMissionControlParticipantGroup {
  readonly threadId: string
  readonly title: string
  readonly participants: readonly HostProjectedParticipant[]
}

export interface HostMissionControlModel {
  readonly phase: 'Live' | 'Cached' | 'Offline cache' | 'Unavailable' | 'Checking' | 'Not checked'
  readonly generation?: number
  readonly cursor?: number
  readonly missions: readonly HostProjectedMission[]
  readonly rounds: readonly HostProjectedRound[]
  readonly runs: readonly HostProjectedRun[]
  readonly questionReceipts: readonly HostProjectedQuestion[]
  readonly participantGroups: readonly HostMissionControlParticipantGroup[]
  readonly activeMissionCount: number
  readonly participantCount: number
}

export interface HostMissionControlProps {
  readonly state: HostProjectionState
  readonly commands?: HostCommandController | null
}

function missionPriority(status: HostProjectedMission['status']): number {
  return status === 'active' ? 0 : 1
}

function roundPriority(status: HostProjectedRound['status']): number {
  return status === 'running' ? 0 : 1
}

function describePhase(state: HostProjectionState): HostMissionControlModel['phase'] {
  if (state.status === 'loading') return 'Checking'
  if (state.status === 'idle') return 'Not checked'
  if (state.status === 'unavailable') return state.projection ? 'Offline cache' : 'Unavailable'
  return state.projection?.freshness === 'live' ? 'Live' : 'Cached'
}

/** Pure projection shared by the compact Desktop view and its acceptance tests. */
export function projectHostMissionControl(state: HostProjectionState): HostMissionControlModel {
  const projection = state.projection
  if (!projection) {
    return {
      phase: describePhase(state),
      missions: [],
      rounds: [],
      runs: [],
      questionReceipts: [],
      participantGroups: [],
      activeMissionCount: 0,
      participantCount: 0
    }
  }

  const missions = [...projection.missions].sort((left, right) => {
    const priority = missionPriority(left.status) - missionPriority(right.status)
    if (priority !== 0) return priority
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.missionId.localeCompare(right.missionId)
  })
  const rounds = [...projection.rounds].sort((left, right) => {
    const priority = roundPriority(left.status) - roundPriority(right.status)
    if (priority !== 0) return priority
    const leftAt = left.endedAt ?? left.startedAt ?? 0
    const rightAt = right.endedAt ?? right.startedAt ?? 0
    if (leftAt !== rightAt) return rightAt - leftAt
    return left.roundId.localeCompare(right.roundId)
  })
  const threadTitles = new Map(projection.threads.map((thread) => [thread.id, thread.title]))
  const participantsByThread = new Map<string, HostProjectedParticipant[]>()
  for (const participant of projection.participants) {
    const group = participantsByThread.get(participant.threadId) ?? []
    group.push(participant)
    participantsByThread.set(participant.threadId, group)
  }
  const participantGroups = [...participantsByThread.entries()]
    .map(([threadId, participants]) => ({
      threadId,
      title: threadTitles.get(threadId) ?? 'Thread',
      participants: [...participants].sort(
        (left, right) => left.order - right.order || left.id.localeCompare(right.id)
      )
    }))
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title) || left.threadId.localeCompare(right.threadId)
    )

  const questionReceipts = projection.questions
    .filter((question) => question.status !== 'open' && Boolean(question.receiptId))
    .sort((left, right) => {
      const leftAt = left.answeredAt ?? left.askedAt
      const rightAt = right.answeredAt ?? right.askedAt
      if (leftAt !== rightAt) return rightAt - leftAt
      return left.questionId.localeCompare(right.questionId)
    })
    .slice(0, 10)

  return {
    phase: describePhase(state),
    generation: projection.generation,
    cursor: projection.cursor,
    missions,
    rounds,
    runs: projection.runs,
    questionReceipts,
    participantGroups,
    activeMissionCount: missions.filter((mission) => mission.status === 'active').length,
    participantCount: projection.participants.length
  }
}

function statusClass(status: string): string {
  if (status === 'active' || status === 'running' || status === 'completed') return status
  if (status === 'blocked' || status === 'failed') return status
  return 'muted'
}

function participantDetail(participant: HostProjectedParticipant): string {
  return [participant.providerId, participant.modelId, participant.stage, participant.status]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
}

function roundProviderOutcomes(
  round: HostProjectedRound,
  runById: ReadonlyMap<string, HostProjectedRun>
): string {
  return round.providerRunIds
    .map((runId) => runById.get(runId))
    .filter((run): run is HostProjectedRun => Boolean(run))
    .map((run) => `${run.providerId}: ${run.providerOutcome}`)
    .join(' · ')
}

function commandStateFor(commands: HostCommandController | null | undefined) {
  return (
    commands?.getState() ??
    ({ busy: false, approvalBusy: false } satisfies HostCommandControllerState)
  )
}

export function HostMissionControl({ state, commands }: HostMissionControlProps) {
  const [commandState, setCommandState] = useState<HostCommandControllerState>(() =>
    commandStateFor(commands)
  )
  useEffect(() => {
    setCommandState(commandStateFor(commands))
    return commands?.subscribe(setCommandState)
  }, [commands])

  const model = projectHostMissionControl(state)
  const summary = `${model.activeMissionCount} active · ${model.participantCount} participant${
    model.participantCount === 1 ? '' : 's'
  }`
  const runById = new Map(model.runs.map((run) => [run.runId, run]))
  const activeRunThreadIds = [
    ...new Set(
      model.runs.filter((run) => run.providerOutcome === 'running').map((run) => run.threadId)
    )
  ]
  const canMutate =
    Boolean(commands) && state.status === 'live' && state.projection?.freshness === 'live'
  const threadTitle = new Map(state.projection?.threads.map((thread) => [thread.id, thread.title]))

  const submitRunCancel = (threadId: string): void => {
    if (!commands || !canMutate) return
    void commands.submit({ name: 'run.cancel', target: { threadId } })
  }

  const submitSeatToggle = (participant: HostProjectedParticipant): void => {
    if (!commands || !canMutate) return
    void commands.submit({
      name: 'ensemble.seat.toggle',
      target: { threadId: participant.threadId },
      arguments: { participantId: participant.id, enabled: !participant.enabled }
    })
  }

  return (
    <details className="host-mission-control" aria-label="Mission Control">
      <summary aria-label={`Mission Control, ${summary}`}>
        <span className="host-mission-control-summary-copy">
          <span className="host-mission-control-title">Mission Control</span>
          <span className="host-mission-control-summary">{summary}</span>
        </span>
        <span className="host-mission-control-chevron" aria-hidden>
          ›
        </span>
      </summary>

      <div className="host-mission-control-body">
        <div className="host-mission-control-position" role="status" aria-live="polite">
          <span
            className={`host-mission-control-dot is-${model.phase === 'Live' ? 'live' : 'stale'}`}
            aria-hidden
          />
          <span>{model.phase}</span>
          {model.generation !== undefined && model.cursor !== undefined ? (
            <span className="host-mission-control-cursor">
              Generation {model.generation} · Cursor {model.cursor}
            </span>
          ) : (
            <span className="host-mission-control-cursor">Waiting for a Host snapshot</span>
          )}
        </div>

        {commandState.notice ? (
          <div
            className={`host-mission-control-notice is-${commandState.notice.tone}`}
            role="status"
            aria-live="polite"
          >
            {commandState.notice.text}
          </div>
        ) : null}

        {commandState.pending ? (
          <section className="host-mission-control-section" aria-labelledby="host-command-title">
            <h3 id="host-command-title">Host approval</h3>
            <div className="host-mission-control-command-card">
              <span>
                {commandState.pending.approvalId
                  ? `Approve ${commandState.pending.name}`
                  : `Waiting for ${commandState.pending.name} approval card`}
              </span>
              {commandState.pending.approvalId && commands ? (
                <div className="host-mission-control-actions">
                  <button
                    type="button"
                    disabled={commandState.approvalBusy}
                    onClick={() => void commands.decidePendingApproval('accept')}
                  >
                    Allow once
                  </button>
                  <button
                    type="button"
                    disabled={commandState.approvalBusy}
                    onClick={() => void commands.decidePendingApproval('acceptForSession')}
                  >
                    Allow session
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    disabled={commandState.approvalBusy}
                    onClick={() => void commands.decidePendingApproval('decline')}
                  >
                    Deny
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {!state.projection ? (
          <div className="host-mission-control-empty">
            No coherent Host projection is available.
          </div>
        ) : (
          <>
            {activeRunThreadIds.length > 0 ? (
              <section
                className="host-mission-control-section"
                aria-labelledby="host-actions-title"
              >
                <h3 id="host-actions-title">Governed actions</h3>
                <div className="host-mission-control-timeline">
                  {activeRunThreadIds.map((threadId) => (
                    <div className="host-mission-control-command-card" key={threadId}>
                      <span>{threadTitle.get(threadId) ?? 'Active thread'}</span>
                      <button
                        type="button"
                        className="is-danger"
                        disabled={!canMutate || commandState.busy}
                        onClick={() => submitRunCancel(threadId)}
                      >
                        Cancel run
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="host-mission-control-section" aria-labelledby="host-missions-title">
              <h3 id="host-missions-title">Mission timeline</h3>
              {model.missions.length === 0 ? (
                <div className="host-mission-control-empty">No Host missions yet.</div>
              ) : (
                <div className="host-mission-control-timeline">
                  {model.missions.map((mission) => (
                    <article
                      className="host-mission-control-row"
                      key={mission.missionId}
                      aria-label={`${mission.title}, ${mission.status}`}
                    >
                      <span
                        className={`host-mission-control-dot is-${statusClass(mission.status)}`}
                        aria-hidden
                      />
                      <span className="host-mission-control-row-copy">
                        <strong>{mission.title}</strong>
                        <span>
                          {mission.status}
                          {mission.activeRoundId ? ` · ${mission.activeRoundId}` : ''}
                        </span>
                      </span>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {model.rounds.length > 0 ? (
              <section className="host-mission-control-section" aria-labelledby="host-rounds-title">
                <h3 id="host-rounds-title">Round timeline</h3>
                <div className="host-mission-control-timeline">
                  {model.rounds.map((round) => {
                    const routing = round.routing ?? state.projection?.routing
                    const outcomes = roundProviderOutcomes(round, runById)
                    return (
                      <article
                        className="host-mission-control-row"
                        key={round.roundId}
                        aria-label={`Round ${round.status}, ${round.participantIds.length} participants`}
                      >
                        <span
                          className={`host-mission-control-dot is-${statusClass(round.status)}`}
                          aria-hidden
                        />
                        <span className="host-mission-control-row-copy">
                          <strong>
                            {round.status} · {round.participantIds.length} seats
                          </strong>
                          {routing ? (
                            <span>
                              {routing.mode} · {routing.fanout}
                              {routing.continuationHops !== undefined &&
                              routing.maxContinuationHops !== undefined
                                ? ` · ${routing.continuationHops}/${routing.maxContinuationHops}`
                                : ''}
                            </span>
                          ) : null}
                          {outcomes ? <span>{outcomes}</span> : null}
                        </span>
                      </article>
                    )
                  })}
                </div>
              </section>
            ) : null}

            {model.questionReceipts.length > 0 ? (
              <section
                className="host-mission-control-section"
                aria-labelledby="host-question-receipts-title"
              >
                <h3 id="host-question-receipts-title">Recent question receipts</h3>
                <div className="host-mission-control-timeline">
                  {model.questionReceipts.map((question) => (
                    <article
                      className="host-mission-control-row"
                      key={question.questionId}
                      aria-label={`${question.promptPreview}, ${question.status}, receipt ${question.receiptId}`}
                    >
                      <span
                        className={`host-mission-control-dot is-${statusClass(question.status)}`}
                        aria-hidden
                      />
                      <span className="host-mission-control-row-copy">
                        <strong>{question.promptPreview}</strong>
                        <span>{question.status}</span>
                        <code className="host-mission-control-receipt">
                          Receipt {question.receiptId}
                        </code>
                      </span>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {model.participantGroups.map((group) => (
              <section
                className="host-mission-control-section"
                aria-labelledby={`host-participants-${group.threadId}`}
                key={group.threadId}
              >
                <h3 id={`host-participants-${group.threadId}`}>
                  {group.title} · {group.participants.length}
                </h3>
                <div className="host-mission-control-participants" role="list">
                  {group.participants.map((participant) => (
                    <div
                      className={`host-mission-control-participant${
                        participant.enabled ? '' : ' is-disabled'
                      }`}
                      key={`${participant.threadId}:${participant.id}`}
                      role="listitem"
                      aria-label={`${participant.role}, ${participant.providerId}, ${
                        participant.active ? 'active' : (participant.status ?? 'idle')
                      }, ${participant.enabled ? 'enabled' : 'disabled'}`}
                    >
                      <span
                        className={`host-mission-control-dot is-${
                          participant.active ? 'running' : 'muted'
                        }`}
                        aria-hidden
                      />
                      <span className="host-mission-control-row-copy">
                        <strong>{participant.role}</strong>
                        <span>{participantDetail(participant)}</span>
                      </span>
                      {commands ? (
                        <button
                          type="button"
                          className="host-mission-control-seat-toggle"
                          disabled={!canMutate || commandState.busy}
                          onClick={() => submitSeatToggle(participant)}
                        >
                          {participant.enabled ? 'Disable' : 'Enable'}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </details>
  )
}

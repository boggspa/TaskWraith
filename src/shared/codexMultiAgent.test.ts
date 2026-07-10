import { describe, expect, it } from 'vitest'
import {
  applyCodexChildTurnEvent,
  applyCodexCollabToolCall,
  applyCodexSubAgentActivity,
  codexAgentPathTaskName,
  codexMultiAgentEpisodeId,
  codexMultiAgentStartTelemetry,
  CODEX_MULTI_AGENT_TOOL_NAME,
  finalizeCodexMultiAgent,
  isCodexMultiAgentCoordinationItemType,
  isCodexMultiAgentToolName,
  mergeCodexMultiAgentTelemetry,
  type CodexMultiAgentTelemetry
} from './codexMultiAgent'

/**
 * Fixtures mirror the REAL `codex app-server` 0.144.0 item shapes captured
 * live (subAgentActivity / collabAgentToolCall on the parent thread; child
 * threads settle via their own turn events). Ids are synthetic and secret-safe;
 * no encrypted payloads are reproduced.
 */

const SPAWN_ONE = {
  type: 'subAgentActivity',
  id: 'call_fixture_spawn_one',
  kind: 'started',
  agentThreadId: '00000000-0000-7000-8000-00000000a001',
  agentPath: '/root/audit_css'
}

const SPAWN_TWO = {
  type: 'subAgentActivity',
  id: 'call_fixture_spawn_two',
  kind: 'started',
  agentThreadId: '00000000-0000-7000-8000-00000000a002',
  agentPath: '/root/audit_tests'
}

const WAIT_IN_PROGRESS = {
  type: 'collabAgentToolCall',
  id: 'call_fixture_wait',
  tool: 'wait',
  status: 'inProgress',
  senderThreadId: '00000000-0000-7000-8000-00000000p000',
  receiverThreadIds: [],
  prompt: null,
  model: null,
  reasoningEffort: null,
  agentsStates: {}
}

const WAIT_COMPLETED = { ...WAIT_IN_PROGRESS, status: 'completed' }

function startedEpisode(): CodexMultiAgentTelemetry {
  return codexMultiAgentStartTelemetry({
    episodeId: codexMultiAgentEpisodeId(
      '00000000-0000-7000-8000-00000000p000',
      '00000000-0000-7000-8000-00000000t000'
    ),
    startedAtMs: 1_000
  })
}

describe('identity + classification helpers', () => {
  it('recognizes the synthesized anchor tool name', () => {
    expect(isCodexMultiAgentToolName(CODEX_MULTI_AGENT_TOOL_NAME)).toBe(true)
    expect(isCodexMultiAgentToolName('Codex_Multi_Agent')).toBe(true)
    expect(isCodexMultiAgentToolName('codex_review')).toBe(false)
    expect(isCodexMultiAgentToolName(undefined)).toBe(false)
  })

  it('classifies exactly the coordination item types (Tool-viewport exclusion)', () => {
    expect(isCodexMultiAgentCoordinationItemType('subAgentActivity')).toBe(true)
    expect(isCodexMultiAgentCoordinationItemType('collabAgentToolCall')).toBe(true)
    // Genuine child tool work must NOT be classified as coordination.
    expect(isCodexMultiAgentCoordinationItemType('commandExecution')).toBe(false)
    expect(isCodexMultiAgentCoordinationItemType('fileChange')).toBe(false)
    expect(isCodexMultiAgentCoordinationItemType('mcpToolCall')).toBe(false)
    expect(isCodexMultiAgentCoordinationItemType('agentMessage')).toBe(false)
    expect(isCodexMultiAgentCoordinationItemType(undefined)).toBe(false)
  })

  it('builds a stable episode id from parent thread + turn', () => {
    expect(codexMultiAgentEpisodeId('t-1', 'u-1')).toBe('t-1:u-1')
    expect(codexMultiAgentEpisodeId('t-1', 'u-1')).toBe(codexMultiAgentEpisodeId('t-1', 'u-1'))
    expect(codexMultiAgentEpisodeId(undefined, undefined)).toBe('thread:turn')
  })

  it('derives the plaintext task label from the agent path tail', () => {
    expect(codexAgentPathTaskName('/root/ready_one')).toBe('ready_one')
    expect(codexAgentPathTaskName('/root/nested/deep_task')).toBe('deep_task')
    expect(codexAgentPathTaskName('')).toBeUndefined()
    expect(codexAgentPathTaskName(undefined)).toBeUndefined()
  })
})

describe('fully observed lifecycle', () => {
  it('walks delegating → working → synthesizing → completed with synthesis', () => {
    let telemetry = startedEpisode()
    expect(telemetry.status).toBe('delegating')
    expect(telemetry.detailLevel).toBe('detected')

    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_TWO, 1_200)
    expect(telemetry.detailLevel).toBe('full')
    expect(telemetry.subagents).toHaveLength(2)
    expect(telemetry.subagents?.[0]).toMatchObject({
      id: 'call_fixture_spawn_one',
      taskName: 'audit_css',
      status: 'spawned'
    })

    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_ONE.agentThreadId,
      kind: 'started',
      atMs: 1_300
    })
    expect(telemetry.status).toBe('working')

    telemetry = applyCodexCollabToolCall(telemetry, WAIT_IN_PROGRESS, 'started')
    expect(telemetry.coordinationEvents).toBe(1)
    expect(telemetry.lastCoordination).toBe('wait')

    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_ONE.agentThreadId,
      kind: 'completed',
      atMs: 2_000
    })
    expect(telemetry.status).toBe('working') // second agent still spawned
    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_TWO.agentThreadId,
      kind: 'completed',
      atMs: 2_100
    })
    expect(telemetry.status).toBe('synthesizing')

    telemetry = applyCodexCollabToolCall(telemetry, WAIT_COMPLETED, 'completed')
    // completion of the wait does not add a second coordination count
    expect(telemetry.coordinationEvents).toBe(1)

    const finalized = finalizeCodexMultiAgent(telemetry, {
      outcome: 'completed',
      durationMs: 12_000,
      totalTokens: 29_070
    })
    expect(finalized.status).toBe('completed')
    expect(finalized.synthesized).toBe(true)
    expect(finalized.durationMs).toBe(12_000)
    expect(finalized.totalTokens).toBe(29_070)
    expect(finalized.subagents?.every((agent) => agent.status === 'completed')).toBe(true)
  })

  it('does not duplicate a subagent when raw events repeat the same spawn', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_150)
    expect(telemetry.subagents).toHaveLength(1)
  })

  it('honors a defensive terminal subAgentActivity kind for a known agent', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexSubAgentActivity(telemetry, { ...SPAWN_ONE, kind: 'completed' }, 2_000)
    expect(telemetry.subagents?.[0].status).toBe('completed')
    expect(telemetry.status).toBe('synthesizing')
  })

  it('absorbs agentsStates only for already-observed subagents', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexCollabToolCall(
      telemetry,
      {
        ...WAIT_IN_PROGRESS,
        agentsStates: {
          [SPAWN_ONE.agentThreadId]: 'running',
          '00000000-0000-7000-8000-00000000dead': 'running' // never observed → ignored
        }
      },
      'started'
    )
    expect(telemetry.subagents).toHaveLength(1)
    expect(telemetry.subagents?.[0].status).toBe('working')
  })

  it('marks interrupt_agent receivers as interrupted', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexCollabToolCall(
      telemetry,
      {
        type: 'collabAgentToolCall',
        id: 'call_fixture_interrupt',
        tool: 'interrupt_agent',
        status: 'completed',
        receiverThreadIds: [SPAWN_ONE.agentThreadId],
        agentsStates: {}
      },
      'started'
    )
    expect(telemetry.subagents?.[0].status).toBe('interrupted')
  })
})

describe('detected-only lifecycle (identities unavailable)', () => {
  it('stays at detailLevel detected with no fabricated subagents or counts', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexCollabToolCall(telemetry, WAIT_IN_PROGRESS, 'started')
    expect(telemetry.detailLevel).toBe('detected')
    expect(telemetry.subagents).toHaveLength(0)
    expect(telemetry.coordinationEvents).toBe(1)
    expect(telemetry.status).toBe('delegating')

    const finalized = finalizeCodexMultiAgent(telemetry, { outcome: 'completed' })
    expect(finalized.status).toBe('completed')
    // Synthesis was never observed — must not be claimed.
    expect(finalized.synthesized).toBe(false)
  })
})

describe('no fabrication', () => {
  it('ignores child turn events for unknown agent threads', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    const before = telemetry
    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: '00000000-0000-7000-8000-00000000dead',
      kind: 'completed',
      atMs: 2_000
    })
    expect(telemetry).toBe(before)
    expect(telemetry.subagents?.[0].status).toBe('spawned')
  })

  it('ignores malformed items without inventing state', () => {
    const telemetry = startedEpisode()
    expect(applyCodexSubAgentActivity(telemetry, null, 1_000)).toBe(telemetry)
    expect(applyCodexCollabToolCall(telemetry, 'not-an-object', 'started')).toBe(telemetry)
  })
})

describe('failure + interruption', () => {
  it('finalizes a failed parent turn without claiming synthesis', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    const finalized = finalizeCodexMultiAgent(telemetry, {
      outcome: 'failed',
      error: 'boom'
    })
    expect(finalized.status).toBe('failed')
    expect(finalized.error).toBe('boom')
    expect(finalized.synthesized).toBe(false)
    // The subagent's last observed state is preserved, not fabricated.
    expect(finalized.subagents?.[0].status).toBe('spawned')
  })

  it('never claims synthesis when every subagent failed — even on a completed parent turn', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_TWO, 1_200)
    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_ONE.agentThreadId,
      kind: 'failed',
      atMs: 2_000
    })
    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_TWO.agentThreadId,
      kind: 'failed',
      atMs: 2_100
    })
    // All settled but none completed: no results exist, so no synthesis phase.
    expect(telemetry.status).toBe('working')
    const finalized = finalizeCodexMultiAgent(telemetry, { outcome: 'completed' })
    expect(finalized.status).toBe('completed')
    expect(finalized.synthesized).toBe(false)
    expect(finalized.subagents?.every((agent) => agent.status === 'failed')).toBe(true)
  })

  it('still reaches synthesizing with a mixed settle (one completed, one failed)', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_TWO, 1_200)
    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_ONE.agentThreadId,
      kind: 'completed',
      atMs: 2_000
    })
    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_TWO.agentThreadId,
      kind: 'failed',
      atMs: 2_100
    })
    expect(telemetry.status).toBe('synthesizing')
    const finalized = finalizeCodexMultiAgent(telemetry, { outcome: 'completed' })
    expect(finalized.synthesized).toBe(true)
  })

  it('interrupts still-live subagents when the episode is interrupted', () => {
    let telemetry = startedEpisode()
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_ONE, 1_100)
    telemetry = applyCodexSubAgentActivity(telemetry, SPAWN_TWO, 1_200)
    telemetry = applyCodexChildTurnEvent(telemetry, {
      agentThreadId: SPAWN_ONE.agentThreadId,
      kind: 'completed',
      atMs: 2_000
    })
    const finalized = finalizeCodexMultiAgent(telemetry, { outcome: 'interrupted' })
    expect(finalized.status).toBe('interrupted')
    expect(finalized.subagents?.[0].status).toBe('completed') // real completion preserved
    expect(finalized.subagents?.[1].status).toBe('interrupted')
  })
})

describe('mergeCodexMultiAgentTelemetry', () => {
  it('never downgrades a terminal status via a late frame', () => {
    const settled: CodexMultiAgentTelemetry = { provider: 'codex', status: 'completed' }
    const merged = mergeCodexMultiAgentTelemetry(settled, { status: 'working' })
    expect(merged.status).toBe('completed')
  })

  it('skips empty patch fields', () => {
    const merged = mergeCodexMultiAgentTelemetry(
      { provider: 'codex', status: 'working', lastCoordination: 'wait' },
      { lastCoordination: '', error: undefined }
    )
    expect(merged.lastCoordination).toBe('wait')
    expect(merged.error).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import {
  RECALL_MCP_TOOL_NAMES,
  createRecallToolExecutors,
  isRecallMcpToolName,
  type RecallToolExecutorDeps
} from './RecallToolExecutors'
import type { RunEventRecord, RunQueueJob, WorkspaceRecord } from '../store/types'

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()

function ws(over: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: 'x',
    path: '/x',
    displayName: 'x',
    createdAt: 1,
    lastOpenedAt: 1,
    pinned: false,
    ...over
  }
}

const WORKSPACES: WorkspaceRecord[] = [
  ws({ id: 'ws-pay', displayName: 'Payments', path: '/code/payments' }),
  ws({ id: 'ws-home', displayName: 'Home', path: '/code/home' })
]

function job(over: Partial<RunQueueJob>): RunQueueJob {
  const at = new Date(2026, 5, 14, 18, 2).toISOString()
  return {
    id: over.runId ?? 'job',
    runId: 'run',
    provider: 'ollama',
    source: 'user',
    status: 'completed',
    priority: 0,
    attempt: 0,
    workspaceId: 'ws-home',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    ...over
  } as RunQueueJob
}

function ev(over: Partial<RunEventRecord>): RunEventRecord {
  return {
    schemaVersion: 1,
    id: over.id ?? 's',
    sequence: over.sequence ?? 1,
    runId: over.runId ?? 'run',
    kind: over.kind ?? 'tool',
    phase: over.phase ?? 'normalized',
    source: over.source ?? 'main',
    timestamp: over.timestamp ?? new Date(2026, 5, 14, 18, 2).toISOString(),
    ...over
  } as RunEventRecord
}

function deps(over: Partial<RecallToolExecutorDeps> = {}): RecallToolExecutorDeps {
  return {
    listRunQueueJobs: () => [],
    getWorkspaces: () => WORKSPACES,
    resolveCallerWorkspaceId: () => 'ws-home',
    loadChatText: () => null,
    isForensicsAvailable: () => true,
    getRunQueueJob: () => null,
    getRunEvents: () => [],
    loadFinalAssistantMessage: () => null,
    mintCitationToken: ({ kind }) => `tok-${kind}`,
    resolveRecallAccess: async () => ({ allowed: true }),
    now: () => NOW,
    ...over
  }
}

async function find(
  args: Record<string, unknown>,
  d: RecallToolExecutorDeps
): Promise<Record<string, unknown>> {
  const { executeRecallTool } = createRecallToolExecutors(d)
  const res = await executeRecallTool('tw_recall_find', args, {}, 'claude')
  return res.structuredContent as Record<string, unknown>
}

describe('isRecallMcpToolName', () => {
  it('matches the recall family and nothing else', () => {
    for (const name of RECALL_MCP_TOOL_NAMES) expect(isRecallMcpToolName(name)).toBe(true)
    expect(isRecallMcpToolName('canvas_open')).toBe(false)
    expect(isRecallMcpToolName('run_timeline')).toBe(false)
  })
})

describe('tw_recall_find executor', () => {
  it('searches the caller own workspace by default (crossWorkspace=false)', async () => {
    const out = await find(
      {},
      deps({ listRunQueueJobs: () => [job({ runId: 'r1', workspaceId: 'ws-home' })] })
    )
    expect(out.crossWorkspace).toBe(false)
    expect(out.matchKind).toBe('one')
    expect((out.candidates as Array<{ runId: string }>)[0].runId).toBe('r1')
  })

  it('flags a named different workspace as crossWorkspace', async () => {
    const out = await find(
      { workspace: 'Payments' },
      deps({ listRunQueueJobs: () => [job({ runId: 'r1', workspaceId: 'ws-pay' })] })
    )
    expect(out.crossWorkspace).toBe(true)
    expect(out.matchKind).toBe('one')
  })

  it('refuses (none + note) when there is no workspace to scope to', async () => {
    const out = await find({}, deps({ resolveCallerWorkspaceId: () => null }))
    expect(out.matchKind).toBe('none')
    expect(String(out.note)).toMatch(/which workspace/i)
  })

  it('passes the normalized provider to the run-queue filter', async () => {
    let captured: { provider?: string; includeTerminal?: boolean } = {}
    await find(
      { provider: 'the local model' },
      deps({
        listRunQueueJobs: (f) => {
          captured = f
          return []
        }
      })
    )
    expect(captured.provider).toBe('ollama')
    expect(captured.includeTerminal).toBe(true)
  })

  it('honors the remote-allowlist visibility gate', async () => {
    const out = await find(
      { workspace: 'Payments' },
      deps({ isWorkspaceVisibleToCaller: () => false })
    )
    expect(out.matchKind).toBe('none')
    expect(String(out.note)).toMatch(/allowlist/i)
  })

  it('excludes runs whose forensics are gone', async () => {
    const out = await find(
      {},
      deps({
        listRunQueueJobs: () => [
          job({ runId: 'live', workspaceId: 'ws-home' }),
          job({ runId: 'dead', workspaceId: 'ws-home' })
        ],
        isForensicsAvailable: (runId) => runId !== 'dead'
      })
    )
    expect((out.candidates as Array<{ runId: string }>).map((c) => c.runId)).toEqual(['live'])
  })

  it('never leaks the prompt preview, and caps to the requested limit', async () => {
    const jobs = Array.from({ length: 8 }, (_, i) =>
      job({ runId: `r${i}`, workspaceId: 'ws-home', promptPreview: 'SECRET_TOKEN=sk-xyz' })
    )
    const out = await find({ limit: 3 }, deps({ listRunQueueJobs: () => jobs }))
    expect(out.candidates).toHaveLength(3)
    expect(JSON.stringify(out.candidates)).not.toContain('SECRET_TOKEN')
  })
})

function readDeps(): RecallToolExecutorDeps {
  return deps({
    getRunQueueJob: () =>
      job({
        runId: 'r1',
        workspaceId: 'ws-home',
        status: 'failed',
        startedAt: new Date(2026, 5, 14, 18, 0).toISOString(),
        failedAt: new Date(2026, 5, 14, 18, 10).toISOString(),
        chatId: 'c1'
      }),
    getRunEvents: () => [
      ev({ runId: 'r1', kind: 'lifecycle', sequence: 1, payload: { status: 'started' } }),
      ev({ runId: 'r1', kind: 'tool', sequence: 2 }),
      ev({ runId: 'r1', kind: 'diff', sequence: 3 }),
      ev({ runId: 'r1', kind: 'lifecycle', sequence: 4, payload: { status: 'failed' } })
    ],
    loadFinalAssistantMessage: () => 'Wired the endpoint but the new tests are red.',
    loadPlanProgress: () => ({ done: 4, total: 7 }),
    mintCitationToken: ({ runId, kind }) => `recall:${runId}:${kind}`
  })
}

async function callTool(
  name: 'tw_recall_read' | 'tw_recall_read_events',
  args: Record<string, unknown>,
  d: RecallToolExecutorDeps
): Promise<{ structuredContent: Record<string, unknown>; isError?: boolean }> {
  const { executeRecallTool } = createRecallToolExecutors(d)
  const res = await executeRecallTool(name, args, {}, 'claude')
  return {
    structuredContent: res.structuredContent as Record<string, unknown>,
    isError: res.isError
  }
}

describe('tw_recall_read', () => {
  it('returns a rollup + final message + plan progress + citation token', async () => {
    const { structuredContent: out } = await callTool('tw_recall_read', { runId: 'r1' }, readDeps())
    expect(out.available).toBe(true)
    expect(out.status).toBe('failed')
    expect(String(out.finalMessage)).toContain('tests are red')
    expect(out.planProgress).toEqual({ done: 4, total: 7 })
    expect((out.counts as Record<string, number>).tool).toBe(1)
    expect(out.durationMs).toBe(10 * 60 * 1000)
    expect(out.citationToken).toBe('recall:r1:read')
    expect(out.timeline).toBeUndefined()
  })

  it('includes a bounded timeline at depth=full', async () => {
    const { structuredContent: out } = await callTool(
      'tw_recall_read',
      { runId: 'r1', depth: 'full' },
      readDeps()
    )
    expect((out.timeline as unknown[]).length).toBe(4)
  })

  it('fails closed when the run forensics are gone', async () => {
    const { structuredContent: out } = await callTool(
      'tw_recall_read',
      { runId: 'r1' },
      deps({ isForensicsAvailable: () => false })
    )
    expect(out.available).toBe(false)
    expect(out.reason).toBe('forensics_deleted')
  })

  it('errors when runId is missing', async () => {
    const { isError } = await callTool('tw_recall_read', {}, readDeps())
    expect(isError).toBe(true)
  })
})

describe('tw_recall_read_events', () => {
  it('returns bounded raw events + a compaction disclaimer', async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      ev({ sequence: i + 1, kind: i % 2 ? 'tool' : 'diff', summary: `e${i}` })
    )
    const { structuredContent: out } = await callTool(
      'tw_recall_read_events',
      { runId: 'r1', limit: 10 },
      deps({ getRunEvents: () => events, mintCitationToken: () => 'tok' })
    )
    expect(out.count).toBe(10)
    expect(out.truncated).toBe(true)
    expect(String(out.disclaimer)).toMatch(/compacted/i)
    expect(out.citationToken).toBe('tok')
  })

  it('filters events by kind', async () => {
    const events = [
      ev({ sequence: 1, kind: 'tool' }),
      ev({ sequence: 2, kind: 'diff' }),
      ev({ sequence: 3, kind: 'tool' })
    ]
    const { structuredContent: out } = await callTool(
      'tw_recall_read_events',
      { runId: 'r1', kind: 'tool' },
      deps({ getRunEvents: () => events })
    )
    expect(out.count).toBe(2)
  })
})

describe('recall access gate (Gaps A+B)', () => {
  it('reports crossWorkspace=false for the caller own workspace (auto-allow path)', async () => {
    let captured: { crossWorkspace?: boolean } = {}
    await find(
      {},
      deps({
        listRunQueueJobs: () => [job({ runId: 'r1', workspaceId: 'ws-home' })],
        resolveRecallAccess: async (input) => {
          captured = input
          return { allowed: true }
        }
      })
    )
    expect(captured.crossWorkspace).toBe(false)
  })

  it('reports crossWorkspace=true for a different named workspace', async () => {
    let captured: { crossWorkspace?: boolean } = {}
    await find(
      { workspace: 'Payments' },
      deps({
        listRunQueueJobs: () => [job({ runId: 'r1', workspaceId: 'ws-pay' })],
        resolveRecallAccess: async (input) => {
          captured = input
          return { allowed: true }
        }
      })
    )
    expect(captured.crossWorkspace).toBe(true)
  })

  it('blocks find when the gate refuses — no candidates leaked', async () => {
    const out = await find(
      { workspace: 'Payments' },
      deps({
        listRunQueueJobs: () => [job({ runId: 'r1', workspaceId: 'ws-pay' })],
        resolveRecallAccess: async () => ({ allowed: false, reason: 'declined' })
      })
    )
    expect(out.blocked).toBe(true)
    expect(out.candidates).toEqual([])
  })

  it('blocks read with a reason-specific message (remote)', async () => {
    const { structuredContent: out } = await callTool(
      'tw_recall_read',
      { runId: 'r1' },
      deps({
        getRunQueueJob: () => job({ runId: 'r1', workspaceId: 'ws-pay' }),
        resolveRecallAccess: async () => ({ allowed: false, reason: 'remote_blocked' })
      })
    )
    expect(out.blocked).toBe(true)
    expect(out.available).toBe(false)
    expect(String(out.message)).toMatch(/phone-issued/i)
  })

  it('gates read by the run target workspace vs the caller', async () => {
    let captured: { crossWorkspace?: boolean } = {}
    await callTool(
      'tw_recall_read',
      { runId: 'r1' },
      deps({
        getRunQueueJob: () => job({ runId: 'r1', workspaceId: 'ws-pay' }),
        getRunEvents: () => [ev({ runId: 'r1', kind: 'lifecycle' })],
        resolveRecallAccess: async (input) => {
          captured = input
          return { allowed: true }
        }
      })
    )
    expect(captured.crossWorkspace).toBe(true)
  })
})

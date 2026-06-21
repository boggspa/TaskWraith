import { describe, expect, it } from 'vitest'
import {
  RECALL_MCP_TOOL_NAMES,
  createRecallToolExecutors,
  isRecallMcpToolName,
  type RecallToolExecutorDeps
} from './RecallToolExecutors'
import type { RunQueueJob, WorkspaceRecord } from '../store/types'

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

function deps(over: Partial<RecallToolExecutorDeps> = {}): RecallToolExecutorDeps {
  return {
    listRunQueueJobs: () => [],
    getWorkspaces: () => WORKSPACES,
    resolveCallerWorkspaceId: () => 'ws-home',
    loadChatText: () => null,
    isForensicsAvailable: () => true,
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

describe('recall read verbs (slice 2 — still inert)', () => {
  it('returns not-implemented for read + read_events', async () => {
    const { executeRecallTool } = createRecallToolExecutors(deps())
    for (const name of ['tw_recall_read', 'tw_recall_read_events'] as const) {
      const res = await executeRecallTool(name, { runId: 'r1' }, {}, 'claude')
      expect(res.isError).toBe(true)
      expect(res.text).toContain('not implemented')
    }
  })
})

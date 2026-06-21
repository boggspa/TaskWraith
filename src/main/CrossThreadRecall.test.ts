import { describe, expect, it } from 'vitest'
import {
  normalizeProviderQuery,
  resolveRecall,
  resolveTimeWindow,
  RECALL_TOP_K,
  type RecallResolverContext
} from './CrossThreadRecall'
import type { RunQueueJob, WorkspaceRecord } from './store/types'

// All instants are built from LOCAL date components and compared in absolute
// ms, so these tests are stable regardless of the CI timezone (the resolver
// uses host-local boundaries on the same basis).
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime() // Mon 15 Jun 2026, 12:00 local

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
  ws({ id: 'ws-secret', displayName: 'Secrets', path: '/code/secrets' })
]

function job(over: Partial<RunQueueJob>): RunQueueJob {
  const at = new Date(2026, 5, 14, 18, 2).toISOString()
  return {
    id: over.id ?? over.runId ?? 'job',
    runId: over.runId ?? 'run',
    provider: 'ollama',
    source: 'user',
    status: 'completed',
    priority: 0,
    attempt: 0,
    workspaceId: 'ws-pay',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    ...over
  } as RunQueueJob
}

function ctx(over: Partial<RecallResolverContext> = {}): RecallResolverContext {
  return { workspaces: WORKSPACES, now: NOW, timeZone: 'TestTZ', ...over }
}

describe('normalizeProviderQuery', () => {
  it('maps aliases and exact ids to ProviderId', () => {
    expect(normalizeProviderQuery('Ollama')).toBe('ollama')
    expect(normalizeProviderQuery('the local model')).toBe('ollama')
    expect(normalizeProviderQuery('GPT')).toBe('codex')
    expect(normalizeProviderQuery('Anthropic')).toBe('claude')
    expect(normalizeProviderQuery('kimi')).toBe('kimi')
  })

  it('prefers the longest alias in a substring match', () => {
    expect(normalizeProviderQuery('local model run')).toBe('ollama')
  })

  it('still resolves retired gemini for reading history', () => {
    expect(normalizeProviderQuery('gemini')).toBe('gemini')
  })

  it('returns null for unknown / empty input', () => {
    expect(normalizeProviderQuery('mistral')).toBeNull()
    expect(normalizeProviderQuery('')).toBeNull()
    expect(normalizeProviderQuery(null)).toBeNull()
  })
})

describe('resolveTimeWindow', () => {
  it('resolves a bare day to local 00:00–23:59:59.999', () => {
    const w = resolveTimeWindow('yesterday', NOW)!
    expect(w).not.toBeNull()
    const start = new Date(w.startMs)
    const end = new Date(w.endMs)
    expect(start.getDate()).toBe(14)
    expect(start.getHours()).toBe(0)
    expect(end.getDate()).toBe(14)
    expect(end.getHours()).toBe(23)
  })

  it('resolves a focal clock and clamps the window to the anchored day', () => {
    const w = resolveTimeWindow('yesterday ~6pm', NOW)!
    expect(new Date(w.focalMs!).getHours()).toBe(18)
    expect(new Date(w.startMs).getHours()).toBe(16)
    expect(new Date(w.endMs).getHours()).toBe(20)
    expect(new Date(w.focalMs!).getDate()).toBe(14)
  })

  it('disambiguates a bare hour using the part-of-day', () => {
    const w = resolveTimeWindow('yesterday evening around 6', NOW)!
    expect(new Date(w.focalMs!).getHours()).toBe(18)
  })

  it('handles the midnight boundary deterministically', () => {
    const justAfterMidnight = new Date(2026, 5, 15, 0, 30).getTime()
    const w = resolveTimeWindow('yesterday', justAfterMidnight)!
    expect(new Date(w.startMs).getDate()).toBe(14)
    expect(new Date(w.endMs).getDate()).toBe(14)
  })

  it('resolves multi-day ranges', () => {
    const w = resolveTimeWindow('last 3 days', NOW)!
    expect(new Date(w.startMs).getDate()).toBe(13)
    expect(w.endMs).toBe(NOW)
  })

  it('returns null when nothing temporal is recognizable', () => {
    expect(resolveTimeWindow('whenever', NOW)).toBeNull()
    expect(resolveTimeWindow('', NOW)).toBeNull()
    expect(resolveTimeWindow(null, NOW)).toBeNull()
  })
})

describe('resolveRecall', () => {
  it('returns "one" for a fully anchored single match', () => {
    const jobs = [job({ runId: 'r1', provider: 'ollama', workspaceId: 'ws-pay' })]
    const res = resolveRecall(
      { provider: 'Ollama', workspace: 'Payments', timeApprox: 'yesterday ~6pm' },
      jobs,
      ctx()
    )
    expect(res.matchKind).toBe('one')
    expect(res.candidates).toHaveLength(1)
    expect(res.candidates[0].runId).toBe('r1')
    expect(res.candidates[0].workspaceLabel).toBe('Payments')
  })

  it('canonicalizes the workspace on BOTH sides (legacy display-name id matches a uuid query)', () => {
    const jobs = [job({ runId: 'legacy', workspaceId: 'Payments' })] // legacy display-name id on the job
    const res = resolveRecall({ provider: 'Ollama', workspace: 'ws-pay' }, jobs, ctx())
    expect(res.matchKind).toBe('one')
    expect(res.candidates[0].runId).toBe('legacy')
  })

  it('refuses to guess when a NAMED workspace is unknown', () => {
    const jobs = [job({ runId: 'r1' })]
    const res = resolveRecall({ workspace: 'Nonexistent' }, jobs, ctx())
    expect(res.matchKind).toBe('none')
    expect(res.candidates).toHaveLength(0)
    expect(res.interpretation.notes.join(' ')).toMatch(/Nonexistent/)
  })

  it('never returns "one" on a topic match alone (no provider/workspace/time anchor)', () => {
    const jobs = [
      job({ runId: 'auth', promptPreview: 'auth refactor endpoint' }),
      job({ runId: 'bill', promptPreview: 'billing dashboard tweaks' })
    ]
    const res = resolveRecall({ taskQuery: 'auth' }, jobs, ctx())
    expect(res.matchKind).toBe('many')
    expect(res.candidates[0].runId).toBe('auth') // still ranked first
  })

  it('uses topic to break a tie into "one" when other facets are anchored', () => {
    const jobs = [
      job({ runId: 'auth', workspaceId: 'ws-pay' }),
      job({ runId: 'bill', workspaceId: 'ws-pay' })
    ]
    const loadTopicText = (j: RunQueueJob): string =>
      j.runId === 'auth' ? 'token refresh auth refactor' : 'billing dashboard'
    const res = resolveRecall(
      {
        provider: 'Ollama',
        workspace: 'Payments',
        timeApprox: 'yesterday',
        taskQuery: 'auth refactor'
      },
      jobs,
      ctx({ loadTopicText })
    )
    expect(res.matchKind).toBe('one')
    expect(res.candidates[0].runId).toBe('auth')
  })

  it('stays "many" when anchored candidates are indistinguishable', () => {
    const jobs = [
      job({ runId: 'a', workspaceId: 'ws-pay' }),
      job({ runId: 'b', workspaceId: 'ws-pay' })
    ]
    const res = resolveRecall(
      { provider: 'Ollama', workspace: 'Payments', timeApprox: 'yesterday' },
      jobs,
      ctx()
    )
    expect(res.matchKind).toBe('many')
    expect(res.candidates).toHaveLength(2)
  })

  it('excludes runs whose forensics are gone (tombstoned/deleted)', () => {
    const jobs = [job({ runId: 'live' }), job({ runId: 'dead' })]
    const res = resolveRecall(
      { provider: 'Ollama' },
      jobs,
      ctx({
        isForensicsAvailable: (j) => j.runId !== 'dead'
      })
    )
    expect(res.candidates.map((c) => c.runId)).toEqual(['live'])
  })

  it('caps the candidate set at RECALL_TOP_K', () => {
    const jobs = Array.from({ length: 12 }, (_, i) => job({ runId: `r${i}` }))
    const res = resolveRecall({ provider: 'Ollama' }, jobs, ctx())
    expect(res.candidates).toHaveLength(RECALL_TOP_K)
    expect(res.matchKind).toBe('many')
  })

  it('never leaks the prompt preview into candidates', () => {
    const jobs = [job({ runId: 'r1', promptPreview: 'SECRET_TOKEN=sk-abc123 do the thing' })]
    const res = resolveRecall({ provider: 'Ollama' }, jobs, ctx())
    expect(JSON.stringify(res.candidates)).not.toContain('SECRET_TOKEN')
  })

  it('broadens (with a note) when a named provider is unrecognized', () => {
    const jobs = [job({ runId: 'c', provider: 'claude' })]
    const res = resolveRecall({ provider: 'mistral' }, jobs, ctx())
    expect(res.interpretation.provider).toBeNull()
    expect(res.interpretation.notes.join(' ')).toMatch(/mistral/)
    expect(res.candidates.map((c) => c.runId)).toEqual(['c'])
  })

  it('returns "none" with an empty candidate set when nothing survives the filters', () => {
    const jobs = [job({ runId: 'r1', provider: 'claude' })]
    const res = resolveRecall({ provider: 'Ollama' }, jobs, ctx())
    expect(res.matchKind).toBe('none')
    expect(res.candidates).toHaveLength(0)
  })
})

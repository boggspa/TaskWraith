import fs from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AppStore } from '../store'
import type { ChatRecord } from '../store/types'
import type {
  TaskWraithControlThread,
  TaskWraithControlThreadSnapshot
} from '../../shared/taskWraithControlProtocol'
import { clampTaskWraithControlThreadLimit } from '../../shared/taskWraithControlProjection'
import {
  hydrateTaskWraithControlThread,
  hydrateTaskWraithControlThreadSnapshot,
  projectTaskWraithControlThread,
  projectTaskWraithControlThreadFacts,
  taskWraithControlRevisionOf,
  taskWraithControlThreadFactsFromInventoryRow,
  type TaskWraithControlInventoryRow
} from './TaskWraithControlProjector'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-control-projector-test-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

const NOW = Date.UTC(2026, 4, 22, 12, 0, 0)
const HOUR = 3_600_000
const MINUTE = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()
const PRESET_NAMES: Record<string, string> = { 'build-review': 'Build + Review' }
const presetName = (presetId: string | undefined): string | undefined =>
  presetId ? PRESET_NAMES[presetId] : undefined

/**
 * Captured from the facade BEFORE the projector existed, for the fixture
 * `seedGoldenChats` recreates: `snapshot().threads` and `selectThread(id, 10)`
 * for a running solo thread, a live ensemble round and an idle thread.
 * `generatedAt`/`sequence` were stripped (the poll digest ignores them) and
 * `updatedAt` is stamped at save time, so it is stripped on both sides.
 */
const GOLDEN = {
  workspaces: [
    {
      id: 'workspace-golden',
      name: 'Golden',
      path: '/golden-repo',
      pinned: false,
      updatedAt: 1788875892932
    }
  ],
  threads: [
    {
      id: 'ensemble-live',
      workspaceId: 'workspace-golden',
      title: 'Ensemble live',
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        model: 'claude-sonnet-5',
        modelLabel: 'Sonnet 5',
        shortCode: 'CLA'
      },
      status: 'working',
      chatKind: 'ensemble',
      archived: false,
      pinned: false,
      updatedAt: 1788875893014,
      messageCount: 2,
      wallTimeMs: 120000,
      tokenEstimate: 2,
      ensemble: {
        preset: 'Build + Review',
        mode: 'continuous',
        fanout: 'off',
        continuationHops: 0,
        maxContinuationHops: 6,
        backgroundCount: 0,
        participants: [
          {
            id: 'ensemble-claude',
            provider: 'claude',
            displayProvider: 'Claude',
            hueKey: 'claude',
            accent: '#B16105',
            shortCode: 'CLA',
            role: 'Boss',
            model: 'Sonnet 5',
            order: 1,
            status: 'running',
            active: true,
            next: false,
            enabled: true
          },
          {
            id: 'ensemble-codex',
            provider: 'codex',
            displayProvider: 'Codex',
            hueKey: 'codex',
            accent: '#705AFF',
            shortCode: 'CDX',
            role: 'Captain',
            model: 'GPT-5.5',
            order: 2,
            status: 'idle',
            active: false,
            next: true,
            enabled: true
          },
          {
            id: 'ensemble-kimi',
            provider: 'kimi',
            displayProvider: 'Kimi',
            hueKey: 'kimi',
            accent: '#0073E6',
            shortCode: 'KIM',
            role: 'Specialist',
            model: 'K2.7 Coding',
            order: 3,
            status: 'idle',
            active: false,
            next: false,
            enabled: true
          },
          {
            id: 'ensemble-ollama',
            provider: 'ollama',
            displayProvider: 'Alibaba',
            hueKey: 'alibaba',
            accent: '#8C52EF',
            shortCode: 'QWN',
            role: 'Outsider',
            model: 'Qwen 3.5 (9B Param)',
            order: 4,
            status: 'idle',
            active: false,
            next: false,
            enabled: true
          }
        ]
      }
    },
    {
      id: 'quiet',
      workspaceId: 'workspace-golden',
      title: 'Quiet',
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        shortCode: 'CLA'
      },
      status: 'idle',
      chatKind: 'single',
      archived: false,
      pinned: false,
      updatedAt: 1788875893055,
      messageCount: 0
    },
    {
      id: 'solo-running',
      workspaceId: 'workspace-golden',
      title: 'Solo running',
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        model: 'claude-opus-5',
        modelLabel: 'Opus 5',
        shortCode: 'CLA'
      },
      reasoning: 'high',
      status: 'working',
      chatKind: 'single',
      archived: false,
      pinned: true,
      updatedAt: 1788875892971,
      messageCount: 4,
      wallTimeMs: 600000,
      tokenEstimate: 250
    }
  ],
  solo: {
    thread: {
      id: 'solo-running',
      workspaceId: 'workspace-golden',
      title: 'Solo running',
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        model: 'claude-opus-5',
        modelLabel: 'Opus 5',
        shortCode: 'CLA'
      },
      reasoning: 'high',
      status: 'working',
      chatKind: 'single',
      archived: false,
      pinned: true,
      updatedAt: 1788875892971,
      messageCount: 4,
      wallTimeMs: 600000,
      tokenEstimate: 250
    },
    rows: [
      {
        id: 'm1',
        role: 'user',
        kind: 'user',
        speaker: 'You',
        text: 'first prompt',
        timestamp: '2026-05-22T09:00:00.000Z',
        truncated: false
      },
      {
        id: 'm2',
        role: 'assistant',
        kind: 'assistant',
        speaker: 'Claude',
        provider: {
          runtimeProvider: 'claude',
          displayProvider: 'Claude',
          hueKey: 'claude',
          accent: '#B16105',
          model: 'claude-sonnet-5',
          modelLabel: 'Sonnet 5',
          shortCode: 'CLA'
        },
        text: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        timestamp: '2026-05-22T10:00:00.000Z',
        truncated: false
      },
      {
        id: 'm3',
        role: 'user',
        kind: 'user',
        speaker: 'You',
        text: 'second prompt',
        timestamp: '2026-05-22T11:50:00.000Z',
        truncated: false
      },
      {
        id: 'm4',
        role: 'assistant',
        kind: 'assistant',
        speaker: 'Claude',
        provider: {
          runtimeProvider: 'claude',
          displayProvider: 'Claude',
          hueKey: 'claude',
          accent: '#B16105',
          model: 'claude-opus-5',
          modelLabel: 'Opus 5',
          shortCode: 'CLA'
        },
        text: 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
        timestamp: '2026-05-22T11:55:00.000Z',
        truncated: false
      }
    ],
    totalRows: 4,
    hasMoreAbove: false,
    context: {
      workspaces: [
        {
          id: 'workspace-golden',
          name: 'Golden',
          path: '/golden-repo',
          access: 'write',
          primary: true
        }
      ],
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        model: 'claude-opus-5',
        modelLabel: 'Opus 5',
        shortCode: 'CLA'
      },
      reasoning: 'high',
      wallTimeMs: 600000,
      tokenEstimate: 250
    }
  },
  ensemble: {
    thread: {
      id: 'ensemble-live',
      workspaceId: 'workspace-golden',
      title: 'Ensemble live',
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        model: 'claude-sonnet-5',
        modelLabel: 'Sonnet 5',
        shortCode: 'CLA'
      },
      status: 'working',
      chatKind: 'ensemble',
      archived: false,
      pinned: false,
      updatedAt: 1788875893014,
      messageCount: 2,
      wallTimeMs: 120000,
      tokenEstimate: 2,
      ensemble: {
        preset: 'Build + Review',
        mode: 'continuous',
        fanout: 'off',
        continuationHops: 0,
        maxContinuationHops: 6,
        backgroundCount: 0,
        participants: [
          {
            id: 'ensemble-claude',
            provider: 'claude',
            displayProvider: 'Claude',
            hueKey: 'claude',
            accent: '#B16105',
            shortCode: 'CLA',
            role: 'Boss',
            model: 'Sonnet 5',
            order: 1,
            status: 'running',
            active: true,
            next: false,
            enabled: true
          },
          {
            id: 'ensemble-codex',
            provider: 'codex',
            displayProvider: 'Codex',
            hueKey: 'codex',
            accent: '#705AFF',
            shortCode: 'CDX',
            role: 'Captain',
            model: 'GPT-5.5',
            order: 2,
            status: 'idle',
            active: false,
            next: true,
            enabled: true
          },
          {
            id: 'ensemble-kimi',
            provider: 'kimi',
            displayProvider: 'Kimi',
            hueKey: 'kimi',
            accent: '#0073E6',
            shortCode: 'KIM',
            role: 'Specialist',
            model: 'K2.7 Coding',
            order: 3,
            status: 'idle',
            active: false,
            next: false,
            enabled: true
          },
          {
            id: 'ensemble-ollama',
            provider: 'ollama',
            displayProvider: 'Alibaba',
            hueKey: 'alibaba',
            accent: '#8C52EF',
            shortCode: 'QWN',
            role: 'Outsider',
            model: 'Qwen 3.5 (9B Param)',
            order: 4,
            status: 'idle',
            active: false,
            next: false,
            enabled: true
          }
        ]
      }
    },
    rows: [
      {
        id: 'e1',
        role: 'user',
        kind: 'user',
        speaker: 'You',
        text: 'plan the release',
        timestamp: '2026-05-22T11:58:00.000Z',
        truncated: false
      },
      {
        id: 'e2',
        role: 'assistant',
        kind: 'assistant',
        speaker: 'Claude \u00b7 Boss',
        provider: {
          runtimeProvider: 'claude',
          displayProvider: 'Claude',
          hueKey: 'claude',
          accent: '#B16105',
          model: 'claude-sonnet-5',
          modelLabel: 'Sonnet 5',
          shortCode: 'CLA'
        },
        text: 'On it.',
        timestamp: '2026-05-22T11:59:00.000Z',
        truncated: false
      }
    ],
    totalRows: 2,
    hasMoreAbove: false,
    context: {
      workspaces: [
        {
          id: 'workspace-golden',
          name: 'Golden',
          path: '/golden-repo',
          access: 'write',
          primary: true
        }
      ],
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        model: 'claude-sonnet-5',
        modelLabel: 'Sonnet 5',
        shortCode: 'CLA'
      },
      permission: 'default',
      wallTimeMs: 120000,
      tokenEstimate: 2,
      ensemble: {
        preset: 'Build + Review',
        mode: 'continuous',
        fanout: 'off',
        continuationHops: 0,
        maxContinuationHops: 6,
        backgroundCount: 0,
        participants: [
          {
            id: 'ensemble-claude',
            provider: 'claude',
            displayProvider: 'Claude',
            hueKey: 'claude',
            accent: '#B16105',
            shortCode: 'CLA',
            role: 'Boss',
            model: 'Sonnet 5',
            order: 1,
            status: 'running',
            active: true,
            next: false,
            enabled: true
          },
          {
            id: 'ensemble-codex',
            provider: 'codex',
            displayProvider: 'Codex',
            hueKey: 'codex',
            accent: '#705AFF',
            shortCode: 'CDX',
            role: 'Captain',
            model: 'GPT-5.5',
            order: 2,
            status: 'idle',
            active: false,
            next: true,
            enabled: true
          },
          {
            id: 'ensemble-kimi',
            provider: 'kimi',
            displayProvider: 'Kimi',
            hueKey: 'kimi',
            accent: '#0073E6',
            shortCode: 'KIM',
            role: 'Specialist',
            model: 'K2.7 Coding',
            order: 3,
            status: 'idle',
            active: false,
            next: false,
            enabled: true
          },
          {
            id: 'ensemble-ollama',
            provider: 'ollama',
            displayProvider: 'Alibaba',
            hueKey: 'alibaba',
            accent: '#8C52EF',
            shortCode: 'QWN',
            role: 'Outsider',
            model: 'Qwen 3.5 (9B Param)',
            order: 4,
            status: 'idle',
            active: false,
            next: false,
            enabled: true
          }
        ]
      }
    }
  },
  quiet: {
    thread: {
      id: 'quiet',
      workspaceId: 'workspace-golden',
      title: 'Quiet',
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        shortCode: 'CLA'
      },
      status: 'idle',
      chatKind: 'single',
      archived: false,
      pinned: false,
      updatedAt: 1788875893055,
      messageCount: 0
    },
    rows: [],
    totalRows: 0,
    hasMoreAbove: false,
    context: {
      workspaces: [
        {
          id: 'workspace-golden',
          name: 'Golden',
          path: '/golden-repo',
          access: 'write',
          primary: true
        }
      ],
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        hueKey: 'claude',
        accent: '#B16105',
        shortCode: 'CLA'
      }
    }
  }
} as {
  workspaces: unknown[]
  threads: TaskWraithControlThread[]
  solo: Omit<TaskWraithControlThreadSnapshot, 'generatedAt' | 'sequence'>
  ensemble: Omit<TaskWraithControlThreadSnapshot, 'generatedAt' | 'sequence'>
  quiet: Omit<TaskWraithControlThreadSnapshot, 'generatedAt' | 'sequence'>
}

/** Same records the golden capture saved (store-normalised, so read back through getChat). */
function seedGoldenChats(): void {
  fs.rmSync(userDataPath, { recursive: true, force: true })
  fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  const workspace = AppStore.addOrUpdateWorkspace('/golden-repo', {
    id: 'workspace-golden',
    displayName: 'Golden'
  })
  const solo: ChatRecord = {
    ...AppStore.createChat(workspace.id, workspace.path),
    appChatId: 'solo-running',
    provider: 'claude',
    title: 'Solo running',
    pinned: true,
    providerMetadata: {
      customModel: 'claude-opus-5',
      claudeReasoningEffort: 'high',
      approvalMode: 'workspace_write',
      externalPathGrants: [{ path: '/shared/docs', access: 'read' }]
    },
    runs: [
      {
        runId: 'run-1',
        provider: 'claude',
        startedAt: iso(NOW - 3 * HOUR),
        endedAt: iso(NOW - 2 * HOUR),
        status: 'success',
        requestedModel: 'claude-sonnet-5',
        actualModel: 'claude-sonnet-5',
        stats: { total_tokens: 1234 }
      },
      {
        runId: 'run-2',
        provider: 'claude',
        startedAt: iso(NOW - 10 * MINUTE),
        status: 'running',
        requestedModel: 'claude-opus-5'
      }
    ] as ChatRecord['runs'],
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'first prompt',
        timestamp: iso(NOW - 3 * HOUR),
        runId: 'run-1'
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'x'.repeat(400),
        timestamp: iso(NOW - 2 * HOUR),
        runId: 'run-1'
      },
      {
        id: 'm3',
        role: 'user',
        content: 'second prompt',
        timestamp: iso(NOW - 10 * MINUTE),
        runId: 'run-2'
      },
      {
        id: 'm4',
        role: 'assistant',
        content: 'y'.repeat(1000),
        timestamp: iso(NOW - 5 * MINUTE),
        runId: 'run-2'
      }
    ] as ChatRecord['messages']
  }
  AppStore.saveChat(solo)
  const created = AppStore.createEnsembleChat({
    workspaceId: workspace.id,
    workspacePath: workspace.path
  })
  const first = created.ensemble!.participants[0]!
  const ensemble = {
    ...created,
    appChatId: 'ensemble-live',
    title: 'Ensemble live',
    pinnedNotes: 'Remember the deadline',
    ensemble: {
      ...created.ensemble!,
      activeRosterPresetId: 'build-review',
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'before',
        startedAt: iso(NOW - 2 * MINUTE),
        activeParticipantId: first.id,
        participants: created.ensemble!.participants.map((participant, index) => ({
          participantId: participant.id,
          provider: participant.provider,
          role: participant.role,
          order: participant.order,
          status: index === 0 ? 'running' : 'idle'
        }))
      }
    },
    runs: [
      {
        runId: 'ens-run-1',
        provider: first.provider,
        startedAt: iso(NOW - 2 * MINUTE),
        status: 'running',
        ensembleParticipantId: first.id,
        ensembleRoundId: 'round-1'
      }
    ],
    messages: [
      { id: 'e1', role: 'user', content: 'plan the release', timestamp: iso(NOW - 2 * MINUTE) },
      {
        id: 'e2',
        role: 'assistant',
        content: 'On it.',
        timestamp: iso(NOW - MINUTE),
        runId: 'ens-run-1',
        metadata: {
          ensembleProvider: first.provider,
          ensembleRole: first.role,
          ensembleModel: first.model
        }
      }
    ]
  } as unknown as ChatRecord
  AppStore.saveChat(ensemble)
  AppStore.saveChat({
    ...AppStore.createChat(workspace.id, workspace.path),
    appChatId: 'quiet',
    title: 'Quiet'
  })
}

const stripUpdated = <T extends { updatedAt: number }>(thread: T): Omit<T, 'updatedAt'> => {
  const { updatedAt: _updatedAt, ...rest } = thread
  return rest
}
type PaneLike = Omit<TaskWraithControlThreadSnapshot, 'generatedAt' | 'sequence'> & {
  generatedAt?: string
  sequence?: number
}
const stripPane = (pane: PaneLike) => {
  const { thread, generatedAt: _generatedAt, sequence: _sequence, ...rest } = pane
  return { ...rest, thread: stripUpdated(thread) }
}
const chat = (id: string): ChatRecord => {
  const found = AppStore.getChat(id)
  if (!found) throw new Error(`fixture ${id} missing`)
  return found
}

beforeAll(() => {
  seedGoldenChats()
})

describe('projectTaskWraithControlThreadFacts + hydrateTaskWraithControlThread', () => {
  it('reproduces the pre-projector thread rows from canonical records', () => {
    for (const expected of GOLDEN.threads) {
      const facts = projectTaskWraithControlThreadFacts(chat(expected.id))
      const thread = hydrateTaskWraithControlThread(facts, { now: NOW, presetName })
      expect(stripUpdated(thread), expected.id).toEqual(stripUpdated(expected))
    }
  })

  it('carries a run window and a preset id instead of a clock and a name', () => {
    const solo = projectTaskWraithControlThreadFacts(chat('solo-running'))
    expect(solo.runWindow).toEqual({ startedAt: iso(NOW - 10 * MINUTE) })
    expect(solo.thread).not.toHaveProperty('wallTimeMs')
    expect(hydrateTaskWraithControlThread(solo, { now: NOW + MINUTE }).wallTimeMs).toBe(11 * MINUTE)
    const live = projectTaskWraithControlThreadFacts(chat('ensemble-live'))
    expect(live.ensemble?.presetId).toBe('build-review')
    expect(live.ensemble).not.toHaveProperty('preset')
    expect(hydrateTaskWraithControlThread(live, { now: NOW }).ensemble?.preset).toBe('Custom')
    expect(hydrateTaskWraithControlThread(live, { now: NOW, presetName }).ensemble?.preset).toBe(
      'Build + Review'
    )
    expect(projectTaskWraithControlThreadFacts(chat('quiet')).runWindow).toBeUndefined()
  })

  it('stamps the decoder revision rule on the facts', () => {
    const solo = chat('solo-running')
    expect(projectTaskWraithControlThreadFacts(solo).revision).toBe(
      taskWraithControlRevisionOf(solo)
    )
    expect(
      projectTaskWraithControlThreadFacts({ ...solo, persistenceRevision: undefined }).revision
    ).toBe(0)
    expect(projectTaskWraithControlThreadFacts({ ...solo, persistenceRevision: 7 }).revision).toBe(
      7
    )
  })
})

describe('projectTaskWraithControlThread + hydrateTaskWraithControlThreadSnapshot', () => {
  const hydrate = (id: string, limit: number, now = NOW): TaskWraithControlThreadSnapshot =>
    hydrateTaskWraithControlThreadSnapshot(
      projectTaskWraithControlThread(chat(id), { limit }, 'fixed'),
      { now, sequence: 1, workspaces: AppStore.getWorkspaces(), presetName }
    )

  it('reproduces the pre-projector pane for solo, ensemble and quiet threads', () => {
    expect(stripPane(hydrate('solo-running', 10))).toEqual(stripPane(GOLDEN.solo))
    expect(stripPane(hydrate('ensemble-live', 10))).toEqual(stripPane(GOLDEN.ensemble))
    expect(stripPane(hydrate('quiet', 10))).toEqual(stripPane(GOLDEN.quiet))
  })

  it('is bounded: clamps the limit, keeps the newest rows and caps previews', () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: index === 248 || index === 249 ? 'z'.repeat(40_000) : `message ${index}`,
      timestamp: iso(NOW - (250 - index) * MINUTE)
    }))
    const long = { ...chat('quiet'), appChatId: 'long', messages } as ChatRecord
    expect(clampTaskWraithControlThreadLimit(500)).toBe(200)
    expect(clampTaskWraithControlThreadLimit(0)).toBe(1)
    const projection = projectTaskWraithControlThread(long, { limit: 500 }, 'fixed')
    expect(projection.rows).toHaveLength(200)
    expect(projection.totalRows).toBe(250)
    expect(projection.hasMoreAbove).toBe(true)
    expect(projection.rows.at(-1)?.id).toBe('m249')
    // Every row is capped at the 4k preview budget except the newest, which
    // gets the 32k expand budget so the pane can show the live answer.
    expect(projection.rows.slice(0, -1).every((row) => row.text.length <= 4_000)).toBe(true)
    expect(projection.rows.at(-2)?.truncated).toBe(true)
    expect(projection.rows.at(-1)?.text.length).toBe(32_000)
    expect(projection.rows.at(-1)?.truncated).toBe(true)
    expect(projectTaskWraithControlThread(long, { limit: 0 }, 'fixed').rows).toHaveLength(1)
  })

  it('holds no clock: the same record and stamp give the same projection', () => {
    const first = projectTaskWraithControlThread(chat('solo-running'), { limit: 10 }, 'fixed')
    const second = projectTaskWraithControlThread(chat('solo-running'), { limit: 10 }, 'fixed')
    expect(second).toEqual(first)
    expect(JSON.stringify(first)).not.toContain('wallTimeMs')
    expect(first.context).toMatchObject({
      workspaceId: 'workspace-golden',
      workspaceAccess: 'write'
    })
  })

  it('applies the clock, workspace names and preset name at hydration', () => {
    const later = hydrate('solo-running', 10, NOW + 30_000)
    expect(later.thread.wallTimeMs).toBe(10 * MINUTE + 30_000)
    expect(later.context.wallTimeMs).toBe(10 * MINUTE + 30_000)
    expect(later.context.workspaces).toEqual([
      {
        id: 'workspace-golden',
        name: 'Golden',
        path: '/golden-repo',
        access: 'write',
        primary: true
      }
    ])
    expect(hydrate('ensemble-live', 10).context.ensemble?.preset).toBe('Build + Review')
  })
})

describe('taskWraithControlThreadFactsFromInventoryRow', () => {
  it('returns attached catalogue facts untouched', () => {
    const facts = projectTaskWraithControlThreadFacts(chat('solo-running'))
    const row = { ...chat('quiet'), catalogueControl: facts } as TaskWraithControlInventoryRow
    expect(taskWraithControlThreadFactsFromInventoryRow(row)).toBe(facts)
  })

  it('degrades a bare row: presentation status, last-run window, row counts', () => {
    const row = {
      ...chat('quiet'),
      appChatId: 'bare',
      runs: [],
      messages: [],
      summaryOnly: true,
      messageCount: 7,
      runCount: 2,
      lastRun: {
        runId: 'r',
        provider: 'codex',
        startedAt: iso(NOW - 5 * MINUTE),
        status: 'running',
        requestedModel: 'gpt-5.2'
      },
      cataloguePresentation: { status: 'awaitingApproval', runningRunCount: 1 }
    } as unknown as TaskWraithControlInventoryRow
    const facts = taskWraithControlThreadFactsFromInventoryRow(row)
    expect(facts.thread).toMatchObject({ id: 'bare', status: 'needs-input', messageCount: 7 })
    expect(facts.thread.provider.runtimeProvider).toBe('codex')
    expect(facts.thread.tokenEstimate).toBeUndefined()
    expect(facts.runWindow).toEqual({ startedAt: iso(NOW - 5 * MINUTE) })
    expect(hydrateTaskWraithControlThread(facts, { now: NOW }).wallTimeMs).toBe(5 * MINUTE)
  })
})

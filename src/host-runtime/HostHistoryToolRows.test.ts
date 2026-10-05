import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareChatForPersistence } from '../main/store/ChatPersistencePreparation'
import type { ChatRecord, ToolActivity, ToolActivityDetailRef } from '../main/store/types'
import { inlineStatsForActivity } from '../renderer/src/lib/ActivityInlineStats'
import {
  getToolCategory,
  isHiddenInfrastructureToolName,
  isReasoningToolName
} from '../renderer/src/lib/ToolParser'
import {
  HOST_HISTORY_MAX_ENTRY_TOOLS,
  decodeHostHistoryToolEntry,
  decodeHostThreadHistoryPage,
  decodeHostTranscriptHistoryEntry,
  type HostThreadHistoryPage
} from '../shared/hostHistoryProtocol'
import { isMcpTransportWrapperActivity } from '../shared/toolInvocationPresentation'
import {
  hostHistoryEntries,
  hostHistoryEntryRun,
  hostHistoryRunToolRows,
  hostHistoryToolRows,
  isHiddenHistoryToolName,
  isReasoningHistoryToolName
} from './HostHistoryToolRows'
import { HostProfileDomainStore } from './HostProfileDomainStore'

const TEMPORARY_PREFIX = 'host-history-tool-rows-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

let profile = ''
let store: HostProfileDomainStore

beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    now: () => 0,
    idFactory: () => 'unused'
  })
})

afterEach(() => {
  removeTemporaryDirectory(profile)
})

function persist(record: Record<string, unknown>): void {
  store.persistThreadRecord({
    threadId: record.appChatId as string,
    expectedRevision: 0,
    record
  })
}

/** Every page of a thread's history, newest first, as a terminal app pages it. */
function allPages(threadId: string, limit: number): HostThreadHistoryPage[] {
  const pages: HostThreadHistoryPage[] = []
  let page = store.threadHistory({ threadId, limit })
  pages.push(page)
  while (page.nextBefore) {
    page = store.threadHistory({ threadId, limit, before: page.nextBefore })
    pages.push(page)
  }
  return pages
}

/**
 * Threads that carry no tool rows of the app's: every role, text the history
 * refuses or takes, timestamps it cannot read, and the Host's own runs with
 * their tool rows. History over them must not move.
 */
function goldenCorpus(): Record<string, unknown>[] {
  const random = seeded(20261005)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const texts = [
    'Hello',
    '',
    'line one\nline two\ttabbed\r\n',
    `bell\u0007`,
    'x'.repeat(16_000),
    'y'.repeat(16_001),
    'Done.'
  ]
  const times = ['2026-10-05T00:00:00.000Z', '2026-10-05T01:02:03.004Z', 'not a time', '']
  const roles = ['user', 'assistant', 'system', 'tool', 'error'] as const
  const records: Record<string, unknown>[] = []
  for (let thread = 0; thread < 16; thread += 1) {
    const runs: Record<string, unknown>[] = []
    const runCount = 1 + Math.floor(random() * 3)
    for (let index = 0; index < runCount; index += 1) {
      const tools = Math.floor(random() * 3) === 0 ? undefined : Math.floor(random() * 33)
      runs.push({
        runId: `run-${thread}-${index}`,
        status: pick(['success', 'running', 'failed']),
        ...(tools === undefined
          ? {}
          : {
              toolActivities: Array.from({ length: tools }, (_, tool) => ({
                id: `tool-${index}-${tool}`,
                name: pick(['Read', 'Edit File', 'bash']),
                category: pick(['read', 'write', 'shell', 'unknown']),
                status: pick(['running', 'success', 'error']),
                ...(random() < 0.5 ? { file: `src/file-${tool}.ts` } : {}),
                ...(random() < 0.3 ? { additions: tool, deletions: 1 } : {}),
                ...(random() < 0.2 ? { command: { command: 'npm test', exitCode: 0 } } : {})
              }))
            })
      })
    }
    const messages: Record<string, unknown>[] = []
    const messageCount = 1 + Math.floor(random() * 40)
    for (let index = 0; index < messageCount; index += 1) {
      const role = pick(roles)
      const runId =
        role === 'assistant' || role === 'tool'
          ? pick([
              undefined,
              `run-${thread}-0`,
              `run-${thread}-0`,
              `run-${thread}-1`,
              `run-${thread}-9`
            ])
          : undefined
      messages.push({
        id: `m-${thread}-${index}`,
        role,
        content: pick(texts),
        timestamp: pick(times),
        ...(runId === undefined ? {} : { runId })
      })
    }
    records.push({
      appChatId: `golden-${thread}`,
      title: `Golden ${thread}`,
      messages,
      runs,
      updatedAt: thread,
      persistenceRevision: 1 + thread
    })
  }
  return records
}

describe('the full copy history of threads without tool rows of the app', () => {
  it('is what it was before tool messages were read', () => {
    const outputs: unknown[] = []
    for (const record of goldenCorpus()) {
      persist(record)
      const threadId = record.appChatId as string
      for (const limit of [1, 7, 100]) outputs.push(allPages(threadId, limit))
      outputs.push(
        store.historySince({ threadId, since: { generation: 1, cursor: 0 } }),
        store.historySince({ threadId, since: { generation: 999, cursor: 3 } })
      )
    }
    // Not vacuous: the Host's own runs put tool rows on some entries.
    const shown = outputs
      .flatMap((output) => (Array.isArray(output) ? output : []))
      .flatMap((page: HostThreadHistoryPage) => page.entries)
    expect(shown.filter((entry) => (entry.tools?.length ?? 0) > 0).length).toBeGreaterThan(20)
    expect(shown.length).toBeGreaterThan(300)
    const digest = createHash('sha256').update(JSON.stringify(outputs)).digest('hex')
    expect(digest).toBe('e8e046649ab64c19c192c791a9904afbc7edcb373e6c811413e8f335dadbe49c')
  })
})

/** A ref for staged detail, as the app's detail ledger hands one back. */
function detailRefFor(runId: string, activity: ToolActivity): ToolActivityDetailRef {
  return {
    schemaVersion: 1,
    storage: 'run_event_artifact',
    runId,
    activityId: activity.id,
    offset: 0,
    byteLength: 1024,
    sha256: 'a'.repeat(64)
  }
}

/** A record as the app's save path writes it: finished runs' tool detail moved out of the record. */
function savedByTheApp(chat: ChatRecord): Record<string, unknown> {
  const prepared = prepareChatForPersistence({
    chat,
    previous: null,
    authoredTranscriptEligible: false,
    createDetailBatch: () => ({ stage: detailRefFor, commit: () => [] }),
    readArchivedDetail: () => null,
    persistDetailCheckpoint: () => {},
    maxTerminalRunsPerPass: 25
  })
  expect(prepared.externalizationFailed).toBe(false)
  return prepared.chat as unknown as Record<string, unknown>
}

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 5, 9, minute)).toISOString()

/** A thread the desktop draws with tool stacks: one finished run, one still running. */
function appThread(): ChatRecord {
  const done = { endedAt: at(2), startedAt: at(1) }
  return {
    appChatId: 'app-tools',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Tools',
    createdAt: 1,
    updatedAt: 2,
    persistenceRevision: 4,
    archived: false,
    messages: [
      { id: 'u-1', role: 'user', content: 'Fix the failing test', timestamp: at(0) },
      {
        id: 't-1',
        role: 'tool',
        content: '',
        timestamp: at(1),
        runId: 'run-1',
        toolActivities: [
          {
            id: 'think-1',
            toolName: 'codex_reasoning',
            displayName: 'Thinking',
            category: 'task',
            status: 'success',
            resultSummary: 'Look at the test first.',
            ...done
          },
          {
            id: 'read-1',
            toolName: 'Read',
            displayName: 'Read src/a.ts',
            category: 'read',
            status: 'success',
            parameters: { file_path: 'src/a.ts' },
            filePath: 'src/a.ts',
            affectedFilePath: 'src/a.ts',
            outputPreview: 'export const a = 1',
            ...done
          },
          {
            id: 'mcp-1',
            toolName: 'call_mcp_tool',
            displayName: 'Used call_mcp_tool',
            category: 'unknown',
            status: 'success',
            parameters: { server: 'taskwraith', tool: 'thread_read' },
            ...done
          },
          {
            id: 'edit-1',
            toolName: 'Edit',
            displayName: 'Edited src/a.ts',
            category: 'write',
            status: 'success',
            parameters: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
            filePath: 'src/a.ts',
            affectedFilePath: 'src/a.ts',
            diffSummary: {
              additions: 3,
              deletions: 1,
              source: 'string_replace',
              confidence: 'exact'
            },
            ...done
          },
          {
            id: 'diag-1',
            toolName: 'provider_diagnostic',
            displayName: 'Provider Diagnostic',
            category: 'unknown',
            status: 'success',
            resultSummary: 'filtered a compatibility line',
            ...done
          },
          {
            id: 'shell-1',
            toolName: 'run_shell_command',
            displayName: 'Shell command',
            category: 'shell',
            status: 'warning',
            parameters: { command: 'npm test' },
            outputPreview: 'diff --git a/x b/x',
            diffSummary: {
              additions: 2,
              deletions: 0,
              source: 'result_diff',
              confidence: 'estimated'
            },
            ...done
          },
          {
            id: 'write-1',
            toolName: 'Write',
            displayName: 'Wrote src/b.ts',
            category: 'write',
            status: 'error',
            parameters: { file_path: 'src/b.ts', content: 'b' },
            filePath: 'src/b.ts',
            diffSummary: { additions: 1, deletions: 0, source: 'content', confidence: 'estimated' },
            resultSummary: 'User rejected the write',
            ...done
          }
        ]
      },
      { id: 'a-1', role: 'assistant', content: 'Fixed it.', timestamp: at(3), runId: 'run-1' },
      { id: 'u-2', role: 'user', content: 'And the docs?', timestamp: at(4) },
      {
        id: 't-2',
        role: 'tool',
        content: '',
        timestamp: at(5),
        runId: 'run-2',
        toolActivities: [
          {
            id: 'grep-1',
            toolName: 'Grep',
            displayName: 'Searched "todo"',
            category: 'search',
            status: 'running',
            parameters: { pattern: 'todo' },
            startedAt: at(5)
          }
        ]
      },
      {
        id: 't-3',
        role: 'tool',
        content: '',
        timestamp: at(6),
        runId: 'run-2',
        toolActivities: [
          {
            id: 'think-2',
            toolName: 'thinking',
            displayName: 'Thinking',
            category: 'task',
            status: 'running',
            startedAt: at(6)
          }
        ]
      },
      {
        id: 'f-1',
        role: 'assistant',
        content: '',
        timestamp: at(7),
        runId: 'run-2',
        metadata: { kind: 'ensembleParticipant', ensembleLaneId: 'lane-a' },
        toolActivities: [
          {
            id: 'lane-read-1',
            toolName: 'read_file',
            displayName: 'Read docs/guide.md',
            category: 'read',
            status: 'success',
            parameters: { path: 'docs/guide.md' },
            filePath: 'docs/guide.md',
            ...done
          }
        ]
      }
    ],
    runs: [
      { runId: 'run-1', startedAt: at(1), endedAt: at(3), status: 'completed' },
      { runId: 'run-2', startedAt: at(5), status: 'running' }
    ]
  } as unknown as ChatRecord
}

describe('tool rows in the history of a thread the app saved', () => {
  it('shows each tool stack the desktop draws, as its compact rows, without loading detail', () => {
    const record = savedByTheApp(appThread())
    // The app's save moved the finished run's detail out: only refs and compact fields are left.
    const saved = (record.messages as Array<{ id: string; toolActivities?: ToolActivity[] }>).find(
      (message) => message.id === 't-1'
    )!.toolActivities!
    expect(saved.every((activity) => activity.detailRef && !activity.parameters)).toBe(true)
    persist(record)

    const page = store.threadHistory({ threadId: 'app-tools', limit: 100 })
    expect(page.entries).toEqual([
      {
        entryId: 'u-1',
        role: 'user',
        createdAt: Date.parse(at(0)),
        text: 'Fix the failing test'
      },
      {
        entryId: 't-1',
        role: 'tool',
        createdAt: Date.parse(at(1)),
        text: '',
        tools: [
          { id: 'read-1', name: 'Read', category: 'read', status: 'success', file: 'src/a.ts' },
          {
            id: 'edit-1',
            name: 'Edited',
            category: 'write',
            status: 'success',
            file: 'src/a.ts',
            additions: 3,
            deletions: 1
          },
          { id: 'shell-1', name: 'Shell command', category: 'shell', status: 'success' },
          { id: 'write-1', name: 'Wrote', category: 'write', status: 'error', file: 'src/b.ts' }
        ]
      },
      {
        entryId: 'a-1',
        role: 'assistant',
        createdAt: Date.parse(at(3)),
        text: 'Fixed it.',
        tools: []
      },
      { entryId: 'u-2', role: 'user', createdAt: Date.parse(at(4)), text: 'And the docs?' },
      {
        entryId: 't-2',
        role: 'tool',
        createdAt: Date.parse(at(5)),
        text: '',
        tools: [{ id: 'grep-1', name: 'Searched "todo"', category: 'search', status: 'running' }]
      },
      {
        entryId: 'f-1',
        role: 'assistant',
        createdAt: Date.parse(at(7)),
        text: '',
        tools: [
          {
            id: 'lane-read-1',
            name: 'Read',
            category: 'read',
            status: 'success',
            file: 'docs/guide.md'
          }
        ]
      }
    ])
  })
})

describe('a Host run with more tool rows than an entry carries', () => {
  it('shows its newest rows, on a page the wire takes', () => {
    persist({
      appChatId: 'host-run',
      title: 'Host run',
      messages: [
        { id: 'a-1', role: 'assistant', content: 'Working', timestamp: at(0), runId: 'run-h' }
      ],
      runs: [{ runId: 'run-h', status: 'running', startedAt: at(0) }],
      updatedAt: 1,
      persistenceRevision: 1
    })
    for (let index = 0; index < 40; index += 1) {
      store.recordRunTool({
        threadId: 'host-run',
        runId: 'run-h',
        toolId: `tool-${index}`,
        toolName: 'Read',
        phase: 'finished',
        status: 'success',
        file: `src/${index}.ts`
      })
    }
    const page = store.threadHistory({ threadId: 'host-run', limit: 10 })
    expect(decodeHostThreadHistoryPage(page).ok).toBe(true)
    expect(page.entries[0].tools?.map((tool) => tool.id)).toEqual(
      Array.from({ length: HOST_HISTORY_MAX_ENTRY_TOOLS }, (_unused, index) => `tool-${index + 8}`)
    )
  })
})

describe('the desktop rules the history copies', () => {
  const names = [
    'generic',
    'Generic',
    'GENERIC',
    'antigravity_init',
    'provider_diagnostic',
    ' generic',
    'generic ',
    'genericx',
    'mcp__taskwraith__generic',
    'mcp__grok__provider_diagnostic',
    'mcp__generic',
    'mcp___generic',
    'mcp_taskwraith_generic',
    'mcp_taskwraith-broker_antigravity_init',
    'mcp_taskwraith-broker-generic',
    'mcp_taskwraith-generic',
    'mcp_other_generic',
    'taskwraith-broker__generic',
    'taskwraith_broker__provider_diagnostic',
    'taskwraith-broker_generic',
    'taskwraith_broker_generic',
    'taskwraith__generic',
    'taskwraith_generic',
    'taskwraith-mistral__generic',
    'thinking',
    'Thinking',
    'REASONING',
    'codex_reasoning',
    'kimi_thinking',
    'mcp__grok__thinking',
    'mcp_taskwraith_reasoning',
    'taskwraith_codex_reasoning',
    'thinking_tool',
    'reasoning_effort',
    '_thinking',
    'think',
    'Read',
    'Edit',
    '',
    'mcp__',
    'taskwraith_'
  ]

  it('hide the housekeeping rows the desktop hides', () => {
    for (const name of names) {
      expect(isHiddenHistoryToolName(name), name).toBe(isHiddenInfrastructureToolName(name))
    }
  })

  it('take for reasoning the names the desktop takes', () => {
    for (const name of names) {
      expect(isReasoningHistoryToolName(name), name).toBe(isReasoningToolName(name))
    }
  })

  it('leave out the MCP envelopes the desktop leaves out', () => {
    const toolNames = [
      'call_mcp_tool',
      'CallMcpTool',
      'mcp',
      ' use_tool ',
      'unknown',
      'Unknown',
      'Read'
    ]
    const displayNames = [
      'Used call_mcp_tool',
      'MCP',
      'used an MCP tool',
      'Used unknown',
      'unknown',
      'Read file',
      ''
    ]
    const categories = ['shell', 'unknown', 'read'] as const
    const parameterSets = [
      undefined,
      { command: 'ls' },
      { cmd: '  ' },
      { server: 'docs' },
      { type: 'mcp_call' },
      { tool: 'call_mcp_tool' },
      { name: 'use_tool' },
      { kind: 'MCP' },
      { mcp_tool_name: 'search' },
      { input: 'x' }
    ]
    const rawEvents = [
      undefined,
      { type: 'mcp_tool_call' },
      '{"server":"docs"}',
      { payload: { command: 'ls' } },
      { arguments: '{"tool":"mcp"}' },
      'not json',
      { params: { serverName: 'docs' } },
      ['server']
    ]
    let wrappers = 0
    let tried = 0
    for (const toolName of toolNames)
      for (const displayName of displayNames)
        for (const category of categories)
          for (const parameters of parameterSets)
            for (const rawUseEvent of rawEvents) {
              const activity = {
                id: 'tool-1',
                toolName,
                displayName,
                category,
                status: 'success',
                ...(parameters ? { parameters } : {}),
                ...(rawUseEvent === undefined ? {} : { rawUseEvent })
              } as unknown as ToolActivity
              const wrapper = isMcpTransportWrapperActivity(activity)
              tried += 1
              if (wrapper) wrappers += 1
              expect(hostHistoryToolRows([activity]).length, JSON.stringify(activity)).toBe(
                wrapper ? 0 : 1
              )
            }
    // Both answers were met many times over.
    expect(wrappers).toBeGreaterThan(tried / 10)
    expect(tried - wrappers).toBeGreaterThan(tried / 10)
  })

  it('leave out reasoning, which the desktop draws as a thinking note', () => {
    const shown = (activity: Record<string, unknown>): number =>
      hostHistoryToolRows([{ id: 'tool-1', status: 'success', category: 'task', ...activity }])
        .length
    expect(shown({ toolName: 'codex_reasoning', displayName: 'Codex' })).toBe(0)
    expect(shown({ toolName: 'Task', parameters: { kind: ' Thinking ' } })).toBe(0)
    expect(shown({ toolName: 'Task', parameters: { kind: 'reasoning' } })).toBe(0)
    expect(shown({ toolName: 'Task', displayName: ' Reasoning' })).toBe(0)
    expect(shown({ toolName: 'Task', displayName: 'Grok thinking' })).toBe(0)
    expect(shown({ toolName: 'Task', displayName: 'Rethinking' })).toBe(1)
    expect(shown({ toolName: 'Task', parameters: { kind: 'plan' } })).toBe(1)
    expect(shown({ toolName: 'Task', parameters: 'thinking' })).toBe(1)
  })

  it('count the lines the desktop counts, from the stored summary of a compact row', () => {
    const toolNames = [
      'Edit',
      'Write',
      'MultiEdit',
      'apply_patch',
      'str_replace_editor',
      'Read',
      'read_file',
      'Grep',
      'run_shell_command',
      'bash',
      'mcp__files__write_file',
      'mcp__taskwraith__edit',
      'Write `notes.md`',
      'Edit main.py',
      'update_topic',
      'create_file',
      'TodoWrite',
      'web_fetch'
    ]
    const sources = [
      'codex_changes',
      'patch_preview',
      'string_replace',
      'content',
      'result_diff',
      'git_numstat',
      'unknown'
    ] as const
    const counts = [
      {},
      { additions: 3, deletions: 1 },
      { additions: 0, deletions: 0 },
      { additions: 2 },
      { deletions: 4 },
      { additions: 0, deletions: 5 }
    ]
    // The app sets a new activity's category from its name; a provider's kind
    // or an older record can give another. Not to a shell name: the desktop
    // reads a shell row from the name, the history from the category.
    const categoriesFor = (toolName: string): ToolActivity['category'][] => {
      const fromName = getToolCategory(toolName)
      if (fromName === 'shell') return ['shell']
      return [
        ...new Set([fromName, 'unknown', 'read', ...(fromName === 'unknown' ? ['shell'] : [])])
      ] as ToolActivity['category'][]
    }
    let shown = 0
    let tried = 0
    for (const toolName of toolNames)
      for (const category of categoriesFor(toolName))
        for (const status of ['running', 'pending', 'success', 'warning', 'error'] as const)
          for (const source of sources)
            for (const count of [undefined, ...counts]) {
              const activity: ToolActivity = {
                id: 'tool-1',
                toolName,
                displayName: toolName,
                category,
                status,
                ...(count ? { diffSummary: { ...count, source, confidence: 'exact' } } : {})
              }
              const desktop = inlineStatsForActivity(activity)
              const [row] = hostHistoryToolRows([activity])
              tried += 1
              if (desktop.visible) shown += 1
              expect(
                row.additions === undefined
                  ? null
                  : { additions: row.additions, deletions: row.deletions },
                JSON.stringify(activity)
              ).toEqual(
                desktop.visible
                  ? { additions: desktop.additions, deletions: desktop.deletions }
                  : null
              )
            }
    expect(shown).toBeGreaterThan(tried / 10)
    expect(tried - shown).toBeGreaterThan(tried / 10)
  })
})

describe('a tool row', () => {
  const row = (activity: Record<string, unknown>) =>
    hostHistoryToolRows([{ id: 'tool-1', status: 'success', category: 'read', ...activity }])[0]

  it('is named by its display name, else its tool name, on one bounded line', () => {
    expect(row({ toolName: 'Read', displayName: 'Read file' }).name).toBe('Read file')
    expect(row({ toolName: 'Read', displayName: ' \t ' }).name).toBe('Read')
    expect(row({ toolName: ' ', displayName: '' }).name).toBe('Tool')
    expect(row({ toolName: 7, displayName: null }).name).toBe('Tool')
    expect(row({ displayName: 'Ran\ncommand\u0007 \u001b[31mred' }).name).toBe(
      'Ran command   [31mred'
    )
    const long = row({ displayName: `${'n'.repeat(199)}\u{1f600}tail` }).name
    expect(long).toBe('n'.repeat(199))
    expect(row({ displayName: 'w'.repeat(250) }).name).toBe('w'.repeat(200))
  })

  it('leaves the file out of its name when the name ends with it', () => {
    expect(row({ displayName: 'Edited src/a.ts', filePath: 'src/a.ts' })).toMatchObject({
      name: 'Edited',
      file: 'src/a.ts'
    })
    expect(row({ displayName: 'Read  src/a.ts', parameters: { path: 'src/a.ts' } }).name).toBe(
      'Read'
    )
    // Not a word of its own, or the whole name: the name stays.
    expect(row({ displayName: 'Readsrc/a.ts', filePath: 'src/a.ts' }).name).toBe('Readsrc/a.ts')
    expect(row({ displayName: 'src/a.ts', filePath: 'src/a.ts' }).name).toBe('src/a.ts')
    expect(row({ displayName: 'Read src/a.ts', filePath: 'src/b.ts' }).name).toBe('Read src/a.ts')
  })

  it('finds its file where the desktop looks, in the desktop’s order', () => {
    expect(
      row({
        parameters: { path: 'p.ts', file_path: ' first.ts ', target: 't.ts' },
        filePath: 'f.ts',
        affectedFilePath: 'x.ts'
      }).file
    ).toBe('first.ts')
    expect(row({ parameters: { path: '  ', destination_file_path: 'd.ts' } }).file).toBe('d.ts')
    expect(row({ parameters: { file_path: 3 }, filePath: ' f.ts ' }).file).toBe('f.ts')
    expect(row({ filePath: '', affectedFilePath: 'x.ts' }).file).toBe('x.ts')
    expect(row({ parameters: 'src/a.ts' }).file).toBeUndefined()
    // One the wire cannot carry is left out, not swapped for the next.
    expect(row({ filePath: `src/${'d'.repeat(600)}.ts`, affectedFilePath: 'x.ts' }).file).toBe(
      undefined
    )
    expect(row({ filePath: 'src/a\u0007.ts' }).file).toBeUndefined()
  })

  it('is running, failed or done, in a category the wire knows', () => {
    const status = (value: unknown) => row({ status: value }).status
    expect([status('pending'), status('running')]).toEqual(['running', 'running'])
    expect(status('error')).toBe('error')
    expect([status('success'), status('warning'), status('cancelled'), status(undefined)]).toEqual([
      'success',
      'success',
      'success',
      'success'
    ])
    expect(row({ category: 'write' }).category).toBe('write')
    expect(row({ category: 'web' }).category).toBe('unknown')
    expect(row({ category: undefined }).category).toBe('unknown')
  })

  it('needs an id the wire takes', () => {
    for (const id of ['', ' tool', 'tool\n', 'x'.repeat(513), 7, null, undefined]) {
      expect(
        hostHistoryToolRows([{ id, toolName: 'Read', status: 'success' }]),
        String(id)
      ).toEqual([])
    }
    expect(hostHistoryToolRows([null, 'Read', [], { toolName: 'Read' }])).toEqual([])
    expect(hostHistoryToolRows({ id: 'tool-1' })).toEqual([])
  })

  it('carries no command, output or diff: those are detail', () => {
    expect(
      row({
        toolName: 'run_shell_command',
        displayName: 'Shell command',
        category: 'shell',
        parameters: { command: 'npm test' },
        outputPreview: 'ok',
        resultSummary: 'passed',
        rawResultEvent: { output: 'ok' }
      })
    ).toEqual({ id: 'tool-1', name: 'Shell command', category: 'shell', status: 'success' })
  })
})

describe('the rows of one stack', () => {
  const activity = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    toolName: 'Read',
    displayName: `Read ${id}`,
    category: 'read',
    status: 'success',
    ...extra
  })

  it('keep the stack’s order, and an id that comes again keeps its last place', () => {
    const rows = hostHistoryToolRows([
      activity('a'),
      activity('b'),
      activity('a', { status: 'error' }),
      activity('c')
    ])
    expect(rows.map((each) => [each.id, each.status])).toEqual([
      ['b', 'success'],
      ['a', 'error'],
      ['c', 'success']
    ])
  })

  it('are the newest an entry carries, counted after the rows the desktop leaves out', () => {
    const activities = Array.from({ length: 50 }, (_unused, index) =>
      index % 5 === 0
        ? activity(`think-${index}`, { toolName: 'kimi_thinking' })
        : activity(`read-${index}`)
    )
    const rows = hostHistoryToolRows(activities)
    expect(rows).toHaveLength(HOST_HISTORY_MAX_ENTRY_TOOLS)
    expect(rows[0].id).toBe('read-11')
    expect(rows.at(-1)!.id).toBe('read-49')
  })

  it('of a Host run are its newest valid rows, as stored', () => {
    const stored = [
      { id: 'r-0', name: 'Read', category: 'read', status: 'success', file: 'a.ts' },
      { id: 'r-0', name: 'Read', category: 'read', status: 'error' },
      ...Array.from({ length: 31 }, (_unused, index) => ({
        id: `r-${index + 3}`,
        name: 'Edit File',
        category: 'write',
        status: 'running',
        additions: index
      })),
      // Newest of all, and not rows the wire takes.
      { id: 'r-1', name: '', category: 'read', status: 'success' },
      { id: 'r-2', name: 'Read', category: 'read', status: 'done' }
    ]
    const rows = hostHistoryRunToolRows({ runId: 'run-1', toolActivities: stored })
    expect(rows.map((row) => row.id)).toEqual([
      'r-0',
      ...Array.from({ length: 31 }, (_unused, index) => `r-${index + 3}`)
    ])
    expect(rows[0]).toEqual({ id: 'r-0', name: 'Read', category: 'read', status: 'error' })
    expect(rows[0]).not.toBe(stored[1])
    expect(hostHistoryRunToolRows({ runId: 'run-1', toolActivities: {} })).toEqual([])
    expect(hostHistoryRunToolRows(undefined)).toEqual([])
  })
})

describe('which messages show, with which rows', () => {
  const read = {
    id: 'tool-1',
    toolName: 'Read',
    displayName: 'Read',
    category: 'read',
    status: 'success'
  }
  const hidden = { ...read, id: 'tool-2', toolName: 'mcp__taskwraith__generic' }
  const lane = { kind: 'ensembleParticipant', ensembleLaneId: 'lane-a' }
  const message = (role: string, content: string, extra: Record<string, unknown> = {}) => ({
    id: `${role}-1`,
    role,
    content,
    timestamp: 'not a time',
    ...extra
  })
  const entriesOf = (messages: Record<string, unknown>[], runs: Record<string, unknown>[] = []) =>
    hostHistoryEntries(messages as never, runs)

  it('shows a tool message only for rows the desktop draws, and never its own text', () => {
    expect(entriesOf([message('tool', 'raw payload', { toolActivities: [hidden] })])).toEqual([])
    expect(entriesOf([message('tool', 'raw payload')])).toEqual([])
    expect(entriesOf([message('tool', 'raw payload', { toolActivities: [hidden, read] })])).toEqual(
      [
        {
          entryId: 'tool-1',
          role: 'tool',
          createdAt: 0,
          text: '',
          tools: [{ id: 'tool-1', name: 'Read', category: 'read', status: 'success' }]
        }
      ]
    )
  })

  it('shows a lane’s result with its own rows, even before it has text', () => {
    expect(
      entriesOf(
        [message('assistant', '', { metadata: lane, runId: 'run-1', toolActivities: [read] })],
        [
          {
            runId: 'run-1',
            toolActivities: [{ id: 'r-1', name: 'Bash', category: 'shell', status: 'success' }]
          }
        ]
      )
    ).toEqual([
      {
        entryId: 'assistant-1',
        role: 'assistant',
        createdAt: 0,
        text: '',
        tools: [{ id: 'tool-1', name: 'Read', category: 'read', status: 'success' }]
      }
    ])
    expect(
      entriesOf([message('assistant', '', { metadata: lane, toolActivities: [hidden] })])
    ).toEqual([])
    expect(
      entriesOf([message('assistant', 'bell\u0007', { metadata: lane, toolActivities: [read] })])
    ).toEqual([])
    expect(
      entriesOf([
        message('assistant', '', {
          metadata: { ...lane, ensembleLaneId: ' ' },
          toolActivities: [read]
        })
      ])
    ).toEqual([])
  })

  it('gives any other assistant message its run’s rows, as before, and nothing else its own', () => {
    const runs = [
      {
        runId: 'run-1',
        toolActivities: [{ id: 'r-1', name: 'Bash', category: 'shell', status: 'success' }]
      },
      { runId: 'run-1', toolActivities: [] }
    ]
    expect(
      entriesOf([message('assistant', 'Done', { runId: 'run-1', toolActivities: [read] })], runs)
    ).toEqual([
      {
        entryId: 'assistant-1',
        role: 'assistant',
        createdAt: 0,
        text: 'Done',
        tools: [{ id: 'r-1', name: 'Bash', category: 'shell', status: 'success' }]
      }
    ])
    expect(entriesOf([message('assistant', 'Done', { toolActivities: [read] })], runs)).toEqual([
      { entryId: 'assistant-1', role: 'assistant', createdAt: 0, text: 'Done' }
    ])
    expect(
      entriesOf([message('user', 'Hi', { runId: 'run-1', toolActivities: [read] })], runs)
    ).toEqual([{ entryId: 'user-1', role: 'user', createdAt: 0, text: 'Hi' }])
    expect(entriesOf([message('error', 'Failed', { toolActivities: [read] })], runs)).toEqual([])
  })

  it('names the run an entry takes rows from only for an assistant message without its own', () => {
    expect(hostHistoryEntryRun(message('assistant', 'x', { runId: 'run-1' }))).toBe('run-1')
    expect(
      hostHistoryEntryRun(message('assistant', 'x', { runId: 'run-1', metadata: lane }))
    ).toBeNull()
    expect(hostHistoryEntryRun(message('assistant', 'x', { runId: '' }))).toBeNull()
    expect(hostHistoryEntryRun(message('user', 'x', { runId: 'run-1' }))).toBeNull()
    expect(hostHistoryEntryRun(message('tool', '', { runId: 'run-1' }))).toBeNull()
  })

  it('makes entries the wire takes, whatever the rows hold', () => {
    const random = seeded(5)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
    const strings = [
      '',
      ' ',
      'Read',
      'a\u0000b',
      '\u001b[2J',
      'x'.repeat(600),
      '\u{1f600}',
      'src/a.ts',
      'mcp__x__generic',
      'thinking'
    ]
    const values = [...strings, undefined, null, 3, -1, 2.5, {}, [], true]
    const messages = Array.from({ length: 400 }, (_unused, index) => ({
      id: `m-${index}`,
      role: pick(['tool', 'assistant', 'user', 'tool']),
      content: pick(['', 'text', 'bell\u0007']),
      timestamp: pick(['2026-10-05T00:00:00.000Z', 'nope', 5]),
      ...(random() < 0.5 ? { metadata: lane } : {}),
      toolActivities: Array.from({ length: Math.floor(random() * 40) }, () => ({
        id: pick([...values, `t-${Math.floor(random() * 50)}`, `t-${Math.floor(random() * 50)}`]),
        toolName: pick(values),
        displayName: pick(values),
        category: pick([...values, 'write', 'shell']),
        status: pick([...values, 'running', 'error']),
        filePath: pick(values),
        affectedFilePath: pick(values),
        parameters: pick([undefined, { file_path: pick(values), command: pick(values) }, 'p']),
        diffSummary: pick([
          undefined,
          {
            additions: pick(values),
            deletions: pick(values),
            source: pick(['git_numstat', 'content', 'x'])
          }
        ])
      }))
    }))
    const entries = hostHistoryEntries(messages as never, [])
    expect(entries.filter((entry) => entry.tools?.length).length).toBeGreaterThan(100)
    for (const entry of entries) {
      expect(decodeHostTranscriptHistoryEntry(entry).ok, JSON.stringify(entry)).toBe(true)
      for (const tool of entry.tools ?? [])
        expect(decodeHostHistoryToolEntry(tool, 0).ok).toBe(true)
    }
  })
})

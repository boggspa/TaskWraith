import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../main/store/types'
import { coalesceMirroredTaskWraithActivities } from './toolActivityMirrorCoalesce'

function activity(id: string, overrides: Partial<ToolActivity> = {}): ToolActivity {
  const base: ToolActivity = {
    id,
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success'
  }
  return { ...base, ...overrides }
}

describe('coalesceMirroredTaskWraithActivities — established provider mirrors', () => {
  it('keeps the Claude provider row and adopts the host receipt diff', () => {
    const resultSummary = JSON.stringify({ ok: false, tool: 'ensemble_fanout' })
    const parameters = { mode: 'locked_writers', targets: ['Work2'] }
    const providerActivity = activity('toolu_fanout', {
      toolName: 'mcp__TaskWraith__ensemble_fanout',
      displayName: 'Ensemble Fanout',
      category: 'unknown',
      status: 'error',
      startedAt: '2026-08-14T10:16:54.223Z',
      endedAt: '2026-08-14T10:16:54.346Z',
      durationMs: 123,
      parameters,
      resultSummary,
      metadata: { provider: 'claude', ensembleProvider: 'claude' }
    })
    const hostActivity = activity('claude-mcp-ensemble_fanout-1786702614341-x4nook6pff', {
      toolName: 'ensemble_fanout',
      displayName: 'Ensemble Fanout',
      category: 'unknown',
      status: 'error',
      startedAt: '2026-08-14T10:16:54.342Z',
      endedAt: '2026-08-14T10:16:54.343Z',
      durationMs: 1,
      parameters: { ...parameters, cwd: '/workspace' },
      diffSummary: { additions: 7, deletions: 3, source: 'git_numstat', confidence: 'exact' },
      resultSummary,
      metadata: { provider: 'claude', ensembleProvider: 'claude' }
    })

    const coalesced = coalesceMirroredTaskWraithActivities([providerActivity, hostActivity])

    expect(coalesced).toHaveLength(1)
    expect(coalesced[0].id).toBe('toolu_fanout')
    expect(coalesced[0].durationMs).toBe(123)
    expect(coalesced[0].diffSummary).toMatchObject({ additions: 7, deletions: 3 })
  })

  it('keeps the enriched Kimi host receipt and copies the wrapper round trip', () => {
    const resultSummary = 'Edited src/a.ts.'
    const providerActivity = activity('2:tool_54ALIIglrx40d9io3WGyvDYa', {
      toolName: 'mcp__taskwraith__replace',
      displayName: 'Edited file',
      category: 'write',
      startedAt: '2026-08-16T00:26:40.528Z',
      endedAt: '2026-08-16T00:27:06.476Z',
      durationMs: 25_948,
      parameters: {},
      resultSummary,
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })
    const hostActivity = activity('kimi-mcp-replace-1786840009148-m3wxiboq3yl', {
      toolName: 'replace',
      displayName: 'Edited src/a.ts',
      category: 'write',
      startedAt: '2026-08-16T00:26:49.149Z',
      endedAt: '2026-08-16T00:27:06.447Z',
      durationMs: 17_298,
      parameters: {
        path: 'src/a.ts',
        old_string: 'before',
        new_string: 'after',
        cwd: '/workspace'
      },
      filePath: 'src/a.ts',
      resultSummary,
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })

    const coalesced = coalesceMirroredTaskWraithActivities([providerActivity, hostActivity])

    expect(coalesced).toHaveLength(1)
    expect(coalesced[0].id).toBe('kimi-mcp-replace-1786840009148-m3wxiboq3yl')
    expect(coalesced[0].durationMs).toBe(25_948)
    expect(coalesced[0].filePath).toBe('src/a.ts')
  })

  it('keeps the enriched Mistral host receipt and copies the wrapper round trip', () => {
    const providerActivity = activity('MtlNbiz6L', {
      toolName: 'TaskWraith_replace',
      displayName: 'Ran replace',
      category: 'unknown',
      startedAt: '2026-08-24T02:16:29.026Z',
      endedAt: '2026-08-24T02:16:29.537Z',
      durationMs: 511,
      parameters: {},
      resultSummary: 'Ran replace',
      metadata: { provider: 'mistral', ensembleProvider: 'mistral' }
    })
    const hostActivity = activity('mistral-mcp-replace-1787451389069-nk41h7ege1', {
      toolName: 'replace',
      displayName: 'Edited src/a.ts',
      category: 'write',
      startedAt: '2026-08-24T02:16:29.069Z',
      endedAt: '2026-08-24T02:16:29.531Z',
      durationMs: 462,
      parameters: { path: 'src/a.ts', old_string: 'before', new_string: 'after' },
      filePath: 'src/a.ts',
      resultSummary: 'Ran replace',
      metadata: { provider: 'mistral', ensembleProvider: 'mistral' }
    })

    const coalesced = coalesceMirroredTaskWraithActivities([providerActivity, hostActivity])

    expect(coalesced).toHaveLength(1)
    expect(coalesced[0].id).toBe('mistral-mcp-replace-1787451389069-nk41h7ege1')
    expect(coalesced[0].durationMs).toBe(511)
  })

  it('leaves ordinary unmirrored tool activities untouched', () => {
    const first = activity('call_alpha', { toolName: 'read_file' })
    const second = activity('call_beta', { toolName: 'read_file' })

    expect(coalesceMirroredTaskWraithActivities([first, second])).toEqual([first, second])
  })
})

/**
 * Muse streams its own MSP `call_…` row for every TaskWraith MCP invocation AND
 * receives the host mirror, because `muse` is absent from
 * `PROVIDERS_WITH_NATIVE_MCP_TRANSCRIPT_ROWS`. Both shapes below are copied from
 * the durable run-event record of run `1789001724340-m7x225im22h`
 * (2026-09-10T00:56Z), where 13 logical calls produced 26 `tool_use` rows and
 * the two genuine failures rendered as four error cards.
 */
const MUSE_RUN_TASK_HOST_OUTPUT =
  '{"ok":false,"tool":"run_task","code":"invalid-call","error":"run_task cannot prove an exact file/hunk mutation scope for task \\"test\\"."}'
const MUSE_RUN_TASK_NATIVE_OUTPUT = `tool failed: ${MUSE_RUN_TASK_HOST_OUTPUT}`
const MUSE_RUN_TASK_PARAMETERS = { args: [], task: 'test', timeoutMs: 600_000 }
const MUSE_WORKSPACE = '/Users/chrisizatt/Documents/Test 1'

function museNativeRunTask(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return activity('call_01a088d084da7113b8f4e1f0a6dfac88', {
    toolName: 'mcp__taskwraith__run_task',
    displayName: 'Shell command',
    category: 'shell',
    status: 'error',
    startedAt: '2026-09-10T00:56:02.527Z',
    endedAt: '2026-09-10T00:56:02.570Z',
    parameters: MUSE_RUN_TASK_PARAMETERS,
    resultSummary: MUSE_RUN_TASK_NATIVE_OUTPUT,
    metadata: { provider: 'muse' },
    ...overrides
  })
}

function museHostRunTask(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return activity('muse-mcp-run_task-1789001762549-yxnwxusaqv', {
    toolName: 'run_task',
    displayName: 'Shell command',
    category: 'shell',
    status: 'error',
    startedAt: '2026-09-10T00:56:02.550Z',
    endedAt: '2026-09-10T00:56:02.553Z',
    durationMs: 3,
    parameters: { ...MUSE_RUN_TASK_PARAMETERS, cwd: MUSE_WORKSPACE },
    resultSummary: MUSE_RUN_TASK_HOST_OUTPUT,
    metadata: { provider: 'muse' },
    ...overrides
  })
}

describe('coalesceMirroredTaskWraithActivities — Muse MSP mirrors', () => {
  it('collapses a genuine Muse twin into one errored host receipt', () => {
    const coalesced = coalesceMirroredTaskWraithActivities([museNativeRunTask(), museHostRunTask()])

    expect(coalesced).toHaveLength(1)
    expect(coalesced[0].id).toBe('muse-mcp-run_task-1789001762549-yxnwxusaqv')
    expect(coalesced[0].status).toBe('error')
    // The host receipt owns the governed result text; the MSP row only reframes
    // it behind a `tool failed: ` prefix that eats into the 500-char preview.
    expect(coalesced[0].resultSummary).toBe(MUSE_RUN_TASK_HOST_OUTPUT)
    // ...and the MSP row owns the real round trip, so its timing is copied on.
    expect(coalesced[0].startedAt).toBe('2026-09-10T00:56:02.527Z')
    expect(coalesced[0].endedAt).toBe('2026-09-10T00:56:02.570Z')
    expect(coalesced[0].durationMs).toBe(43)
  })

  it('collapses every twin in a run so the error count is not doubled', () => {
    const nativeGitCommit = activity('call_01a088d09a237860a126a115c74b6bf8', {
      toolName: 'mcp__taskwraith__git_commit',
      displayName: 'Commit',
      category: 'task',
      status: 'error',
      startedAt: '2026-09-10T00:56:08.283Z',
      endedAt: '2026-09-10T00:56:08.782Z',
      parameters: { message: 'chore: jokes', mode: 'contribution', paths: ['jokes.py'] },
      resultSummary: 'tool failed: {"ok":false,"stage":"check_patch"}',
      metadata: { provider: 'muse' }
    })
    const hostGitCommit = activity('muse-mcp-git_commit-1789001768298-xb7nh260zrp', {
      toolName: 'git_commit',
      displayName: 'Commit',
      category: 'task',
      status: 'error',
      startedAt: '2026-09-10T00:56:08.299Z',
      endedAt: '2026-09-10T00:56:08.765Z',
      parameters: {
        cwd: MUSE_WORKSPACE,
        message: 'chore: jokes',
        mode: 'contribution',
        paths: ['jokes.py']
      },
      resultSummary: '{"ok":false,"stage":"check_patch"}',
      metadata: { provider: 'muse' }
    })
    const nativeListDirectory = activity('call_01a088d0525d7eb0806b3d0738e158ba', {
      toolName: 'mcp__taskwraith__list_directory',
      displayName: 'Listed .',
      startedAt: '2026-09-10T00:55:49.629Z',
      endedAt: '2026-09-10T00:55:49.671Z',
      parameters: { path: '.' },
      resultSummary: 'directory\t.git',
      metadata: { provider: 'muse' }
    })
    const hostListDirectory = activity('muse-mcp-list_directory-1789001749648-62epelydo9s', {
      toolName: 'list_directory',
      displayName: 'Listed .',
      startedAt: '2026-09-10T00:55:49.649Z',
      endedAt: '2026-09-10T00:55:49.652Z',
      parameters: { cwd: MUSE_WORKSPACE, path: '.' },
      resultSummary: 'directory\t.git',
      metadata: { provider: 'muse' }
    })

    const coalesced = coalesceMirroredTaskWraithActivities([
      nativeListDirectory,
      hostListDirectory,
      museNativeRunTask(),
      museHostRunTask(),
      nativeGitCommit,
      hostGitCommit
    ])

    expect(coalesced.map((entry) => entry.id)).toEqual([
      'muse-mcp-list_directory-1789001749648-62epelydo9s',
      'muse-mcp-run_task-1789001762549-yxnwxusaqv',
      'muse-mcp-git_commit-1789001768298-xb7nh260zrp'
    ])
    expect(coalesced.filter((entry) => entry.status === 'error')).toHaveLength(2)
  })

  it('keeps a lone Muse MSP row when no host receipt arrived', () => {
    const nativeActivity = museNativeRunTask()

    expect(coalesceMirroredTaskWraithActivities([nativeActivity])).toEqual([nativeActivity])
  })

  it('keeps a lone Muse host receipt when no MSP row arrived', () => {
    const hostActivity = museHostRunTask()

    expect(coalesceMirroredTaskWraithActivities([hostActivity])).toEqual([hostActivity])
  })

  it('does not fold a foreign provider MSP row into a Muse host receipt', () => {
    const codexActivity = museNativeRunTask({
      id: 'call_S4FwgBGn1qjX4zdeaiBq6ZS0',
      metadata: { provider: 'codex', ensembleProvider: 'codex' }
    })
    const hostActivity = museHostRunTask()

    const coalesced = coalesceMirroredTaskWraithActivities([codexActivity, hostActivity])

    expect(coalesced.map((entry) => entry.id)).toEqual([
      'call_S4FwgBGn1qjX4zdeaiBq6ZS0',
      'muse-mcp-run_task-1789001762549-yxnwxusaqv'
    ])
  })

  it('does not fold a Muse row whose id is not an MSP call id', () => {
    // Only the MSP lane was measured as twinning. An exec-lane or legacy row
    // carrying another id shape is unproven, so suppressing it would delete a
    // card rather than deduplicate one.
    const execLaneActivity = museNativeRunTask({ id: 'muse-tool-3' })

    const coalesced = coalesceMirroredTaskWraithActivities([execLaneActivity, museHostRunTask()])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a Muse row into a host receipt for a different tool', () => {
    // The id still spells run_task, so only the canonical tool-name comparison
    // can tell these two rows apart.
    const hostActivity = museHostRunTask({ toolName: 'git_status' })

    const coalesced = coalesceMirroredTaskWraithActivities([museNativeRunTask(), hostActivity])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a Muse row into a host receipt id that names another tool', () => {
    const hostActivity = museHostRunTask({ id: 'muse-mcp-git_status-1789001762549-yxnwxusaqv' })

    const coalesced = coalesceMirroredTaskWraithActivities([museNativeRunTask(), hostActivity])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a Muse row into a host receipt for different arguments', () => {
    const hostActivity = museHostRunTask({
      parameters: { ...MUSE_RUN_TASK_PARAMETERS, cwd: MUSE_WORKSPACE, task: 'lint' }
    })

    const coalesced = coalesceMirroredTaskWraithActivities([museNativeRunTask(), hostActivity])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a Muse pair whose settled verdicts disagree', () => {
    // Same governed text on both rows, but the MSP row called it a success while
    // the host receipt recorded the failure. Folding would flip the verdict the
    // user sees, so identical output is not on its own proof of a twin.
    const nativeActivity = museNativeRunTask({
      status: 'success',
      resultSummary: MUSE_RUN_TASK_HOST_OUTPUT
    })

    const coalesced = coalesceMirroredTaskWraithActivities([nativeActivity, museHostRunTask()])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a settled Muse success pair whose outputs disagree', () => {
    const nativeActivity = museNativeRunTask({
      status: 'success',
      resultSummary: '{"ok":true,"tool":"run_task","exitCode":0}'
    })
    const hostActivity = museHostRunTask({
      status: 'success',
      resultSummary: '{"ok":true,"tool":"run_task","exitCode":1}'
    })

    const coalesced = coalesceMirroredTaskWraithActivities([nativeActivity, hostActivity])

    expect(coalesced).toHaveLength(2)
  })

  it('folds a Muse pair that is still live, before either verdict is known', () => {
    const nativeActivity = museNativeRunTask({
      status: 'running',
      endedAt: undefined,
      resultSummary: undefined
    })
    const hostActivity = museHostRunTask({
      status: 'running',
      endedAt: undefined,
      durationMs: undefined,
      resultSummary: undefined
    })

    const coalesced = coalesceMirroredTaskWraithActivities([nativeActivity, hostActivity])

    expect(coalesced).toHaveLength(1)
    expect(coalesced[0].id).toBe('muse-mcp-run_task-1789001762549-yxnwxusaqv')
    expect(coalesced[0].startedAt).toBe('2026-09-10T00:56:02.527Z')
  })

  it('does not fold a host receipt that started before the Muse MSP row', () => {
    const hostActivity = museHostRunTask({
      startedAt: '2026-09-10T00:56:02.100Z',
      endedAt: '2026-09-10T00:56:02.180Z'
    })

    const coalesced = coalesceMirroredTaskWraithActivities([museNativeRunTask(), hostActivity])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a host receipt that opened long after the Muse MSP row', () => {
    const nativeActivity = museNativeRunTask({ endedAt: '2026-09-10T00:56:12.000Z' })
    const hostActivity = museHostRunTask({
      startedAt: '2026-09-10T00:56:07.000Z',
      endedAt: '2026-09-10T00:56:07.400Z'
    })

    const coalesced = coalesceMirroredTaskWraithActivities([nativeActivity, hostActivity])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a host receipt that outlived the Muse MSP row', () => {
    const hostActivity = museHostRunTask({ endedAt: '2026-09-10T00:56:03.400Z' })

    const coalesced = coalesceMirroredTaskWraithActivities([museNativeRunTask(), hostActivity])

    expect(coalesced).toHaveLength(2)
  })

  it('does not fold a Muse row that never named a TaskWraith tool', () => {
    const nativeActivity = museNativeRunTask({ toolName: 'run_task' })

    const coalesced = coalesceMirroredTaskWraithActivities([nativeActivity, museHostRunTask()])

    expect(coalesced).toHaveLength(2)
  })
})

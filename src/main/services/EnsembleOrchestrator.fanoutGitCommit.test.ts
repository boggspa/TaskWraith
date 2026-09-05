import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import { WorkspaceLockMcpAdmissionCoordinator } from '../WorkspaceLockMcpAdmissionCoordinator'
import { deriveWorkspaceMutationClaims } from '../WorkspaceMutationClaims'
import type { WorkspaceLockRuntimeAcquireInput } from '../WorkspaceLockRuntime'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

const workspacePath = resolve('/repo')
const orchestrators: EnsembleOrchestrator[] = []

function participant(id: string, order: number): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    role: id,
    order,
    enabled: true,
    permissionPresetId: 'workspace_write',
    instructions: `Complete ${id}'s assigned work.`
  }
}

function harness(preflight = false) {
  vi.stubEnv('TASKWRAITH_CONCURRENT_LANES', '1')
  vi.stubEnv('TASKWRAITH_CONCURRENT_WRITE_LANES', '1')
  let chat: ChatRecord = {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Fanout lane commits',
    workspaceId: 'workspace',
    workspacePath,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 3,
      fanoutPolicy: preflight ? 'locked_writers_user_preflight' : 'locked_writers_with_boss',
      fanoutIsolation: 'off',
      ...(preflight ? {} : { bossmanParticipantId: 'Boss' }),
      participants: preflight
        ? [participant('WorkerA', 1), participant('WorkerB', 2)]
        : [participant('Boss', 1), participant('WorkerA', 2), participant('WorkerB', 3)]
    }
  }
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: () => ({ ensembleModeEnabled: true, storeLocalChatHistory: true }) as AppSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun: vi.fn(async () => true),
    createRunId: () => `run-${++counter}`,
    now: Date.now,
    nowIso: () => new Date().toISOString()
  })
  orchestrators.push(orchestrator)
  const acquire = vi.fn(async (input: WorkspaceLockRuntimeAcquireInput) => ({
    ok: true as const,
    owner: { ...input.owner, pid: 42, processBirthIdentity: 'test-birth' },
    claims: await deriveWorkspaceMutationClaims(input.mutation!),
    authority: { ok: true as const, transitionId: 'test-transition', tokens: [], leases: [] }
  }))
  const coordinator = new WorkspaceLockMcpAdmissionCoordinator({
    getRuntime: () => ({ acquire }),
    getChat: () => chat,
    getOpaqueOwnerId: ({ runId }) => `opaque-${runId}`,
    getProviderScopeAdmission: () => null,
    acquireProviderScopeSublease: vi.fn(),
    validateLaneWriteScope: (runId, query) =>
      orchestrator.validateLaneWriteScopeForRun(runId, query),
    markLaneBlocked: vi.fn(),
    encode: JSON.stringify,
    providerDisplayName: (provider) => provider
  })
  function admit(payload: AgentRunPayload, toolName: string, args: Record<string, unknown>) {
    const lane = Object.values(chat.ensemble!.activeRound!.lanes!).find(
      (candidate) => candidate.runId === payload.appRunId
    )!
    return coordinator.admit({
      context: {
        scope: 'workspace',
        cwd: workspacePath,
        workspacePath,
        appChatId: chat.appChatId,
        appRunId: payload.appRunId,
        ensembleRun: {
          roundId: chat.ensemble!.activeRound!.roundId,
          participantId: lane.participantId,
          laneId: lane.laneId,
          provider: payload.provider,
          role: lane.participantId,
          order: 1
        }
      },
      provider: payload.provider,
      toolName,
      args
    })
  }
  function complete(payload: AgentRunPayload, content?: string) {
    const route = { appRunId: payload.appRunId, appChatId: chat.appChatId }
    if (content)
      orchestrator.handleProviderOutput(payload.provider, route, { type: 'content', text: content })
    orchestrator.handleProviderOutput(payload.provider, route, {
      type: 'result',
      status: 'success'
    })
  }
  function start() {
    orchestrator.startRound({
      chatId: chat.appChatId,
      prompt: 'Implement and commit each assigned slice.',
      event: { sender: {} as Electron.WebContents }
    })
  }
  return { orchestrator, dispatched, acquire, admit, complete, start }
}

afterEach(async () => {
  await Promise.all(
    orchestrators.splice(0).map((orchestrator) => orchestrator.cancelRound('ensemble-chat'))
  )
  vi.unstubAllEnvs()
})

async function startFanout(mode: 'locked_writers' | 'read_only' = 'locked_writers') {
  const test = harness()
  test.start()
  await vi.waitFor(() => expect(test.dispatched).toHaveLength(1))
  const result = await test.orchestrator.fanoutForRun(test.dispatched[0].appRunId, {
    targets: ['WorkerA', 'WorkerB'],
    prompt: 'Finish and commit your assigned files.',
    mode,
    isolation: 'off',
    ...(mode === 'locked_writers'
      ? { writeScopes: { WorkerA: ['src/a/**'], WorkerB: ['src/b/**'] } }
      : {})
  })
  expect(result.ok).toBe(true)
  await vi.waitFor(() => expect(test.dispatched).toHaveLength(3))
  return test
}

describe('fanout Git commit admission', () => {
  it('admits pathspec and private-index commits while sibling writer lanes remain active', async () => {
    const test = await startFanout()
    for (const [index, mode] of ['pathspec', 'private_index'].entries()) {
      const payload = test.dispatched[index + 1]
      const path = index === 0 ? 'src/a/output.ts' : 'src/b/output.ts'
      const args = {
        mode,
        message: 'Commit own slice',
        paths: [path],
        ...(mode === 'private_index'
          ? {
              patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`
            }
          : {})
      }
      expect(await test.admit(payload, 'git_stage', { paths: [path] })).toMatchObject({ ok: true })
      expect(await test.admit(payload, 'git_commit', args)).toMatchObject({
        ok: true,
        claimsHeld: true,
        releaseAfterOperation: true,
        claims: [
          expect.objectContaining({ kind: 'file', targetPath: resolve(workspacePath, '.git') })
        ]
      })
      expect(payload.prompt).toContain('Writer lanes may use listed git_stage and git_commit')
      expect(payload.prompt).not.toContain('Do not stage or commit')
    }
    expect(test.acquire).toHaveBeenCalledTimes(4)
  })

  it('rejects sibling paths, mixed slices and repository-wide staging before acquiring a lock', async () => {
    const test = await startFanout()
    const worker = test.dispatched[1]
    for (const paths of [['src/b/output.ts'], ['src/a/output.ts', 'src/b/output.ts']]) {
      expect(await test.admit(worker, 'git_stage', { paths })).toMatchObject({ ok: false })
      expect(
        await test.admit(worker, 'git_commit', {
          mode: 'pathspec',
          message: 'Out of scope',
          paths
        })
      ).toMatchObject({ ok: false })
    }
    expect(await test.admit(worker, 'git_stage', { all: true })).toMatchObject({ ok: false })
    expect(
      await test.admit(worker, 'git_stage', {
        patch: [
          'diff --git a/src/a/output.ts b/src/b/output.ts',
          'similarity index 100%',
          'rename from src/a/output.ts',
          'rename to src/b/output.ts',
          ''
        ].join('\n')
      })
    ).toMatchObject({ ok: false })
    expect(test.acquire).not.toHaveBeenCalled()
  })

  it('keeps read-only lanes from committing', async () => {
    const test = await startFanout('read_only')
    const worker = test.dispatched[1]
    const args = { mode: 'pathspec', message: 'Read lane', paths: ['src/a/output.ts'] }
    expect(await test.admit(worker, 'git_commit', args)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a writer lane')
    })
    expect(test.acquire).not.toHaveBeenCalled()
  })

  it('allows user-preflight writers to commit after their read-only claim and acknowledgment passes', async () => {
    const test = harness(true)
    test.start()
    await vi.waitFor(() => expect(test.dispatched).toHaveLength(2))
    for (const [index, payload] of test.dispatched.slice().entries()) {
      expect(payload.prompt).toContain('Do not edit files, run shell commands, stage, or commit')
      test.complete(
        payload,
        '```taskwraith_write_claim\n' +
          JSON.stringify({
            writeScopes: [index === 0 ? 'src/a/**' : 'src/b/**'],
            operations: ['edit'],
            rationale: 'Own slice',
            canFallbackToSerial: true,
            acknowledgeExclusiveScope: true
          }) +
          '\n```'
      )
    }
    await vi.waitFor(() => expect(test.dispatched).toHaveLength(4))
    for (const payload of test.dispatched.slice(2, 4)) {
      test.complete(payload, '```taskwraith_write_ack\n{"acknowledgeMatrix":true}\n```')
    }
    await vi.waitFor(() => expect(test.dispatched).toHaveLength(6))
    for (const [index, payload] of test.dispatched.slice(4, 6).entries()) {
      expect(payload.prompt).not.toContain('Do not stage or commit')
      expect(payload.prompt).toContain('git_commit(mode="private_index")')
      expect(
        await test.admit(payload, 'git_commit', {
          mode: 'pathspec',
          message: 'Commit own preflight slice',
          paths: [index === 0 ? 'src/a/output.ts' : 'src/b/output.ts']
        })
      ).toMatchObject({ ok: true })
    }
  })
})

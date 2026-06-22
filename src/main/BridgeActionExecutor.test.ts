import { describe, expect, it, vi } from 'vitest'
import { MainProcessActionExecutor, NoopActionExecutor } from './BridgeActionExecutor'
import type {
  BridgeApprovalReplyAction,
  BridgeCancelRunAction,
  BridgeComposerPromptAction,
  BridgeEnsembleCancelRoundAction,
  BridgeEnsembleCancelWakeupAction,
  BridgeEnsembleQueuePromptAction,
  BridgeEnsembleSkipActiveParticipantAction,
  BridgeEnsembleSteerAction,
  BridgeEnsembleWakeNowAction,
  BridgeQuestionRejectAction,
  BridgeQuestionReplyAction,
  BridgeRegisterApnsTokenAction,
  BridgeDiscoverTailnetHostsAction,
  BridgeSetYoloModeAction,
  BridgeThreadMediaFetchAction,
  BridgeThreadSnapshotRequestAction,
  BridgeWorkspaceFileListAction,
  BridgeWorkspaceFileReadAction,
  BridgeWorkspaceFileWriteAction,
  BridgeWorkspaceFileDeleteAction,
  BridgeWorkspaceDiffAction,
  BridgeGitSnapshotAction,
  BridgeGitStageAllAction,
  BridgeGitStagePathsAction,
  BridgeGitUnstagePathsAction,
  BridgeGitCommitAction,
  BridgeGitPushAction,
  BridgeGithubPrStatusAction,
  BridgeGithubPrReadinessAction,
  BridgeGithubCreatePrAction,
  BridgeGoalUpdateAction,
  BridgeProposedPlanDecisionAction,
  BridgeCanvasActionAction,
  BridgeTogglePinChatAction,
  BridgeTogglePinWorkspaceAction
} from './BridgeActionPayload'

const sample = {
  approvalReply: {
    kind: 'approvalReply',
    workspaceId: 'ws-1',
    threadId: 't-1',
    toolCallId: 'tc-99',
    decision: 'accept'
  } satisfies BridgeApprovalReplyAction,
  questionReply: {
    kind: 'questionReply',
    workspaceId: 'ws-1',
    threadId: 't-1',
    runId: 'run-1',
    promptId: 'q-1',
    answer: 'yes'
  } satisfies BridgeQuestionReplyAction,
  questionReject: {
    kind: 'questionReject',
    workspaceId: 'ws-1',
    threadId: 't-1',
    runId: 'run-1',
    promptId: 'q-1'
  } satisfies BridgeQuestionRejectAction,
  composerPrompt: {
    kind: 'composerPrompt',
    workspaceId: 'ws-1',
    threadId: 't-1',
    provider: 'gemini',
    text: 'hello'
  } satisfies BridgeComposerPromptAction,
  cancelRun: {
    kind: 'cancelRun',
    workspaceId: 'ws-1',
    threadId: 't-1',
    provider: 'gemini',
    runId: 'run-42'
  } satisfies BridgeCancelRunAction,
  ensembleCancelRound: {
    kind: 'ensembleCancelRound',
    workspaceId: 'ws-1',
    threadId: 't-1',
    roundId: 'round-1'
  } satisfies BridgeEnsembleCancelRoundAction,
  ensembleSkipActiveParticipant: {
    kind: 'ensembleSkipActiveParticipant',
    workspaceId: 'ws-1',
    threadId: 't-1',
    roundId: 'round-1',
    participantId: 'participant-1'
  } satisfies BridgeEnsembleSkipActiveParticipantAction,
  ensembleWakeNow: {
    kind: 'ensembleWakeNow',
    workspaceId: 'ws-1',
    threadId: 't-1',
    wakeupId: 'wakeup-1'
  } satisfies BridgeEnsembleWakeNowAction,
  ensembleCancelWakeup: {
    kind: 'ensembleCancelWakeup',
    workspaceId: 'ws-1',
    threadId: 't-1',
    wakeupId: 'wakeup-1'
  } satisfies BridgeEnsembleCancelWakeupAction,
  ensembleQueuePrompt: {
    kind: 'ensembleQueuePrompt',
    workspaceId: 'ws-1',
    threadId: 't-1',
    text: 'queue this'
  } satisfies BridgeEnsembleQueuePromptAction,
  ensembleSteer: {
    kind: 'ensembleSteer',
    workspaceId: 'ws-1',
    threadId: 't-1',
    text: 'steer this'
  } satisfies BridgeEnsembleSteerAction,
  registerApnsToken: {
    kind: 'registerApnsToken',
    pairID: 'pair-1',
    deviceToken: 'abc123def456',
    env: 'production'
  } satisfies BridgeRegisterApnsTokenAction,
  setYoloMode: {
    kind: 'setYoloMode',
    workspaceId: 'ws-1',
    enabled: true
  } satisfies BridgeSetYoloModeAction,
  threadSnapshotRequest: {
    kind: 'threadSnapshotRequest',
    workspaceId: 'ws-1',
    threadId: 't-1',
    limit: 40,
    beforeRowId: 'm7'
  } satisfies BridgeThreadSnapshotRequestAction,
  threadMediaFetch: {
    kind: 'threadMediaFetch',
    workspaceId: 'ws-1',
    threadId: 't-1',
    rowId: 'm7',
    mediaId: 'media-1',
    variant: 'thumbnail',
    maxBytes: 512000
  } satisfies BridgeThreadMediaFetchAction,
  goalUpdate: {
    kind: 'goalUpdate',
    workspaceId: 'ws-1',
    threadId: 't-1',
    op: 'set',
    objective: 'Ship the mobile goal control'
  } satisfies BridgeGoalUpdateAction,
  proposedPlanDecision: {
    kind: 'proposedPlanDecision',
    workspaceId: 'ws-1',
    threadId: 't-1',
    messageId: 'm7',
    decision: 'dismissed'
  } satisfies BridgeProposedPlanDecisionAction,
  canvasAction: {
    kind: 'canvasAction',
    workspaceId: 'ws-1',
    threadId: 't-1',
    canvasId: 'cv1',
    action: 'close'
  } satisfies BridgeCanvasActionAction,
  togglePinChat: {
    kind: 'togglePinChat',
    workspaceId: 'ws-1',
    appChatId: 'chat-1',
    pinned: true
  } satisfies BridgeTogglePinChatAction,
  togglePinWorkspace: {
    kind: 'togglePinWorkspace',
    workspaceId: 'ws-1',
    pinned: true
  } satisfies BridgeTogglePinWorkspaceAction,
  workspaceFileList: {
    kind: 'workspaceFileList',
    workspaceId: 'ws-1'
  } satisfies BridgeWorkspaceFileListAction,
  workspaceFileRead: {
    kind: 'workspaceFileRead',
    workspaceId: 'ws-1',
    path: 'README.md'
  } satisfies BridgeWorkspaceFileReadAction,
  workspaceFileWrite: {
    kind: 'workspaceFileWrite',
    workspaceId: 'ws-1',
    path: 'README.md',
    content: 'hello',
    baseEtag: 'sha256:abc'
  } satisfies BridgeWorkspaceFileWriteAction,
  workspaceFileDelete: {
    kind: 'workspaceFileDelete',
    workspaceId: 'ws-1',
    path: 'README.md'
  } satisfies BridgeWorkspaceFileDeleteAction,
  workspaceDiff: {
    kind: 'workspaceDiff',
    workspaceId: 'ws-1'
  } satisfies BridgeWorkspaceDiffAction,
  gitSnapshot: {
    kind: 'gitSnapshot',
    workspaceId: 'ws-1'
  } satisfies BridgeGitSnapshotAction,
  gitStageAll: {
    kind: 'gitStageAll',
    workspaceId: 'ws-1'
  } satisfies BridgeGitStageAllAction,
  gitStagePaths: {
    kind: 'gitStagePaths',
    workspaceId: 'ws-1',
    paths: ['README.md']
  } satisfies BridgeGitStagePathsAction,
  gitUnstagePaths: {
    kind: 'gitUnstagePaths',
    workspaceId: 'ws-1',
    paths: ['README.md']
  } satisfies BridgeGitUnstagePathsAction,
  gitCommit: {
    kind: 'gitCommit',
    workspaceId: 'ws-1',
    message: 'fix: from the phone',
    stageAll: true
  } satisfies BridgeGitCommitAction,
  gitPush: {
    kind: 'gitPush',
    workspaceId: 'ws-1',
    setUpstream: true
  } satisfies BridgeGitPushAction,
  githubPrStatus: {
    kind: 'githubPrStatus',
    workspaceId: 'ws-1'
  } satisfies BridgeGithubPrStatusAction,
  githubPrReadiness: {
    kind: 'githubPrReadiness',
    workspaceId: 'ws-1'
  } satisfies BridgeGithubPrReadinessAction,
  githubCreatePr: {
    kind: 'githubCreatePr',
    workspaceId: 'ws-1',
    title: 'Phone PR'
  } satisfies BridgeGithubCreatePrAction,
  discoverTailnetHosts: {
    kind: 'discoverTailnetHosts'
  } satisfies BridgeDiscoverTailnetHostsAction
}

describe('NoopActionExecutor', () => {
  it('returns executed=false with id in message for every variant', async () => {
    const executor = new NoopActionExecutor()
    const results = await Promise.all([
      executor.executeApprovalReply(sample.approvalReply),
      executor.executeQuestionReply(sample.questionReply),
      executor.executeQuestionReject(sample.questionReject),
      executor.executeComposerPrompt(sample.composerPrompt),
      executor.executeCancelRun(sample.cancelRun),
      executor.executeEnsembleCancelRound(sample.ensembleCancelRound),
      executor.executeEnsembleSkipActiveParticipant(sample.ensembleSkipActiveParticipant),
      executor.executeEnsembleWakeNow(sample.ensembleWakeNow),
      executor.executeEnsembleCancelWakeup(sample.ensembleCancelWakeup),
      executor.executeEnsembleQueuePrompt(sample.ensembleQueuePrompt),
      executor.executeEnsembleSteer(sample.ensembleSteer),
      executor.executeRegisterApnsToken(sample.registerApnsToken),
      executor.executeSetYoloMode(sample.setYoloMode),
      executor.executeGoalUpdate(sample.goalUpdate),
      executor.executeTogglePinChat(sample.togglePinChat),
      executor.executeTogglePinWorkspace(sample.togglePinWorkspace),
      executor.executeWorkspaceFileList(sample.workspaceFileList),
      executor.executeWorkspaceFileRead(sample.workspaceFileRead),
      executor.executeWorkspaceFileWrite(sample.workspaceFileWrite),
      executor.executeWorkspaceFileDelete(sample.workspaceFileDelete),
      executor.executeWorkspaceDiff(sample.workspaceDiff),
      executor.executeThreadMediaFetch(sample.threadMediaFetch),
      executor.executeDiscoverTailnetHosts(sample.discoverTailnetHosts)
    ])
    for (const r of results) {
      expect(r.executed).toBe(false)
      expect(r.message).toMatch(/not yet wired/i)
    }
    // Each message should include the unique id for the variant
    expect(results[0].message).toContain('tc-99')
    expect(results[1].message).toContain('q-1')
    expect(results[2].message).toContain('q-1')
    expect(results[3].message).toContain('t-1')
    expect(results[4].message).toContain('run-42')
    expect(results[5].message).toContain('t-1')
    expect(results[6].message).toContain('t-1')
    expect(results[7].message).toContain('wakeup-1')
    expect(results[8].message).toContain('wakeup-1')
    expect(results[9].message).toContain('t-1')
    expect(results[10].message).toContain('t-1')
    expect(results[11].message).toContain('pair-1')
    expect(results[12].message).toContain('true')
    expect(results[13].message).toContain('t-1')
    expect(results[14].message).toContain('chat-1')
    expect(results[15].message).toContain('ws-1')
    expect(results[16].message).toContain('ws-1')
    expect(results[17].message).toContain('README.md')
    expect(results[18].message).toContain('README.md')
    expect(results[19].message).toContain('README.md')
    expect(results[20].message).toContain('ws-1')
    expect(results[21].message).toContain('media-1')
    expect(results[22].message).toContain('oracle')
  })
})

describe('MainProcessActionExecutor workspace file actions', () => {
  it('returns transcript media from a wired media fetch callback', async () => {
    const threadMediaFetchFn = vi.fn().mockResolvedValue({
      ok: true,
      media: {
        id: 'media-1',
        rowId: 'm7',
        threadId: 't-1',
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
        variant: 'thumbnail'
      }
    })
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      threadMediaFetchFn
    })

    await expect(executor.executeThreadMediaFetch(sample.threadMediaFetch)).resolves.toMatchObject({
      executed: true,
      data: {
        mediaId: 'media-1',
        rowId: 'm7',
        threadId: 't-1',
        media: { id: 'media-1', mimeType: 'image/png' }
      }
    })
    expect(threadMediaFetchFn).toHaveBeenCalledWith(sample.threadMediaFetch)
  })

  it('surfaces media fetch callback failures as executed=false', async () => {
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      threadMediaFetchFn: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'File read capability required for workspace media'
      })
    })

    await expect(executor.executeThreadMediaFetch(sample.threadMediaFetch)).resolves.toMatchObject({
      executed: false,
      message: 'File read capability required for workspace media'
    })
  })

  it('returns thread snapshots in the ack payload', async () => {
    const threadSnapshotRequestFn = vi.fn().mockResolvedValue({
      ok: true,
      thread: {
        threadId: 't-1',
        taskId: 't-1',
        rows: [{ id: 'm4', role: 'assistant', preview: 'older' }],
        windowStartIndex: 4,
        hasMoreAbove: true
      }
    })
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      threadSnapshotRequestFn
    })

    await expect(
      executor.executeThreadSnapshotRequest(sample.threadSnapshotRequest)
    ).resolves.toMatchObject({
      executed: true,
      data: {
        threadId: 't-1',
        thread: {
          threadId: 't-1',
          rows: [{ id: 'm4' }],
          windowStartIndex: 4
        }
      }
    })
    expect(threadSnapshotRequestFn).toHaveBeenCalledWith(sample.threadSnapshotRequest)
  })

  it('returns list/read/write data from wired callbacks', async () => {
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      workspaceFileListFn: vi.fn().mockResolvedValue({
        ok: true,
        entries: [{ path: 'README.md', name: 'README.md', isDirectory: false, depth: 0 }],
        truncated: false
      }),
      workspaceFileReadFn: vi.fn().mockResolvedValue({
        ok: true,
        file: { path: 'README.md', content: 'hello', sizeBytes: 5, etag: 'sha256:abc' }
      }),
      workspaceFileWriteFn: vi.fn().mockResolvedValue({
        ok: true,
        file: { path: 'README.md', content: 'hi', sizeBytes: 2, etag: 'sha256:def' },
        changeSet: { id: 'change-1' }
      }),
      workspaceFileDeleteFn: vi.fn().mockResolvedValue({
        ok: true,
        path: 'README.md',
        changeSet: { id: 'delete-1' }
      })
    })

    await expect(executor.executeWorkspaceFileList(sample.workspaceFileList)).resolves.toMatchObject(
      {
        executed: true,
        data: { entries: [{ path: 'README.md' }], truncated: false }
      }
    )
    await expect(executor.executeWorkspaceFileRead(sample.workspaceFileRead)).resolves.toMatchObject(
      {
        executed: true,
        data: { file: { path: 'README.md', etag: 'sha256:abc' } }
      }
    )
    await expect(
      executor.executeWorkspaceFileWrite(sample.workspaceFileWrite)
    ).resolves.toMatchObject({
      executed: true,
      data: { file: { path: 'README.md', etag: 'sha256:def' }, changeSet: { id: 'change-1' } }
    })
    await expect(
      executor.executeWorkspaceFileDelete(sample.workspaceFileDelete)
    ).resolves.toMatchObject({
      executed: true,
      data: { path: 'README.md', changeSet: { id: 'delete-1' } }
    })
  })

  it('returns the bounded diff from a wired workspaceDiffFn', async () => {
    const workspaceDiffFn = vi.fn().mockResolvedValue({
      ok: true,
      diff: {
        files: [{ path: 'README.md', kind: 'modified', additions: 2, deletions: 1, hunks: [] }],
        totalFiles: 1,
        truncated: false
      }
    })
    const executor = new MainProcessActionExecutor({ cancelRunFn: vi.fn(), workspaceDiffFn })
    await expect(executor.executeWorkspaceDiff(sample.workspaceDiff)).resolves.toMatchObject({
      executed: true,
      data: { diff: { files: [{ path: 'README.md' }], totalFiles: 1, truncated: false } }
    })
    expect(workspaceDiffFn).toHaveBeenCalledWith(sample.workspaceDiff)
  })

  it('surfaces workspaceDiffFn failures as executed=false', async () => {
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      workspaceDiffFn: vi.fn().mockResolvedValue({ ok: false, reason: 'not a git repository' })
    })
    await expect(executor.executeWorkspaceDiff(sample.workspaceDiff)).resolves.toMatchObject({
      executed: false,
      message: 'not a git repository'
    })
  })
})

describe('MainProcessActionExecutor git workflow actions', () => {
  const gitData = { branch: 'main', ahead: 1, behind: 0, clean: false }

  it('returns the compact snapshot from each wired git mutation callback', async () => {
    const gitSnapshotFn = vi.fn().mockResolvedValue({ ok: true, git: gitData })
    const gitStageAllFn = vi.fn().mockResolvedValue({ ok: true, git: gitData })
    const gitStagePathsFn = vi.fn().mockResolvedValue({ ok: true, git: gitData })
    const gitUnstagePathsFn = vi.fn().mockResolvedValue({ ok: true, git: gitData })
    const gitCommitFn = vi.fn().mockResolvedValue({ ok: true, git: gitData })
    const gitPushFn = vi.fn().mockResolvedValue({ ok: true, git: gitData })
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      gitSnapshotFn,
      gitStageAllFn,
      gitStagePathsFn,
      gitUnstagePathsFn,
      gitCommitFn,
      gitPushFn
    })

    await expect(executor.executeGitSnapshot(sample.gitSnapshot)).resolves.toMatchObject({
      executed: true,
      data: { git: { branch: 'main' } }
    })
    expect(gitSnapshotFn).toHaveBeenCalledWith(sample.gitSnapshot)

    await expect(executor.executeGitStageAll(sample.gitStageAll)).resolves.toMatchObject({
      executed: true,
      data: { git: { branch: 'main' } }
    })
    await expect(executor.executeGitStagePaths(sample.gitStagePaths)).resolves.toMatchObject({
      executed: true,
      data: { git: { branch: 'main' } }
    })
    expect(gitStagePathsFn).toHaveBeenCalledWith(sample.gitStagePaths)
    await expect(executor.executeGitUnstagePaths(sample.gitUnstagePaths)).resolves.toMatchObject({
      executed: true,
      data: { git: { branch: 'main' } }
    })
    expect(gitUnstagePathsFn).toHaveBeenCalledWith(sample.gitUnstagePaths)
    await expect(executor.executeGitCommit(sample.gitCommit)).resolves.toMatchObject({
      executed: true,
      data: { git: { branch: 'main' } }
    })
    expect(gitCommitFn).toHaveBeenCalledWith(sample.gitCommit)
    await expect(executor.executeGitPush(sample.gitPush)).resolves.toMatchObject({
      executed: true,
      data: { git: { branch: 'main' } }
    })
  })

  it('treats "no PR for this branch" as a successful read with empty data', async () => {
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      githubPrStatusFn: vi.fn().mockResolvedValue({ ok: true })
    })
    const result = await executor.executeGithubPrStatus(sample.githubPrStatus)
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/no pull request/i)
    expect(result.data?.pr).toBeUndefined()
  })

  it('returns PR summary and readiness data from wired callbacks', async () => {
    const pr = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }
    const readiness = { canCreatePullRequest: false, shouldPushFirst: true, reason: 'Push first' }
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      githubPrStatusFn: vi.fn().mockResolvedValue({ ok: true, pr }),
      githubPrReadinessFn: vi.fn().mockResolvedValue({ ok: true, readiness }),
      githubCreatePrFn: vi.fn().mockResolvedValue({ ok: true, pr })
    })

    await expect(executor.executeGithubPrStatus(sample.githubPrStatus)).resolves.toMatchObject({
      executed: true,
      data: { pr: { number: 7 } }
    })
    await expect(
      executor.executeGithubPrReadiness(sample.githubPrReadiness)
    ).resolves.toMatchObject({
      executed: true,
      data: { readiness: { canCreatePullRequest: false, shouldPushFirst: true } }
    })
    await expect(executor.executeGithubCreatePr(sample.githubCreatePr)).resolves.toMatchObject({
      executed: true,
      data: { pr: { url: 'https://github.com/o/r/pull/7' } }
    })
  })

  it('surfaces git callback declines with their legible reasons', async () => {
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      gitCommitFn: vi.fn().mockResolvedValue({ ok: false, reason: 'No staged changes to commit.' }),
      gitPushFn: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'No git remote is configured. Add a remote before pushing.' }),
      githubCreatePrFn: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'This branch already has a pull request.' })
    })

    await expect(executor.executeGitCommit(sample.gitCommit)).resolves.toMatchObject({
      executed: false,
      message: 'No staged changes to commit.'
    })
    await expect(executor.executeGitPush(sample.gitPush)).resolves.toMatchObject({
      executed: false,
      message: 'No git remote is configured. Add a remote before pushing.'
    })
    await expect(executor.executeGithubCreatePr(sample.githubCreatePr)).resolves.toMatchObject({
      executed: false,
      message: 'This branch already has a pull request.'
    })
  })

  it('reports git callback exceptions as execution failures', async () => {
    const executor = new MainProcessActionExecutor({
      cancelRunFn: vi.fn(),
      gitPushFn: vi.fn().mockRejectedValue(new Error('remote hung up'))
    })
    const result = await executor.executeGitPush(sample.gitPush)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/remote hung up/)
  })

  it('returns notWired for every git action when callbacks are absent', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn: vi.fn() })
    for (const probe of [
      executor.executeGitSnapshot(sample.gitSnapshot),
      executor.executeGitStageAll(sample.gitStageAll),
      executor.executeGitStagePaths(sample.gitStagePaths),
      executor.executeGitUnstagePaths(sample.gitUnstagePaths),
      executor.executeGitCommit(sample.gitCommit),
      executor.executeGitPush(sample.gitPush),
      executor.executeGithubPrStatus(sample.githubPrStatus),
      executor.executeGithubPrReadiness(sample.githubPrReadiness),
      executor.executeGithubCreatePr(sample.githubCreatePr)
    ]) {
      const result = await probe
      expect(result.executed).toBe(false)
      expect(result.message).toMatch(/not yet wired/i)
    }
  })
})

describe('MainProcessActionExecutor.executeCancelRun', () => {
  it('dispatches to cancelRunFn with provider + runId', async () => {
    const cancelRunFn = vi.fn().mockResolvedValue({ canceled: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeCancelRun(sample.cancelRun)
    expect(cancelRunFn).toHaveBeenCalledTimes(1)
    expect(cancelRunFn).toHaveBeenCalledWith('gemini', 'run-42')
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/run-42/)
    expect(result.message).toMatch(/gemini/)
    expect(result.data).toMatchObject({
      cancelResult: { canceled: true },
      runId: 'run-42',
      provider: 'gemini'
    })
  })

  it('handles non-serializable cancelRunFn results gracefully', async () => {
    const cancelRunFn = vi.fn().mockResolvedValue(() => 'I am a function')
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeCancelRun(sample.cancelRun)
    expect(result.executed).toBe(true)
    expect(result.data?.cancelResult).toBeNull()
  })

  it('returns executed=false when cancelRunFn throws', async () => {
    const cancelRunFn = vi.fn().mockRejectedValue(new Error('provider gone'))
    const log = vi.fn()
    const executor = new MainProcessActionExecutor({ cancelRunFn, log })
    const result = await executor.executeCancelRun(sample.cancelRun)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/cancel dispatch failed/i)
    expect(result.message).toMatch(/provider gone/)
    expect(log).toHaveBeenCalled()
  })

  it('passes through provider variants — codex / claude / kimi', async () => {
    const cancelRunFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    for (const provider of ['codex', 'claude', 'kimi'] as const) {
      await executor.executeCancelRun({ ...sample.cancelRun, provider })
    }
    expect(cancelRunFn.mock.calls.map((c) => c[0])).toEqual(['codex', 'claude', 'kimi'])
  })
})

describe('MainProcessActionExecutor Ensemble controls', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('dispatches each Ensemble action to its matching handler', async () => {
    const deps = {
      cancelRunFn,
      ensembleCancelRoundFn: vi.fn(async () => ({ ok: true, roundId: 'round-1' })),
      ensembleSkipActiveParticipantFn: vi.fn(async () => ({ ok: true })),
      ensembleWakeNowFn: vi.fn(async () => ({ ok: true, wakeupId: 'wakeup-1' })),
      ensembleCancelWakeupFn: vi.fn(async () => ({ ok: true, wakeupId: 'wakeup-1' })),
      ensembleQueuePromptFn: vi.fn(async () => ({ ok: true })),
      ensembleSteerFn: vi.fn(async () => ({ status: 'steered', roundId: 'round-2' }))
    }
    const executor = new MainProcessActionExecutor(deps)

    const results = await Promise.all([
      executor.executeEnsembleCancelRound(sample.ensembleCancelRound),
      executor.executeEnsembleSkipActiveParticipant(sample.ensembleSkipActiveParticipant),
      executor.executeEnsembleWakeNow(sample.ensembleWakeNow),
      executor.executeEnsembleCancelWakeup(sample.ensembleCancelWakeup),
      executor.executeEnsembleQueuePrompt(sample.ensembleQueuePrompt),
      executor.executeEnsembleSteer(sample.ensembleSteer)
    ])

    expect(deps.ensembleCancelRoundFn).toHaveBeenCalledWith(sample.ensembleCancelRound)
    expect(deps.ensembleSkipActiveParticipantFn).toHaveBeenCalledWith(
      sample.ensembleSkipActiveParticipant
    )
    expect(deps.ensembleWakeNowFn).toHaveBeenCalledWith(sample.ensembleWakeNow)
    expect(deps.ensembleCancelWakeupFn).toHaveBeenCalledWith(sample.ensembleCancelWakeup)
    expect(deps.ensembleQueuePromptFn).toHaveBeenCalledWith(sample.ensembleQueuePrompt)
    expect(deps.ensembleSteerFn).toHaveBeenCalledWith(sample.ensembleSteer)
    expect(results.map((result) => result.executed)).toEqual([true, true, true, true, true, true])
  })

  it('surfaces handler declines without throwing', async () => {
    const ensembleCancelRoundFn = vi.fn(async () => ({
      ok: false,
      error: 'Round id is no longer active'
    }))
    const executor = new MainProcessActionExecutor({ cancelRunFn, ensembleCancelRoundFn })
    const result = await executor.executeEnsembleCancelRound(sample.ensembleCancelRound)

    expect(result.executed).toBe(false)
    expect(result.message).toContain('Round id is no longer active')
  })

  it('reports handler exceptions as execution failures', async () => {
    const log = vi.fn()
    const ensembleWakeNowFn = vi.fn(async () => {
      throw new Error('orchestrator unavailable')
    })
    const executor = new MainProcessActionExecutor({ cancelRunFn, ensembleWakeNowFn, log })
    const result = await executor.executeEnsembleWakeNow(sample.ensembleWakeNow)

    expect(result.executed).toBe(false)
    expect(result.message).toContain('orchestrator unavailable')
    expect(log).toHaveBeenCalled()
  })
})

describe('MainProcessActionExecutor session and pin controls', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('updates YOLO mode through setYoloModeFn', async () => {
    const setYoloModeFn = vi.fn().mockResolvedValue({ enabled: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn, setYoloModeFn })
    const result = await executor.executeSetYoloMode(sample.setYoloMode)
    expect(setYoloModeFn).toHaveBeenCalledWith(true)
    expect(result).toMatchObject({
      executed: true,
      data: { enabled: true }
    })
  })

  it('reports setYoloModeFn failures without throwing', async () => {
    const setYoloModeFn = vi.fn().mockRejectedValue(new Error('session store unavailable'))
    const executor = new MainProcessActionExecutor({ cancelRunFn, setYoloModeFn })
    const result = await executor.executeSetYoloMode(sample.setYoloMode)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/session store unavailable/)
  })

  it('updates a thread goal through goalUpdateFn', async () => {
    const goalUpdateFn = vi.fn().mockResolvedValue({
      ok: true,
      goal: { id: 'goal-1', status: 'active' }
    })
    const executor = new MainProcessActionExecutor({ cancelRunFn, goalUpdateFn })
    const result = await executor.executeGoalUpdate(sample.goalUpdate)
    expect(goalUpdateFn).toHaveBeenCalledWith(sample.goalUpdate)
    expect(result).toMatchObject({
      executed: true,
      data: { threadId: 't-1', goal: { id: 'goal-1', status: 'active' } }
    })
  })

  it('surfaces goalUpdateFn decline reasons', async () => {
    const goalUpdateFn = vi.fn().mockResolvedValue({ ok: false, reason: 'thread missing' })
    const executor = new MainProcessActionExecutor({ cancelRunFn, goalUpdateFn })
    const result = await executor.executeGoalUpdate(sample.goalUpdate)
    expect(result.executed).toBe(false)
    expect(result.message).toBe('thread missing')
  })

  it('flips a proposed plan status through proposedPlanDecisionFn', async () => {
    const proposedPlanDecisionFn = vi.fn().mockResolvedValue({ ok: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn, proposedPlanDecisionFn })
    const result = await executor.executeProposedPlanDecision(sample.proposedPlanDecision)
    expect(proposedPlanDecisionFn).toHaveBeenCalledWith(sample.proposedPlanDecision)
    expect(result.executed).toBe(true)
  })

  it('surfaces proposedPlanDecisionFn errors', async () => {
    const proposedPlanDecisionFn = vi.fn().mockResolvedValue({ ok: false, error: 'Thread not found' })
    const executor = new MainProcessActionExecutor({ cancelRunFn, proposedPlanDecisionFn })
    const result = await executor.executeProposedPlanDecision(sample.proposedPlanDecision)
    expect(result.executed).toBe(false)
    // executeEnsembleAction wraps the fn's error string.
    expect(result.message).toContain('Thread not found')
  })

  it('runs a canvas close/reload through canvasActionFn', async () => {
    const canvasActionFn = vi.fn().mockResolvedValue({ ok: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn, canvasActionFn })
    const result = await executor.executeCanvasAction(sample.canvasAction)
    expect(canvasActionFn).toHaveBeenCalledWith(sample.canvasAction)
    expect(result.executed).toBe(true)
  })

  it('surfaces canvasActionFn errors', async () => {
    const canvasActionFn = vi.fn().mockResolvedValue({ ok: false, error: 'No open canvas' })
    const executor = new MainProcessActionExecutor({ cancelRunFn, canvasActionFn })
    const result = await executor.executeCanvasAction(sample.canvasAction)
    expect(result.executed).toBe(false)
    expect(result.message).toContain('No open canvas')
  })

  it('reports canvasAction not wired when no canvasActionFn is supplied', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeCanvasAction(sample.canvasAction)
    expect(result.executed).toBe(false)
  })

  it('updates a chat pin through togglePinChatFn', async () => {
    const togglePinChatFn = vi.fn().mockResolvedValue({ pinned: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn, togglePinChatFn })
    const result = await executor.executeTogglePinChat(sample.togglePinChat)
    expect(togglePinChatFn).toHaveBeenCalledWith(sample.togglePinChat)
    expect(result).toMatchObject({
      executed: true,
      data: { appChatId: 'chat-1', pinned: true }
    })
  })

  it('surfaces togglePinChatFn decline reasons', async () => {
    const togglePinChatFn = vi.fn().mockResolvedValue({ pinned: false, reason: 'chat missing' })
    const executor = new MainProcessActionExecutor({ cancelRunFn, togglePinChatFn })
    const result = await executor.executeTogglePinChat(sample.togglePinChat)
    expect(result.executed).toBe(false)
    expect(result.message).toBe('chat missing')
  })

  it('updates a workspace pin through togglePinWorkspaceFn', async () => {
    const togglePinWorkspaceFn = vi.fn().mockResolvedValue({ pinned: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn, togglePinWorkspaceFn })
    const result = await executor.executeTogglePinWorkspace(sample.togglePinWorkspace)
    expect(togglePinWorkspaceFn).toHaveBeenCalledWith(sample.togglePinWorkspace)
    expect(result).toMatchObject({
      executed: true,
      data: { workspaceId: 'ws-1', pinned: true }
    })
  })

  it('surfaces togglePinWorkspaceFn decline reasons', async () => {
    const togglePinWorkspaceFn = vi.fn().mockResolvedValue({
      pinned: false,
      reason: 'workspace missing'
    })
    const executor = new MainProcessActionExecutor({ cancelRunFn, togglePinWorkspaceFn })
    const result = await executor.executeTogglePinWorkspace(sample.togglePinWorkspace)
    expect(result.executed).toBe(false)
    expect(result.message).toBe('workspace missing')
  })
})

describe('MainProcessActionExecutor.executeApprovalReply', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('returns executed=false when no respondApprovalFn is configured', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeApprovalReply(sample.approvalReply)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/not yet wired/i)
  })

  it('dispatches the toolCallId + decision to respondApprovalFn', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    const result = await executor.executeApprovalReply(sample.approvalReply)
    expect(respondApprovalFn).toHaveBeenCalledTimes(1)
    expect(respondApprovalFn).toHaveBeenCalledWith('tc-99', 'accept')
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/tc-99/)
    expect(result.message).toMatch(/accept/)
    expect(result.data).toMatchObject({ toolCallId: 'tc-99', decision: 'accept' })
  })

  it('passes through all five decisions', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    for (const decision of [
      'accept',
      'acceptForSession',
      'acceptForWorkspace',
      'decline',
      'cancel'
    ] as const) {
      await executor.executeApprovalReply({ ...sample.approvalReply, decision })
    }
    expect(respondApprovalFn.mock.calls.map((c) => c[1])).toEqual([
      'accept',
      'acceptForSession',
      'acceptForWorkspace',
      'decline',
      'cancel'
    ])
  })

  it('reports executed=false when respondApprovalFn returns false', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(false)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    const result = await executor.executeApprovalReply(sample.approvalReply)
    expect(result.executed).toBe(false)
    expect(result.reasonCode).toBe('approvalAlreadyResolved')
    expect(result.message).toMatch(/no pending approval/i)
    expect(result.message).toMatch(/tc-99/)
  })

  it('reports executed=false when respondApprovalFn throws', async () => {
    const respondApprovalFn = vi.fn().mockRejectedValue(new Error('runtime gone'))
    const log = vi.fn()
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn, log })
    const result = await executor.executeApprovalReply(sample.approvalReply)
    expect(result.executed).toBe(false)
    expect(result.reasonCode).toBe('approvalDispatchFailed')
    expect(result.message).toMatch(/approval dispatch failed/i)
    expect(result.message).toMatch(/runtime gone/)
    expect(log).toHaveBeenCalled()
  })
})

describe('MainProcessActionExecutor.executeComposerPrompt', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('returns executed=false when no composerPromptFn is configured', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeComposerPrompt(sample.composerPrompt)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/not yet wired/i)
  })

  it('dispatches the full action payload to composerPromptFn', async () => {
    const composerPromptFn = vi.fn().mockResolvedValue({ dispatched: true, appRunId: 'run-xyz' })
    const executor = new MainProcessActionExecutor({ cancelRunFn, composerPromptFn })
    const result = await executor.executeComposerPrompt(sample.composerPrompt)
    expect(composerPromptFn).toHaveBeenCalledTimes(1)
    expect(composerPromptFn).toHaveBeenCalledWith(sample.composerPrompt)
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/dispatching on your mac/i)
    expect(result.data).toMatchObject({
      appRunId: 'run-xyz',
      workspaceId: 'ws-1',
      threadId: 't-1',
      provider: 'gemini'
    })
  })

  it('reports executed=false when composerPromptFn signals no dispatch', async () => {
    const composerPromptFn = vi.fn().mockResolvedValue({
      dispatched: false,
      appRunId: null,
      reason: 'Workspace id "ws-1" is not registered'
    })
    const executor = new MainProcessActionExecutor({ cancelRunFn, composerPromptFn })
    const result = await executor.executeComposerPrompt(sample.composerPrompt)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/could not be dispatched/i)
    expect(result.message).toMatch(/not registered/)
  })

  it('reports executed=false when composerPromptFn throws', async () => {
    const composerPromptFn = vi.fn().mockRejectedValue(new Error('preflight blew up'))
    const log = vi.fn()
    const executor = new MainProcessActionExecutor({ cancelRunFn, composerPromptFn, log })
    const result = await executor.executeComposerPrompt(sample.composerPrompt)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/composer prompt dispatch failed/i)
    expect(result.message).toMatch(/preflight blew up/)
    expect(log).toHaveBeenCalled()
  })

  it('treats dispatched=true with no appRunId as ACCEPTED (async dispatch)', async () => {
    // The dispatcher acks at acceptance and runs preflight/dispatch async
    // (provider startup can outlive the phone's ack window), so a null
    // appRunId is the NORMAL success shape — the run id reaches the phone
    // via the projection snapshot that follows dispatch.
    const composerPromptFn = vi.fn().mockResolvedValue({ dispatched: true, appRunId: null })
    const executor = new MainProcessActionExecutor({ cancelRunFn, composerPromptFn })
    const result = await executor.executeComposerPrompt(sample.composerPrompt)
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/dispatching on your mac/i)
    expect(result.data?.appRunId).toBeUndefined()
  })
})

describe('MainProcessActionExecutor.executeRegisterApnsToken', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('returns executed=false when no registerApnsTokenFn is configured', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeRegisterApnsToken(sample.registerApnsToken)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/not yet wired/i)
  })

  it('dispatches the action to registerApnsTokenFn', async () => {
    const registerApnsTokenFn = vi.fn().mockResolvedValue({ registered: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn, registerApnsTokenFn })
    const result = await executor.executeRegisterApnsToken(sample.registerApnsToken)
    expect(registerApnsTokenFn).toHaveBeenCalledTimes(1)
    expect(registerApnsTokenFn).toHaveBeenCalledWith(sample.registerApnsToken)
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/pair-1/)
    expect(result.message).toMatch(/production/)
    expect(result.data).toMatchObject({ pairID: 'pair-1', env: 'production' })
  })

  it('reports executed=false when registerApnsTokenFn declines', async () => {
    const registerApnsTokenFn = vi.fn().mockResolvedValue({
      registered: false,
      reason: 'invalid token shape'
    })
    const executor = new MainProcessActionExecutor({ cancelRunFn, registerApnsTokenFn })
    const result = await executor.executeRegisterApnsToken(sample.registerApnsToken)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/registration declined/i)
    expect(result.message).toMatch(/invalid token shape/)
  })

  it('reports executed=false when registerApnsTokenFn throws', async () => {
    const registerApnsTokenFn = vi.fn().mockRejectedValue(new Error('store offline'))
    const log = vi.fn()
    const executor = new MainProcessActionExecutor({ cancelRunFn, registerApnsTokenFn, log })
    const result = await executor.executeRegisterApnsToken(sample.registerApnsToken)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/registration failed/i)
    expect(result.message).toMatch(/store offline/)
    expect(log).toHaveBeenCalled()
  })

  it('respects sandbox vs production env', async () => {
    const registerApnsTokenFn = vi.fn().mockResolvedValue({ registered: true })
    const executor = new MainProcessActionExecutor({ cancelRunFn, registerApnsTokenFn })
    await executor.executeRegisterApnsToken({ ...sample.registerApnsToken, env: 'sandbox' })
    expect(registerApnsTokenFn.mock.calls[0][0].env).toBe('sandbox')
  })
})

describe('MainProcessActionExecutor.executeDiscoverTailnetHosts', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('returns executed=false when no discoverTailnetHostsFn is configured', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeDiscoverTailnetHosts(sample.discoverTailnetHosts)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/not yet wired/i)
  })

  it('returns the discovered hosts in ack data (read-only → executed=true)', async () => {
    const hosts = [
      { macIdentityPubKey: 'A', relayUrls: ['wss://a.ts.net'], hostPlatform: 'mac' },
      { macIdentityPubKey: 'B', relayUrls: ['wss://b.ts.net'] }
    ]
    const discoverTailnetHostsFn = vi.fn().mockResolvedValue({ ok: true, hosts })
    const executor = new MainProcessActionExecutor({ cancelRunFn, discoverTailnetHostsFn })
    const result = await executor.executeDiscoverTailnetHosts(sample.discoverTailnetHosts)
    expect(discoverTailnetHostsFn).toHaveBeenCalledTimes(1)
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/2 other TaskWraith hosts/)
    expect(result.data).toEqual({ hosts })
  })

  it('treats an empty tailnet as a successful enumeration', async () => {
    const discoverTailnetHostsFn = vi.fn().mockResolvedValue({ ok: true, hosts: [] })
    const executor = new MainProcessActionExecutor({ cancelRunFn, discoverTailnetHostsFn })
    const result = await executor.executeDiscoverTailnetHosts(sample.discoverTailnetHosts)
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/0 other TaskWraith hosts/)
    expect(result.data).toEqual({ hosts: [] })
  })

  it('reports executed=false with the reason when enumeration fails', async () => {
    const discoverTailnetHostsFn = vi.fn().mockResolvedValue({ ok: false, reason: 'no credential' })
    const executor = new MainProcessActionExecutor({ cancelRunFn, discoverTailnetHostsFn })
    const result = await executor.executeDiscoverTailnetHosts(sample.discoverTailnetHosts)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/no credential/)
  })

  it('reports executed=false when the discovery fn throws', async () => {
    const discoverTailnetHostsFn = vi.fn().mockRejectedValue(new Error('tailnet offline'))
    const log = vi.fn()
    const executor = new MainProcessActionExecutor({ cancelRunFn, discoverTailnetHostsFn, log })
    const result = await executor.executeDiscoverTailnetHosts(sample.discoverTailnetHosts)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/Discovery failed/)
    expect(result.message).toMatch(/tailnet offline/)
    expect(log).toHaveBeenCalled()
  })
})

describe('MainProcessActionExecutor.executeQuestionReply', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('returns executed=false when no respondApprovalFn is configured', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeQuestionReply(sample.questionReply)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/not yet wired/i)
  })

  it('dispatches the answer as userInput to respondApprovalFn', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    const result = await executor.executeQuestionReply(sample.questionReply)
    expect(respondApprovalFn).toHaveBeenCalledTimes(1)
    expect(respondApprovalFn).toHaveBeenCalledWith('q-1', 'accept', { userInput: 'yes' })
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/q-1/)
    expect(result.message).toMatch(/answered/i)
    expect(result.data).toMatchObject({ promptId: 'q-1', answerLength: 3 })
  })

  it('prefers respondQuestionFn when configured', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(true)
    const respondQuestionFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({
      cancelRunFn,
      respondApprovalFn,
      respondQuestionFn
    })
    const result = await executor.executeQuestionReply(sample.questionReply)
    expect(respondQuestionFn).toHaveBeenCalledWith(sample.questionReply, {
      kind: 'answer',
      answer: 'yes'
    })
    expect(respondApprovalFn).not.toHaveBeenCalled()
    expect(result.executed).toBe(true)
  })

  it('reports executed=false when respondApprovalFn returns false', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(false)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    const result = await executor.executeQuestionReply(sample.questionReply)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/no pending question/i)
  })

  it('reports executed=false when respondApprovalFn throws', async () => {
    const respondApprovalFn = vi.fn().mockRejectedValue(new Error('codex disconnected'))
    const log = vi.fn()
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn, log })
    const result = await executor.executeQuestionReply(sample.questionReply)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/question reply dispatch failed/i)
    expect(result.message).toMatch(/codex disconnected/)
    expect(log).toHaveBeenCalled()
  })

  it('passes through multi-line answers as-is (no truncation or escaping)', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    const multiline = 'first line\nsecond line\nthird "quoted" line'
    await executor.executeQuestionReply({ ...sample.questionReply, answer: multiline })
    expect(respondApprovalFn).toHaveBeenCalledWith('q-1', 'accept', { userInput: multiline })
  })
})

describe('MainProcessActionExecutor.executeQuestionReject', () => {
  const cancelRunFn = vi.fn().mockResolvedValue(true)

  it('returns executed=false when no respondApprovalFn is configured', async () => {
    const executor = new MainProcessActionExecutor({ cancelRunFn })
    const result = await executor.executeQuestionReject(sample.questionReject)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/not yet wired/i)
  })

  it('dispatches as decline (no userInput) to respondApprovalFn', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    const result = await executor.executeQuestionReject(sample.questionReject)
    expect(respondApprovalFn).toHaveBeenCalledTimes(1)
    expect(respondApprovalFn).toHaveBeenCalledWith('q-1', 'decline')
    expect(result.executed).toBe(true)
    expect(result.message).toMatch(/rejected/i)
    expect(result.data).toMatchObject({ promptId: 'q-1' })
  })

  it('prefers respondQuestionFn for rejects when configured', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(true)
    const respondQuestionFn = vi.fn().mockResolvedValue(true)
    const executor = new MainProcessActionExecutor({
      cancelRunFn,
      respondApprovalFn,
      respondQuestionFn
    })
    const result = await executor.executeQuestionReject({
      ...sample.questionReject,
      message: 'not enough context'
    })
    expect(respondQuestionFn).toHaveBeenCalledWith(
      { ...sample.questionReject, message: 'not enough context' },
      { kind: 'reject', reason: 'not enough context' }
    )
    expect(respondApprovalFn).not.toHaveBeenCalled()
    expect(result.executed).toBe(true)
  })

  it('reports executed=false when respondApprovalFn returns false', async () => {
    const respondApprovalFn = vi.fn().mockResolvedValue(false)
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn })
    const result = await executor.executeQuestionReject(sample.questionReject)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/no pending question/i)
  })

  it('reports executed=false when respondApprovalFn throws', async () => {
    const respondApprovalFn = vi.fn().mockRejectedValue(new Error('boom'))
    const log = vi.fn()
    const executor = new MainProcessActionExecutor({ cancelRunFn, respondApprovalFn, log })
    const result = await executor.executeQuestionReject(sample.questionReject)
    expect(result.executed).toBe(false)
    expect(result.message).toMatch(/question reject dispatch failed/i)
    expect(log).toHaveBeenCalled()
  })
})

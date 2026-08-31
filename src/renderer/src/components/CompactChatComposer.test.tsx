import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type { ChatRecord, WorkspaceRecord } from '../../../main/store/types'
import {
  CompactChatComposer,
  compactComposerSubmitMode,
  compactWorkspaceStatus
} from './CompactChatComposer'

const workspace = {
  id: 'workspace-1',
  path: '/repo/taskwraith',
  displayName: 'TaskWraith',
  branch: 'master'
} as WorkspaceRecord

const snapshot = {
  requestedPath: workspace.path,
  repoRoot: workspace.path,
  branch: 'master',
  detached: false,
  ahead: 6,
  behind: 2,
  files: [],
  counts: { changed: 269, staged: 0, unstaged: 269, untracked: 0 },
  clean: false,
  mergeState: null,
  conflicts: 0,
  lineStats: { additions: 1234, deletions: 17 }
} as GitRepositorySnapshot

describe('CompactChatComposer', () => {
  it('projects the generic workspace, branch, sync, and diff row', () => {
    expect(
      compactWorkspaceStatus({
        workspace,
        snapshot,
        diffStats: { filesChanged: 269, additions: 1234, deletions: 17 }
      })
    ).toEqual({
      workspaceName: 'TaskWraith',
      branchOrWorktree: 'master',
      isWorktree: false,
      ahead: 6,
      behind: 2,
      filesChanged: 269,
      additions: 1234,
      deletions: 17
    })
  })

  it('prefers the selected worktree label over the repository branch', () => {
    expect(
      compactWorkspaceStatus({
        workspace,
        snapshot,
        worktreeSelection: {
          baseWorkspacePath: workspace.path,
          effectiveWorkspacePath: '/repo/taskwraith-compact',
          label: 'compact-companion',
          source: 'composer'
        },
        diffStats: { filesChanged: 0, additions: 0, deletions: 0 }
      })
    ).toMatchObject({ branchOrWorktree: 'compact-companion', isWorktree: true })
  })

  it('uses steer only for a live steer-capable composer', () => {
    expect(
      compactComposerSubmitMode({
        running: true,
        canSteer: true,
        steerBusy: false,
        midRunInputBehavior: 'steer'
      })
    ).toBe('steer')
    expect(
      compactComposerSubmitMode({
        running: true,
        canSteer: true,
        steerBusy: false,
        midRunInputBehavior: 'queue'
      })
    ).toBe('run')
  })

  it('renders only the generic context row, attachment, textarea, and send control', () => {
    const html = renderToStaticMarkup(
      <CompactChatComposer
        prompt="ship it"
        currentComposerChatId="chat-1"
        currentChat={{ appChatId: 'chat-1' } as ChatRecord}
        currentWorkspace={workspace}
        isCurrentGlobalChat={false}
        primaryGitSnapshot={snapshot}
        workspaceDiffStats={{ filesChanged: 269, additions: 1234, deletions: 17 }}
        composerAreaRef={createRef<HTMLDivElement>()}
        setChatPromptDraft={vi.fn()}
        handlePickImages={vi.fn()}
        handleRun={vi.fn()}
        handleCancel={vi.fn()}
        handleAgentApprovalAction={vi.fn()}
        isCurrentChatRunning={false}
        isCurrentChatBusyForSteer={false}
        isSteerBusyForCurrentChat={false}
      />
    )

    expect(html).toContain('compact-chat-workspace-row')
    expect(html).toContain('269 files changed')
    expect(html).toContain('+1234')
    expect(html).toContain('-17')
    expect(html).toContain('aria-label="Attach context"')
    expect(html).toContain('<textarea')
    expect(html).toContain('aria-label="Send message"')
    expect(html).not.toContain('data-composer-style')
    expect(html).not.toContain('composer-inline-pickers')
  })

  it('replaces the run-scoped shell action with an exact command allowlist affordance', () => {
    const html = renderToStaticMarkup(
      <CompactChatComposer
        prompt=""
        currentComposerChatId="chat-1"
        currentChat={{ appChatId: 'chat-1' } as ChatRecord}
        currentWorkspace={workspace}
        isCurrentGlobalChat={false}
        primaryGitSnapshot={snapshot}
        workspaceDiffStats={{ filesChanged: 0, additions: 0, deletions: 0 }}
        composerAreaRef={createRef<HTMLDivElement>()}
        pendingAgentApproval={{
          id: 'approval-1',
          provider: 'codex',
          service: 'shellCommands',
          method: 'codex-mcp/run_shell_command',
          title: 'Approve Codex shell command',
          body: 'npm test',
          actions: ['accept', 'acceptForSession', 'acceptForWorkspace', 'decline'],
          preview: {
            exactCommandRuleOffer: {
              offerId: 'offer-1',
              kind: 'brokered_shell_exact_argv',
              fingerprint: 'a'.repeat(64),
              cwdRelativePath: '.',
              executableName: 'npm',
              riskClass: 'host_exact_unsandboxed',
              scope: 'one_workspace_exact_argv'
            }
          }
        }}
        setChatPromptDraft={vi.fn()}
        handlePickImages={vi.fn()}
        handleRun={vi.fn()}
        handleCancel={vi.fn()}
        handleAgentApprovalAction={vi.fn()}
        isCurrentChatRunning={false}
        isCurrentChatBusyForSteer={false}
        isSteerBusyForCurrentChat={false}
      />
    )

    expect(html).toContain('Allow once')
    expect(html).toContain('Add exact command to Allowlist')
    expect(html).toContain('Allow all shell commands in this workspace')
    expect(html).not.toContain('Allow all shell commands for this run')
  })
})

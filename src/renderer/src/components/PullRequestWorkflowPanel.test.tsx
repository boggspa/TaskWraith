import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitUnpushedCommit } from '../../../main/services/GitCommitStack'
import type { GitPrSummary } from '../../../main/services/GitService'
import { withTaskWraithCommitGroup } from '../../../shared/gitPullRequestGroups'
import {
  PullRequestWorkflowPanel,
  defaultPullRequestDraft,
  pullRequestsByOriginalCommit
} from './PullRequestWorkflowPanel'

const commits: GitUnpushedCommit[] = [
  {
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parents: ['1111111111111111111111111111111111111111'],
    subject: 'feat(inspector): add commit groups',
    author: {
      name: 'Chris Izatt',
      email: 'chris@example.test',
      authoredAt: '2026-08-12T01:00:00+01:00'
    },
    filesChanged: 3,
    additions: 37,
    deletions: 6
  },
  {
    hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    parents: ['2222222222222222222222222222222222222222'],
    subject: 'test(inspector): cover commit groups',
    author: {
      name: 'Chris Izatt',
      email: 'chris@example.test',
      authoredAt: '2026-08-12T00:50:00+01:00'
    },
    filesChanged: 1,
    additions: 18,
    deletions: 0
  }
]

describe('PullRequestWorkflowPanel', () => {
  it('builds a draft from selected commits with a dedicated Codex branch', () => {
    const draft = defaultPullRequestDraft(commits, 'master')

    expect(draft.title).toBe('feat(inspector): add commit groups (+1 commit)')
    expect(draft.branch).toBe('codex/feat-inspector-add-commit-groups-bbbbbbb')
    expect(draft.baseBranch).toBe('master')
    expect(draft.body).toContain('`bbbbbbbbb` test(inspector): cover commit groups')
    expect(draft.body.indexOf('bbbbbbbbb')).toBeLessThan(draft.body.indexOf('aaaaaaaaa'))
    expect(draft.draft).toBe(true)
  })

  it('indexes durable original-commit markers across pull requests', () => {
    const pr: GitPrSummary = {
      number: 42,
      title: 'Grouped work',
      body: withTaskWraithCommitGroup(
        'Visible body',
        commits.map((commit) => commit.hash)
      )
    }

    const grouped = pullRequestsByOriginalCommit([pr])

    expect(grouped.get(commits[0].hash)).toEqual([pr])
    expect(grouped.get(commits[1].hash)).toEqual([pr])
    expect(grouped.size).toBe(2)
  })

  it('renders the PR request editor and explains checkout isolation', () => {
    const html = renderToStaticMarkup(
      <PullRequestWorkflowPanel
        workspacePath="/repo"
        chatId="chat-1"
        selectedCommits={commits}
        requestOpen
        fallbackBaseBranch="master"
        onRequestOpenChange={vi.fn()}
      />
    )

    expect(html).toContain('New PR request')
    expect(html).toContain('2 selected commits')
    expect(html).toContain('codex/feat-inspector-add-commit-groups-bbbbbbb')
    expect(html).toContain('Create draft PR')
    expect(html).toContain('temporary worktree')
    expect(html).toContain('This checkout stays on its current branch.')
  })
})

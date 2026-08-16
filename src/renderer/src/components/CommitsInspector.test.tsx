import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, ChatMessage } from '../../../main/store/types'
import type { GitUnpushedCommitStack } from '../../../shared/gitUnpushedCommits'
import type { GitPrSummary } from '../../../main/services/GitService'
import type { SeatChangeLink } from '../../../shared/seatChange'
import { CommitsInspectorView, inspectorCommitRows } from './CommitsInspector'

const seatLink: SeatChangeLink = {
  participantId: 'seat-1',
  before: {
    provider: 'codex',
    model: 'gpt-5.6',
    role: 'Work1',
    seatNumber: 4
  },
  after: {
    provider: 'codex',
    model: 'gpt-5.6',
    role: 'Work1',
    seatNumber: 4
  }
}

function stack(commits: GitUnpushedCommitStack['commits']): GitUnpushedCommitStack {
  return {
    repoRoot: '/repo',
    branch: 'master',
    head: commits[0]?.hash,
    upstream: 'origin/master',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:example/repo.git',
    comparison: 'upstream',
    observedAt: '2026-08-12T00:00:00.000Z',
    commits
  }
}

const commits: GitUnpushedCommitStack['commits'] = [
  {
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parents: ['1111111111111111111111111111111111111111'],
    subject: 'TaskWraith-owned work',
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
    subject: 'Generic Git work',
    author: {
      name: 'Pat Developer',
      email: 'pat@example.test',
      authoredAt: '2026-08-11T20:00:00+01:00'
    },
    filesChanged: 4,
    additions: 753,
    deletions: 17
  }
]

function attributedChat(): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'chat-1',
    providerMetadata: {},
    messages: [
      {
        id: 'closeout',
        role: 'assistant',
        content: 'Task complete',
        timestamp: new Date().toISOString(),
        metadata: {
          closeoutCommits: [{ hash: commits[0].hash.slice(0, 9), seatLink }]
        }
      } as ChatMessage
    ]
  } as unknown as ChatRecord
}

describe('CommitsInspector', () => {
  it('reuses the Task Complete commit card and falls back to Git authors', () => {
    const snapshot = stack(commits)
    const rows = inspectorCommitRows(snapshot, [attributedChat()])
    const linkedPullRequest: GitPrSummary = {
      number: 42,
      title: 'Grouped work',
      url: 'https://github.com/example/repo/pull/42'
    }
    const html = renderToStaticMarkup(
      <CommitsInspectorView
        stack={snapshot}
        rows={rows}
        selectedHashes={new Set([commits[0].hash])}
        onToggleCommit={vi.fn()}
        onSelectAll={vi.fn()}
        onClearSelection={vi.fn()}
        onRefresh={vi.fn()}
        onStartPrRequest={vi.fn()}
        pullRequestsByCommit={new Map([[commits[0].hash, [linkedPullRequest]]])}
      />
    )

    expect(html).toContain('file-change-summary-card run-complete-epic-card')
    expect(html).toContain('run-complete-epic-row is-header is-commits has-commit-numbers')
    expect(html).toContain(
      '<span class="run-complete-epic-number" role="columnheader">#</span><span role="columnheader">Attribution</span>'
    )
    expect(html).toContain('aria-label="Commit 1">#1</span>')
    expect(html).toContain('aria-label="Commit 2">#2</span>')
    expect(html).toContain('Attribution')
    expect(html).toContain('seat-change-message is-inline')
    expect(html).toContain('Pat Developer')
    expect(html).toContain('Pat Developer &lt;pat@example.test&gt;')
    expect(html).toContain('3 files, <span class="composer-diff-add">+37</span>')
    expect(html).toContain('4 files, <span class="composer-diff-add">+753</span>')
    expect(html).toContain('<span class="composer-diff-del">−17</span>')
    expect(html).toContain('1 of 2 selected')
    expect(html).toContain('Create PR request')
    expect(html).toContain('>#42</button>')
    expect(html).toContain('Open Grouped work')
    expect(html).not.toMatch(/Create PR request[^>]*disabled/)
  })

  it('renders a truthful pushed state when the stack is empty', () => {
    const snapshot = stack([])
    const html = renderToStaticMarkup(
      <CommitsInspectorView
        stack={snapshot}
        rows={[]}
        selectedHashes={new Set()}
        onToggleCommit={vi.fn()}
        onSelectAll={vi.fn()}
        onClearSelection={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(html).toContain('Everything is pushed')
    expect(html).toContain('No commits on this checkout are ahead of origin/master.')
  })

  it('labels a partial newest-first page while older commits load', () => {
    const snapshot = stack(commits)
    const html = renderToStaticMarkup(
      <CommitsInspectorView
        stack={snapshot}
        rows={inspectorCommitRows(snapshot, [])}
        selectedHashes={new Set()}
        onToggleCommit={vi.fn()}
        onSelectAll={vi.fn()}
        onClearSelection={vi.fn()}
        onRefresh={vi.fn()}
        loadingMore
      />
    )

    expect(html).toContain('2+ commits · loading older…')
    expect(html).toContain('0 of 2 loaded selected')
    expect(html).toContain('Select loaded')
    expect(html).toContain('newest 2 ready')
  })
})

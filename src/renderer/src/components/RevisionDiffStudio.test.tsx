import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitUnpushedCommitStack } from '../../../main/services/GitCommitStack'
import type { GitPrSummary } from '../../../main/services/GitService'
import type { TaskWraithCommitAttribution } from '../lib/commitAttribution'
import {
  RevisionDiffSidebar,
  buildRevisionDiffCatalogue,
  gitRevisionTargetForSelection
} from './RevisionDiffStudio'

const firstHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const secondHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const stack: GitUnpushedCommitStack = {
  repoRoot: '/repo',
  branch: 'master',
  head: secondHash,
  upstream: 'origin/master',
  remoteName: 'origin',
  comparison: 'upstream',
  observedAt: '2026-08-16T00:00:00.000Z',
  commits: [
    {
      hash: secondHash,
      parents: [firstHash],
      subject: 'Generic Git work',
      author: { name: 'Pat Developer', email: 'pat@example.test' },
      filesChanged: 2,
      additions: 8,
      deletions: 3
    },
    {
      hash: firstHash,
      parents: ['1111111111111111111111111111111111111111'],
      subject: 'Seat-authored work',
      author: { name: 'Chris Izatt' },
      filesChanged: 1,
      additions: 5,
      deletions: 0
    }
  ]
}

const attribution: TaskWraithCommitAttribution = {
  hash: firstHash,
  participantId: 'seat-reviewer',
  seatLink: {
    participantId: 'seat-reviewer',
    before: { provider: 'codex', model: 'gpt-5.6', role: 'Reviewer' },
    after: { provider: 'codex', model: 'gpt-5.6', role: 'Reviewer' }
  }
}

const pullRequest: GitPrSummary = {
  number: 42,
  title: 'Grouped review',
  state: 'OPEN',
  headRefOid: 'cccccccccccccccccccccccccccccccccccccccc',
  baseRefName: 'master',
  body: `<!-- taskwraith-commit-group:v1 ${firstHash} -->`
}

describe('RevisionDiffStudio', () => {
  it('builds attributed commit and PR choices beside the working tree', () => {
    const catalogue = buildRevisionDiffCatalogue(
      stack,
      [pullRequest],
      new Map([[firstHash, attribution]])
    )
    const html = renderToStaticMarkup(
      <RevisionDiffSidebar
        catalogue={catalogue}
        selectedKey={`commit:${firstHash}`}
        onSelect={vi.fn()}
      />
    )

    expect(html).toContain('Working tree')
    expect(html).toContain('Pull requests')
    expect(html).toContain('#42')
    expect(html).toContain('Grouped review')
    expect(html).toContain('Commits')
    expect(html).toContain('Seat-authored work')
    expect(html).toContain('Reviewer')
    expect(html).toContain('Pat Developer')
    expect(html).toContain('is-selected')
    expect(catalogue.pullRequests[0].attributions).toEqual([attribution])
  })

  it('maps commit and PR choices onto the bounded historical diff contract', () => {
    const catalogue = buildRevisionDiffCatalogue(
      stack,
      [pullRequest],
      new Map([[firstHash, attribution]])
    )

    expect(gitRevisionTargetForSelection(catalogue.commits[0], 'origin')).toEqual({
      kind: 'commit',
      commitHash: secondHash
    })
    expect(gitRevisionTargetForSelection(catalogue.pullRequests[0], 'origin')).toEqual({
      kind: 'pull-request',
      headHash: pullRequest.headRefOid,
      baseRefName: 'master',
      remoteName: 'origin'
    })
    expect(gitRevisionTargetForSelection(catalogue.workingTree, 'origin')).toBeNull()
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT,
  CloseoutFileChangesSection,
  closeoutFileChangeWindow
} from './CloseoutFileChangesSection'
import {
  buildCloseoutCommitWindow,
  CLOSEOUT_COMMIT_PAGE_SIZE,
  CLOSEOUT_COMMIT_TABLE_LIMIT
} from '../lib/taskWraithCloseoutMessage'
import { RunCompleteEpicStack } from './RunCompleteEpicStack'

function fileChangeRows(count: number): {
  path: string
  status: 'modified'
  additions: number
  deletions: number
}[] {
  return Array.from({ length: count }, (_, index) => ({
    // Zero-padded so `src/file-01.ts` is never a substring of `src/file-11.ts`
    // and the "row N is hidden" assertions below can't pass vacuously.
    path: `src/file-${String(index + 1).padStart(2, '0')}.ts`,
    status: 'modified' as const,
    additions: 1,
    deletions: 1
  }))
}

function closingDivIndex(html: string, attributeIndex: number): number {
  const opening = html.lastIndexOf('<div', attributeIndex)
  const tags = /<\/?div\b[^>]*>/g
  tags.lastIndex = opening
  let depth = 0
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[0].startsWith('</')) depth -= 1
    else depth += 1
    if (depth === 0) return match.index + match[0].length
  }
  return -1
}

describe('RunCompleteEpicStack', () => {
  it('stacks participants, file changes, and commits with seat attribution', () => {
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        participantTable={{
          totalWorkLabel: '2k Tks / 2 Turns',
          rows: [
            {
              participantId: 'p1',
              seatText: '@SparkDocs · Codex · GPT-5.3 Codex Spark',
              workLabel: '202k Tks / 1 Turn',
              status: 'answered',
              statusGlyphMarkdown: '[Answered](ensemble-status://answered)',
              seatLink: {
                participantId: 'p1',
                before: {
                  provider: 'codex',
                  model: 'gpt-5.3-codex-spark',
                  role: 'SparkDocs',
                  seatNumber: 2,
                  permissionPresetId: 'workspace_write'
                },
                after: {
                  provider: 'codex',
                  model: 'gpt-5.3-codex-spark',
                  role: 'SparkDocs',
                  seatNumber: 2,
                  permissionPresetId: 'workspace_write'
                }
              }
            }
          ]
        }}
        fileChanges={<div className="file-change-summary-card">File changes</div>}
        commits={[
          {
            hash: '18003ca96abcdef',
            subject: 'Add TaskWraith transcript closeouts',
            stats: '21 files',
            participantId: 'p1',
            seatLink: {
              participantId: 'p1',
              before: {
                provider: 'codex',
                model: 'gpt-5.3-codex-spark',
                role: 'SparkDocs',
                seatNumber: 2
              },
              after: {
                provider: 'codex',
                model: 'gpt-5.3-codex-spark',
                role: 'SparkDocs',
                seatNumber: 2
              }
            }
          }
        ]}
      />
    )

    expect(html).toContain('run-complete-epic-stack')
    expect(html).toContain('Participants')
    expect(html).toContain('File changes')
    expect(html).toContain('Commits')
    expect(html).toContain('seat-change-message is-inline')
    expect(html).toContain('ensemble-above-chip-status status-answered closeout-status-glyph')
    expect(html).toContain('18003ca96')
    expect(html).toContain('Add TaskWraith transcript closeouts')
    expect(html).toContain('Round Total')
    expect(html).not.toContain('run-complete-epic-status')
  })

  it('renders Sub-threads with agent identity and route status', () => {
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        subagentDelegations={[
          {
            subThreadId: 'child-a',
            identitySeed: 'child-a',
            title: 'Worker A',
            provider: 'codex',
            parentProvider: 'claude',
            status: 'returned'
          },
          {
            subThreadId: 'child-b',
            identitySeed: 'child-b',
            title: 'Worker B',
            provider: 'claude',
            status: 'created'
          }
        ]}
      />
    )
    expect(html).toContain('aria-label="Sub-threads"')
    expect(html).toContain('Sub-threads')
    expect(html).toContain('2 sub-threads')
    expect(html).toContain('Worker A')
    expect(html).toContain('Claude → Codex')
    expect(html).toContain('status-answered')
    expect(html).toContain('Returned')
    expect(html).toContain('aria-label="Returned"')
    expect(html).not.toContain('aria-label="answered"')
    expect(html).toContain('run-complete-epic-subagent')
  })

  it('collapses sub-threads to a reachable window instead of a dead overflow note', () => {
    // Was: "2 more sub-threads not shown." — a line that told the reader
    // evidence existed and then refused to show it. The File changes card in
    // this same stack has always been expandable; this one now matches.
    const rows = Array.from({ length: 10 }, (_, index) => ({
      subThreadId: `child-${index}`,
      identitySeed: `child-${index}`,
      title: `Worker ${index + 1}`,
      provider: 'codex' as const,
      status: 'created' as const
    }))
    const html = renderToStaticMarkup(<RunCompleteEpicStack subagentDelegations={rows} />)
    expect(html).toContain('Worker 1')
    expect(html).toContain('Worker 8')
    expect(html).not.toContain('Worker 9')
    expect(html).not.toContain('not shown.')
    expect(html).toContain('Show 2 more sub-threads')
    expect(html).toContain('run-complete-epic-subagent-more')
    expect(html).toContain('aria-expanded="false"')
  })

  it('renders every sub-thread when the host opts out of the window', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      subThreadId: `child-${index}`,
      identitySeed: `child-${index}`,
      title: `Worker ${index + 1}`,
      provider: 'codex' as const,
      status: 'created' as const
    }))
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack subagentDelegations={rows} subagentRowLimit={null} />
    )
    expect(html).toContain('Worker 10')
    expect(html).not.toContain('Show 2 more sub-threads')
  })

  it('gives each sub-thread row an invocation hover affordance', () => {
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        subagentDelegations={[
          {
            subThreadId: 'child-a',
            identitySeed: 'child-a',
            title: 'Worker A',
            provider: 'codex',
            parentProvider: 'claude',
            status: 'returned',
            promptPreview: 'Audit the CSS for the market map'
          }
        ]}
      />
    )
    // The row is focusable and describes itself by the shared hover tooltip,
    // the same contract the commit-files pill row uses.
    expect(html).toContain('has-subagent-invocation')
    expect(html).toContain('tabindex="0"')
  })

  it('collapses commits to a reachable window instead of a dead overflow note', () => {
    // Was: "2 more commits not shown." — the same dead line the Sub-threads
    // card shed. Both now match the File changes card beside them.
    const commits = Array.from({ length: 10 }, (_, index) => ({
      hash: `${(index + 1).toString(16).padStart(9, '0')}abcdef`,
      subject: `Commit ${index + 1}`,
      stats: '1 file'
    }))
    const html = renderToStaticMarkup(<RunCompleteEpicStack commits={commits} />)
    expect(html).toContain('Commit 1')
    expect(html).toContain('Commit 8')
    expect(html).not.toContain('Commit 9')
    expect(html).not.toContain('not shown.')
    expect(html).toContain('Show 2 more commits')
    expect(html).toContain('run-complete-epic-commit-more')
    expect(html).toContain('aria-expanded="false"')
    // The window is a view, not a filter: the header keeps counting the whole
    // close-out, so the number does not shift as the reader expands.
    expect(html).toContain('10 commits')
  })

  it('renders no commit expander when the close-out fits the cap', () => {
    const commits = Array.from({ length: CLOSEOUT_COMMIT_TABLE_LIMIT }, (_, index) => ({
      hash: `${(index + 1).toString(16).padStart(9, '0')}abcdef`,
      subject: `Commit ${index + 1}`,
      stats: '1 file'
    }))
    const html = renderToStaticMarkup(<RunCompleteEpicStack commits={commits} />)
    expect(html).toContain('Commit 8')
    expect(html).not.toContain('run-complete-epic-commit-more')
  })

  it('opens the whole commit list once the window is expanded', () => {
    // No DOM test environment here, so the expander's two states are proven on
    // the pure window helper the component renders from rather than by click.
    const commits = Array.from({ length: 30 }, (_, index) => `commit-${index + 1}`)

    const collapsed = buildCloseoutCommitWindow(commits)
    expect(collapsed.items).toHaveLength(CLOSEOUT_COMMIT_TABLE_LIMIT)
    expect(collapsed.canShowMore).toBe(true)
    expect(collapsed.canShowFewer).toBe(false)
    expect(collapsed.nextShowCount).toBe(CLOSEOUT_COMMIT_PAGE_SIZE)

    const opened = buildCloseoutCommitWindow(commits, collapsed.nextCount)
    expect(opened.items).toHaveLength(CLOSEOUT_COMMIT_TABLE_LIMIT + CLOSEOUT_COMMIT_PAGE_SIZE)
    expect(opened.canShowFewer).toBe(true)

    // No ceiling: pressing on always reaches the last commit.
    const full = buildCloseoutCommitWindow(commits, opened.nextCount)
    expect(full.items).toHaveLength(30)
    expect(full.canShowMore).toBe(false)
    expect(full.hiddenCount).toBe(0)
  })

  it('renders the complete selectable stack with generic author attribution', () => {
    const commits = Array.from({ length: 10 }, (_, index) => ({
      hash: `${(index + 1).toString(16).padStart(40, '0')}`,
      subject: `Commit ${index + 1}`,
      stats: '1 file, +1'
    }))
    const selectedHashes = new Set([commits[0].hash])
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        commits={commits}
        commitRowLimit={null}
        commitAttributionLabel="Attribution"
        commitAttributionFallback={() => ({
          text: 'Chris Izatt',
          title: 'Chris Izatt <chris@example.test>'
        })}
        commitNumbering
        commitSelection={{ selectedHashes, onToggle: () => {} }}
        commitHashAdornment={(commit) => <span>PR for {commit.hash.slice(0, 9)}</span>}
      />
    )

    expect(html).toContain('Attribution')
    expect(html).toContain('has-commit-numbers')
    expect(html).toContain('aria-label="Commit 1">#1</span>')
    expect(html).toContain('aria-label="Commit 10">#10</span>')
    expect(html).toContain('Chris Izatt')
    expect(html).toContain('Chris Izatt &lt;chris@example.test&gt;')
    expect(html).toContain('aria-selected="true"')
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/)
    expect(html).toContain('Commit 10')
    expect(html).toContain('PR for 000000000')
    expect(html).not.toContain('more commits not shown')
    // The inspector opts out of the window entirely, so no expander appears.
    expect(html).not.toContain('run-complete-epic-commit-more')
  })

  it('orders commit columns as Seat, Changes, Message, Hash and colors diff counts', () => {
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        commits={[
          {
            hash: '83bbc32c8abcdef',
            subject: 'fix(ios): resolve iPad transcript',
            stats: '3 files, +197 −42'
          }
        ]}
      />
    )
    const headerStart = html.indexOf('class="run-complete-epic-row is-header is-commits"')
    const rowStart = html.indexOf('class="run-complete-epic-row is-commits"', headerStart + 1)
    const headerHtml = html.slice(headerStart, rowStart)
    const rowHtml = html.slice(rowStart)

    expect(headerHtml).toContain(
      '<span role="columnheader">Seat</span><span role="columnheader">Changes</span><span role="columnheader">Message</span><span role="columnheader">Hash</span>'
    )
    expect(rowHtml.indexOf('run-complete-epic-seat')).toBeLessThan(
      rowHtml.indexOf('run-complete-epic-stats')
    )
    expect(rowHtml.indexOf('run-complete-epic-stats')).toBeLessThan(
      rowHtml.indexOf('run-complete-epic-subject')
    )
    expect(rowHtml.indexOf('run-complete-epic-subject')).toBeLessThan(
      rowHtml.indexOf('run-complete-epic-hash')
    )
    expect(rowHtml).toContain('<span class="composer-diff-add">+197</span>')
    expect(rowHtml).toContain('<span class="composer-diff-del">−42</span>')
  })

  it('renders compact closeout file changes without workbench interactions', () => {
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        fileChanges={
          <CloseoutFileChangesSection
            changes={[
              {
                path: 'src/example.ts',
                status: 'modified',
                additions: 4,
                deletions: 2
              }
            ]}
          />
        }
      />
    )
    expect(html).toContain('run-complete-epic-stack')
    expect(html).toContain('File changes')
    expect(html).toContain('src/example.ts')
    expect(html).toContain('edited')
    expect(html).toContain('+4')
    expect(html).toContain('-2')
    expect(html).not.toContain('file-change-summary-item-interactive')
    expect(html).not.toContain('Open Workbench')
  })

  it('restores sticky row previews without adding a separate Diff mini-pill', () => {
    const html = renderToStaticMarkup(
      <CloseoutFileChangesSection
        changes={[{ path: 'src/example.ts', status: 'modified', additions: 4, deletions: 2 }]}
        getMainActionLabel={(summary) => `Open Workbench diff for ${summary.path}`}
        onActivateChange={() => {}}
        onOpenPreview={() => {}}
        onScheduleClosePreview={() => {}}
        previewPath="src/example.ts"
      />
    )

    expect(html).toContain('file-change-summary-item-interactive has-diff-preview')
    expect(html).not.toContain('file-change-summary-diff-bubble')
    expect(html).toContain('aria-describedby="diff-hover-preview-tooltip"')
    expect(html).toContain('Open Workbench diff for src/example.ts')
  })

  it('marks commit rows with file data as keyboard-accessible hover anchors', () => {
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        commits={[
          {
            hash: '83bbc32c8abcdef',
            subject: 'Bound commit file previews',
            stats: '42 files, +903 −211',
            files: Array.from({ length: 42 }, (_, index) => ({
              path: `src/file-${index + 1}.ts`,
              additions: index + 1,
              deletions: index
            }))
          }
        ]}
      />
    )

    expect(html).toContain('is-commits has-commit-files')
    expect(html).toContain('tabindex="0"')
  })

  it('arms historical commit rows for lazy file lookup when tombstones have no file list', () => {
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack
        commits={[
          {
            hash: '83bbc32c8abcdef',
            subject: 'Historical commit',
            stats: '2 files, +14 −3'
          }
        ]}
        loadCommitFiles={async () => ({
          files: [
            { path: 'src/example.ts', additions: 10, deletions: 2 },
            { path: 'src/example.test.ts', additions: 4, deletions: 1 }
          ],
          totalFiles: 2
        })}
      />
    )

    expect(html).toContain('is-commits has-commit-files')
    expect(html).toContain('tabindex="0"')
  })

  it('keeps explicit loading and reload states beside the async commit preview path', () => {
    const source = RunCompleteEpicStack.toString()

    expect(source).toContain('COMMIT_FILES_LOADING_MESSAGE')
    expect(source).toContain('COMMIT_FILES_UNAVAILABLE_MESSAGE')
    expect(source).toContain('status: "loading"')
    expect(source).toContain('status: "unavailable"')
  })

  it('marks closeout file-change rows as ownerless so the stats keep the last column', () => {
    const html = renderToStaticMarkup(
      <CloseoutFileChangesSection
        changes={[
          { path: 'src/example.ts', status: 'modified', additions: 4, deletions: 2 },
          { path: 'src/other.ts', status: 'created', additions: 12, deletions: 0 }
        ]}
      />
    )
    // The live footer row has five cells (status, icon, path, owner, stats);
    // the close-out row omits the owner, so without this modifier the stats
    // land in the owner column and the grid's fifth track becomes a phantom
    // ~132px of dead space between them and the card's right edge.
    expect(html).not.toContain('file-change-summary-owner')
    const rowCount = html.split('file-change-summary-row-content is-closeout').length - 1
    expect(rowCount).toBe(2)
  })

  it('caps the close-out file list at ten rows and offers a "Show more" toggle', () => {
    const html = renderToStaticMarkup(<CloseoutFileChangesSection changes={fileChangeRows(13)} />)

    const rowCount = html.split('file-change-summary-row-content is-closeout').length - 1
    expect(rowCount).toBe(CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT)
    expect(html).toContain('src/file-10.ts')
    expect(html).not.toContain('src/file-11.ts')
    expect(html).not.toContain('src/file-13.ts')
    expect(html).toContain('file-change-summary-show-more')
    expect(html).toContain('Show 3 more…')
    expect(html).toContain('aria-expanded="false"')
    // The cap is a view window, not a filter: the header keeps counting and
    // summing every change, so the totals still describe the whole close-out.
    expect(html).toContain('13 files')
    expect(html).toContain('+13')
    expect(html).toContain('-13')
  })

  it('renders no "Show more" row when the close-out file list fits the cap', () => {
    const html = renderToStaticMarkup(
      <CloseoutFileChangesSection changes={fileChangeRows(CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT)} />
    )

    const rowCount = html.split('file-change-summary-row-content is-closeout').length - 1
    expect(rowCount).toBe(CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT)
    expect(html).toContain('src/file-10.ts')
    expect(html).not.toContain('file-change-summary-show-more')
  })

  it('opens the whole close-out file list once the window is expanded', () => {
    // No DOM test environment here, so the toggle's two states are proven on
    // the pure window helper the component renders from rather than by click.
    const changes = fileChangeRows(13)

    const collapsed = closeoutFileChangeWindow(changes, false)
    expect(collapsed.visible).toHaveLength(CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT)
    expect(collapsed.hiddenCount).toBe(3)

    const expanded = closeoutFileChangeWindow(changes, true)
    expect(expanded.visible).toHaveLength(13)
    expect(expanded.hiddenCount).toBe(3)

    const short = closeoutFileChangeWindow(changes.slice(0, 4), false)
    expect(short.visible).toHaveLength(4)
    expect(short.hiddenCount).toBe(0)
  })

  it('keeps Task Complete pagers outside their ARIA tables', () => {
    const subagents = Array.from({ length: 10 }, (_, index) => ({
      subThreadId: `child-${index}`,
      provider: 'codex' as const,
      status: 'created' as const
    }))
    const commits = Array.from({ length: 10 }, (_, index) => ({
      hash: `${(index + 1).toString(16).padStart(9, '0')}abcdef`,
      subject: `Commit ${index + 1}`,
      stats: '1 file'
    }))
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack subagentDelegations={subagents} commits={commits} />
    )

    const subagentTableStart = html.search(
      /<div[^>]*role="table"[^>]*aria-label="Sub-threads"[^>]*>/
    )
    const subagentTableEnd = closingDivIndex(html, subagentTableStart)
    const subagentPager = html.indexOf('run-complete-epic-subagent-more')
    expect(subagentTableStart).toBeGreaterThan(-1)
    expect(subagentPager).toBeGreaterThan(subagentTableEnd)

    const commitTableStart = html.search(/<div[^>]*role="table"[^>]*aria-label="Commits"[^>]*>/)
    const commitTableEnd = closingDivIndex(html, commitTableStart)
    const commitPager = html.indexOf('run-complete-epic-commit-more')
    expect(commitTableStart).toBeGreaterThan(-1)
    expect(commitPager).toBeGreaterThan(commitTableEnd)
  })
})

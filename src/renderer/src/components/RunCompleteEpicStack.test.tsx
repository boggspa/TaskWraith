import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CloseoutFileChangesSection } from './CloseoutFileChangesSection'
import { RunCompleteEpicStack } from './RunCompleteEpicStack'

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
    expect(html).toContain('run-complete-epic-subagent')
  })

  it('caps visible sub-threads and notes the overflow', () => {
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
    expect(html).toContain('2 more sub-threads not shown.')
  })

  it('caps visible commits and notes the overflow', () => {
    const commits = Array.from({ length: 10 }, (_, index) => ({
      hash: `${(index + 1).toString(16).padStart(9, '0')}abcdef`,
      subject: `Commit ${index + 1}`,
      stats: '1 file'
    }))
    const html = renderToStaticMarkup(<RunCompleteEpicStack commits={commits} />)
    expect(html).toContain('Commit 1')
    expect(html).toContain('Commit 8')
    expect(html).not.toContain('Commit 9')
    expect(html).toContain('2 more commits not shown.')
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
})

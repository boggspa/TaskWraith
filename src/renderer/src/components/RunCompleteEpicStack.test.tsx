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

  it('caps visible commits and notes the overflow', () => {
    const commits = Array.from({ length: 10 }, (_, index) => ({
      hash: `${(index + 1).toString(16).padStart(9, '0')}abcdef`,
      subject: `Commit ${index + 1}`,
      stats: '1 file'
    }))
    const html = renderToStaticMarkup(
      <RunCompleteEpicStack commits={commits} />
    )
    expect(html).toContain('Commit 1')
    expect(html).toContain('Commit 8')
    expect(html).not.toContain('Commit 9')
    expect(html).toContain('2 more commits not shown.')
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
})

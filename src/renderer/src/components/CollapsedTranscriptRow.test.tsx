import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import { CollapsedActivityStackRow, CollapsedTranscriptRow } from './CollapsedTranscriptRow'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/03-composer-welcome-activity.css'),
  'utf8'
)

const edit = (path: string, additions: number, deletions: number): ToolActivity => ({
  id: `edit-${path}-${additions}-${deletions}`,
  toolName: 'edit',
  displayName: 'Edit',
  category: 'write',
  status: 'success',
  filePath: path,
  diffSummary: {
    additions,
    deletions,
    confidence: 'exact',
    source: 'git_numstat',
    files: [{ path, status: 'modified', additions, deletions }]
  }
})

const ACTIVITIES: ToolActivity[] = [
  {
    id: 'think-1',
    toolName: 'thinking',
    displayName: 'Thinking',
    category: 'unknown',
    status: 'success',
    durationMs: 12_000
  },
  edit('/repo/a.ts', 40, 11),
  edit('/repo/b.ts', 2, 7)
]

/** Strip tags so assertions read the line the way a human does. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

describe('CollapsedActivityStackRow diff totals', () => {
  it('scopes the summary and expanded children to the resolved provider brand hue', () => {
    const html = renderToStaticMarkup(
      <CollapsedActivityStackRow
        header={null}
        activities={ACTIVITIES}
        providerHueClass="deepseek"
        expanded
        onToggle={() => {}}
      >
        <div className="expanded-provider-child" />
      </CollapsedActivityStackRow>
    )

    expect(html).toContain('--accent:var(--provider-deepseek-color, var(--accent))')
    expect(html).toContain('expanded-provider-child')
  })

  it('paints the summed +N -N at the end of the one-liner', () => {
    const html = renderToStaticMarkup(
      <CollapsedActivityStackRow
        header={null}
        activities={ACTIVITIES}
        showDiffStats
        expanded={false}
        onToggle={() => {}}
      />
    )
    const text = visibleText(html)
    expect(text).toContain('Thought for 12s · Edited 2 files')
    // Success verbs are highlighted like the child-row file target accent.
    expect(html).toContain('class="activity-summary-verb collapsed-activity-stack-verb">Thought</span>')
    expect(html).toContain('class="activity-summary-verb collapsed-activity-stack-verb">Edited</span>')
    // 40 + 2 added, 11 + 7 removed — the two folded edits summed, not the
    // last one winning and not a per-file list.
    expect(text).toContain('+42')
    expect(text).toContain('-18')
    // Totals trail the summary label rather than interrupting it.
    expect(html.indexOf('collapsed-activity-stack-diff')).toBeGreaterThan(
      html.indexOf('activity-summary-verb collapsed-activity-stack-verb">Edited')
    )
    expect(html).toContain('collapsed-activity-stack-diff-stat is-add')
    expect(html).toContain('collapsed-activity-stack-diff-stat is-del')
    // The row is one button, so the counters ride its accessible name.
    expect(html).toContain('42 lines added, 18 lines removed')
  })

  it('keeps the counters when the row is expanded back open', () => {
    const html = renderToStaticMarkup(
      <CollapsedActivityStackRow
        header={null}
        activities={ACTIVITIES}
        showDiffStats
        expanded
        onToggle={() => {}}
      >
        <div className="expanded-body" />
      </CollapsedActivityStackRow>
    )
    expect(visibleText(html)).toContain('+42')
    expect(html).toContain('expanded-body')
  })

  it('brings the numbers across the fold but not the diff-preview popout', () => {
    const html = renderToStaticMarkup(
      <CollapsedActivityStackRow
        header={null}
        activities={ACTIVITIES}
        showDiffStats
        expanded={false}
        onToggle={() => {}}
      />
    )
    expect(html).not.toContain('activity-diff-preview-bubble')
    expect(html).not.toContain('activity-file-change-card')
  })

  it('stays bare for fan-out lane and sub-agent summaries, which do not opt in', () => {
    const html = renderToStaticMarkup(
      <CollapsedActivityStackRow
        header={null}
        activities={ACTIVITIES}
        expanded={false}
        onToggle={() => {}}
      />
    )
    expect(visibleText(html)).toContain('Edited 2 files')
    expect(html).not.toContain('collapsed-activity-stack-diff')
    expect(visibleText(html)).not.toContain('+42')
  })

  it('omits the counters entirely when nothing folded away carried a diff', () => {
    const html = renderToStaticMarkup(
      <CollapsedActivityStackRow
        header={null}
        activities={[
          {
            id: 'read-1',
            toolName: 'read_file',
            displayName: 'Read',
            category: 'read',
            status: 'success',
            filePath: '/repo/a.ts'
          }
        ]}
        showDiffStats
        expanded={false}
        onToggle={() => {}}
      />
    )
    expect(html).not.toContain('collapsed-activity-stack-diff')
  })
})

describe('collapsed one-liner diff accents', () => {
  it('inks the counters with the user-set Settings → Appearance diff colors', () => {
    const block = (selector: string): string => {
      const start = css.indexOf(selector)
      if (start < 0) return ''
      const open = css.indexOf('{', start)
      return css.slice(start, css.indexOf('}', open) + 1)
    }
    expect(block('.collapsed-activity-stack-diff-stat.is-add {')).toContain(
      'var(--diff-stat-add-color, #2db777)'
    )
    expect(block('.collapsed-activity-stack-diff-stat.is-del {')).toContain(
      'var(--diff-stat-del-color, #ec3d35)'
    )
    // Sits with the label, not parked in a far-right stat column, and never
    // squeezed out by a long summary.
    const wrapper = block('.collapsed-activity-stack-diff {')
    expect(wrapper).not.toContain('margin-left: auto')
    expect(wrapper).toContain('flex-shrink: 0')
  })
})

describe('CollapsedTranscriptRow metaLabel verb accent', () => {
  it('accents only System — Fan-Out and other metas stay muted', () => {
    const system = renderToStaticMarkup(
      <CollapsedTranscriptRow
        header={null}
        metaLabel="System"
        label="notice text"
        expanded={false}
        onToggle={() => {}}
        ariaTargetLabel="system notice"
      />
    )
    expect(system).toContain(
      'class="collapsed-activity-stack-meta activity-summary-verb">System</span>'
    )

    const fanout = renderToStaticMarkup(
      <CollapsedTranscriptRow
        header={null}
        metaLabel="Fan-Out"
        label="2 lanes"
        expanded={false}
        onToggle={() => {}}
        ariaTargetLabel="fan-out summary"
      />
    )
    expect(fanout).toContain('class="collapsed-activity-stack-meta">Fan-Out</span>')
    expect(fanout).not.toContain('activity-summary-verb">Fan-Out')
  })
})

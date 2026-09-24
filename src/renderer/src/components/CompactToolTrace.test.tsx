import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CompactToolTrace, FoldoutSectionRow } from './CompactToolTrace'
import {
  buildFoldoutSections,
  buildResultPreview,
  extractToolFilePath,
  extractToolUrlTargets,
  friendlyGlobalToolLabel,
  splitCompactToolLabel
} from './CompactToolTrace.lib'
import type { ToolActivity } from '../../../main/store/types'

function makeActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'write_file',
    displayName: 'write_file',
    category: 'write',
    status: 'success',
    startedAt: '2026-05-26T17:00:00Z',
    endedAt: '2026-05-26T17:00:00.250Z',
    durationMs: 250,
    parameters: { file_path: '/repo/src/foo.ts', content: 'hello' },
    resultSummary: 'wrote 1 line',
    ...overrides
  }
}

describe('CompactToolTrace', () => {
  it('renders a one-line trace with toolName, status, duration, and preview', () => {
    const html = renderToStaticMarkup(<CompactToolTrace activity={makeActivity()} />)
    expect(html).toContain('compact-tool-trace')
    // The verb stays in the name span; the file path renders as a distinct
    // clickable, openable target rather than inline plain text.
    expect(html).toContain('>Wrote</span>')
    expect(html).toContain('transcript-file-target compact-tool-trace-path')
    expect(html).toContain('>/repo/src/foo.ts</button>')
    expect(html).toContain('ok')
    expect(html).toContain('250ms')
    expect(html).toContain('wrote 1 line')
  })

  it('keeps the same per-call diff odometer as a full-density ActivityRow', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace
        activity={makeActivity({
          toolName: 'replace',
          parameters: {
            file_path: '/repo/src/foo.ts',
            old_string: 'before',
            new_string: 'after\nand another line'
          }
        })}
      />
    )

    expect(html).toContain('compact-tool-trace-diff-stats')
    expect(html).toContain('activity-line-stat activity-line-stat-add')
    expect(html).toContain('activity-line-stat activity-line-stat-delete')
    expect(html).toMatch(/aria-label="\+2"|sr-only">\+2</)
    expect(html).toMatch(/aria-label="-1"|sr-only">-1</)
  })

  it('starts collapsed with no foldout markup in the DOM', () => {
    const html = renderToStaticMarkup(<CompactToolTrace activity={makeActivity()} />)
    expect(html).not.toContain('compact-tool-trace-foldout')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-expanded="false"')
  })

  it('renders provider attribution from activity.metadata.provider when present', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ metadata: { provider: 'codex' } })} />
    )
    expect(html).toContain('provider-codex')
    expect(html).toContain('Codex')
  })

  it('renders Cursor as a live provider label', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ metadata: { provider: 'cursor' } })} />
    )
    expect(html).toContain('provider-cursor')
    expect(html).toContain('Cursor')
  })

  it('renders Ollama as a first-class provider label', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ metadata: { provider: 'ollama' } })} />
    )
    expect(html).toContain('provider-ollama')
    expect(html).toContain('Ollama')
  })

  it('humanises raw TaskWraith MCP tool names in compact rows', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace
        activity={makeActivity({
          toolName: 'mcp_TaskWraith_git_status',
          displayName: 'mcp_TaskWraith_git_status',
          category: 'unknown',
          parameters: {}
        })}
      />
    )
    expect(html).toContain('Git status')
    expect(html).not.toContain('mcp_TaskWraith_git_status')
  })

  it('lets metadata.ensembleProvider override metadata.provider for cross-provider rounds', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace
        activity={makeActivity({
          toolName: 'Edit',
          metadata: { provider: 'codex', ensembleProvider: 'claude' }
        })}
      />
    )
    expect(html).toContain('Edit')
    expect(html).toContain('provider-claude')
    expect(html).toContain('Claude')
    expect(html).not.toContain('provider-codex')
  })

  it('falls back to the chat-level provider prop when activity has no metadata', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity()} provider="gemini" />
    )
    expect(html).toContain('provider-gemini')
    expect(html).toContain('Gemini')
  })

  it('renders a compact URL badge when tool input contains a web URL', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace
        activity={makeActivity({
          toolName: 'web_fetch',
          parameters: { url: 'https://github.com/boggspa/TaskWraith' }
        })}
      />
    )
    expect(html).toContain('tool-url-badge')
    expect(html).toContain('github.com')
    expect(html).toContain('favicon-image-fallback')
  })

  it('extracts deduped URL targets from tool parameters and result text', () => {
    const targets = extractToolUrlTargets(
      makeActivity({
        parameters: { url: 'https://github.com/boggspa/TaskWraith' },
        resultSummary: 'Fetched https://github.com/boggspa/TaskWraith and https://example.com/docs.'
      })
    )
    expect(targets.map((target) => target.host)).toEqual(['github.com', 'example.com'])
  })

  it('redacts the inline preview when the result is longer than 500 chars', () => {
    const longResult = 'x'.repeat(800)
    const html = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ resultSummary: longResult })} />
    )
    expect(html).toContain('is-redacted')
    expect(html).toContain('truncated — expand to see full output')
  })

  it('does NOT show the redaction hint when the result is under the threshold', () => {
    const shortResult = 'short result'
    const html = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ resultSummary: shortResult })} />
    )
    expect(html).not.toContain('is-redacted')
    expect(html).not.toContain('truncated — expand to see full output')
  })

  it('caps the inline preview at 80 chars regardless of redaction state', () => {
    const result = 'a'.repeat(120)
    const preview = buildResultPreview(makeActivity({ resultSummary: result }))
    expect(preview.display.length).toBeLessThanOrEqual(81)
    expect(preview.display.endsWith('…')).toBe(true)
  })

  it('skips the preview entirely when no result content is available', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace
        activity={makeActivity({ resultSummary: undefined, outputPreview: undefined })}
      />
    )
    expect(html).not.toContain('compact-tool-trace-preview')
  })

  it('builds foldout sections for { input, result, timeline } when expanded', () => {
    const activity = makeActivity()
    const sections = buildFoldoutSections(activity)
    const labels = sections.map((section) => section.label)
    expect(labels).toContain('Input')
    expect(labels).toContain('Result')
    expect(labels).toContain('Timeline')
  })

  it('foldout result section is pretty-printed (multi-line) JSON when applicable', () => {
    const activity = makeActivity({
      resultSummary: '{"files":["a.ts","b.ts"],"count":2}'
    })
    const sections = buildFoldoutSections(activity)
    const result = sections.find((section) => section.label === 'Result')
    expect(result).toBeDefined()
    expect(result!.body).toContain('\n')
    expect(result!.body).toContain('"files"')
  })

  it('foldout timeline section carries startedAt, endedAt, durationMs, and status', () => {
    const sections = buildFoldoutSections(
      makeActivity({
        startedAt: '2026-05-26T17:00:00Z',
        endedAt: '2026-05-26T17:00:01Z',
        durationMs: 1000,
        status: 'error'
      })
    )
    const timeline = sections.find((section) => section.label === 'Timeline')
    expect(timeline).toBeDefined()
    expect(timeline!.body).toContain('started: 2026-05-26T17:00:00Z')
    expect(timeline!.body).toContain('ended:')
    expect(timeline!.body).toContain('duration: 1000ms')
    expect(timeline!.body).toContain('status:  error')
  })

  it('foldout omits the input section when activity carries no parameters', () => {
    const sections = buildFoldoutSections(makeActivity({ parameters: {} }))
    const labels = sections.map((section) => section.label)
    expect(labels).not.toContain('Input')
  })

  // An edit's foldout used to render its patch as one flat `<pre>` while the
  // full-density ActivityPreview accented the same +/- lines. These pin the
  // diff-toned sections that close that gap.
  describe('edit-tool diff sections', () => {
    const editActivity = (parameters: Record<string, unknown>) =>
      makeActivity({ toolName: 'replace', category: 'write', parameters })

    it('tones the before/after pair of an edit as deletion and addition', () => {
      const sections = buildFoldoutSections(
        editActivity({
          file_path: '/repo/src/foo.ts',
          old_string: 'const a = 0',
          new_string: 'const a = 1'
        })
      )
      const removed = sections.find((section) => section.label === 'Removed')
      const added = sections.find((section) => section.label === 'Added')
      expect(removed).toMatchObject({ body: 'const a = 0', tone: 'deletion' })
      expect(added).toMatchObject({ body: 'const a = 1', tone: 'addition' })
    })

    it('tones an explicit patch parameter as a diff', () => {
      const sections = buildFoldoutSections(
        editActivity({ file_path: '/repo/a.ts', patchPreview: '@@ -1 +1 @@\n-old\n+new' })
      )
      expect(sections.find((section) => section.label === 'Patch preview')).toMatchObject({
        tone: 'diff'
      })
    })

    it('tones a whole-file write as an addition, and never twice for a replace', () => {
      const write = buildFoldoutSections(
        makeActivity({ parameters: { file_path: '/repo/a.ts', content: 'hello' } })
      )
      expect(write.find((section) => section.label === 'Added content')).toMatchObject({
        body: 'hello',
        tone: 'addition'
      })
      // A replace already showed its payload as Removed/Added — the raw
      // `content` key must not add a third, duplicate block.
      const replace = buildFoldoutSections(
        editActivity({ old_string: 'a', new_string: 'b', content: 'a' })
      )
      expect(replace.map((section) => section.label)).not.toContain('Added content')
    })

    it('accents a result that echoes back a unified diff, but not ordinary output', () => {
      const echoed = buildFoldoutSections(
        makeActivity({ resultSummary: '--- a/foo.ts\n+++ b/foo.ts\n-old\n+new' })
      )
      expect(echoed.find((section) => section.label === 'Result')?.tone).toBe('diff')
      // The default fixture's result is "wrote 1 line" — flat, and must stay flat.
      expect(buildFoldoutSections(makeActivity()).find((s) => s.label === 'Result')?.tone)
        .toBeUndefined()
    })

    it('leaves non-write tools untoned', () => {
      const sections = buildFoldoutSections(
        makeActivity({
          toolName: 'read_file',
          category: 'read',
          parameters: { file_path: '/repo/a.ts', content: 'file body' }
        })
      )
      expect(sections.every((section) => section.tone === undefined)).toBe(true)
    })
  })

  it('reflects error status in both the status pill and the row data-status attribute', () => {
    const html = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ status: 'error', resultSummary: 'EACCES' })} />
    )
    expect(html).toContain('data-status="error"')
    expect(html).toContain('status-error')
  })

  it('formats sub-second durations as Xms and second-scale as Xs', () => {
    const shortHtml = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ durationMs: 42 })} />
    )
    expect(shortHtml).toContain('42ms')

    const longHtml = renderToStaticMarkup(
      <CompactToolTrace activity={makeActivity({ durationMs: 1500 })} />
    )
    expect(longHtml).toContain('1.5s')
  })
})

// The expanded foldout used to render as a narrower, independently-bordered
// card indented away from the call line (`margin-left: 24px` + its own
// `border`/`background`) — it read as a card stacked beside the row rather
// than a row underneath it. `FoldoutSectionRow` is the new full-width row
// unit: one per section, its label rendered as a "tucked tab" (rim-
// highlighted chip straddling the row's own top seam) instead of a plain
// caps label. It is exported specifically so this structure is directly
// testable without needing to force the component's `expanded` state, which
// static-markup rendering cannot do.
describe('FoldoutSectionRow (tucked-tab section rows)', () => {
  it('wraps the section label in a tucked-tab element, not the old plain caps label', () => {
    const html = renderToStaticMarkup(
      <FoldoutSectionRow label="Result">
        <div className="probe-body">body content</div>
      </FoldoutSectionRow>
    )
    expect(html).toContain('compact-tool-trace-foldout-section')
    expect(html).toContain('compact-tool-trace-foldout-tab')
    expect(html).not.toContain('compact-tool-trace-foldout-label')
    expect(html).toContain('>Result<')
    expect(html).toContain('probe-body')
  })

  it('renders as a bare row wrapper — no card-style indent/border modifier class', () => {
    const html = renderToStaticMarkup(
      <FoldoutSectionRow label="Input">
        <pre>{'{}'}</pre>
      </FoldoutSectionRow>
    )
    // The row is exactly one wrapper div carrying the section class, with the
    // tab as its first child — never a second "card" class layered on top.
    const openTag = html.slice(0, html.indexOf('>') + 1)
    expect(openTag).toBe('<div class="compact-tool-trace-foldout-section">')
  })

  it('renders distinct tabs for each section when several rows are stacked, proving segmentation', () => {
    const html = renderToStaticMarkup(
      <>
        <FoldoutSectionRow label="Patch preview">
          <pre>patch</pre>
        </FoldoutSectionRow>
        <FoldoutSectionRow label="Result">
          <pre>result</pre>
        </FoldoutSectionRow>
      </>
    )
    const sectionCount = html.split('compact-tool-trace-foldout-section').length - 1
    const tabCount = html.split('compact-tool-trace-foldout-tab').length - 1
    expect(sectionCount).toBe(2)
    expect(tabCount).toBe(2)
    expect(html).toContain('>Patch preview<')
    expect(html).toContain('>Result<')
  })
})

// Product-owner amendment (2026-08-18): the collapsed/at-rest row must read
// as a bare transcript line — no container, no rounded rim highlight of its
// own. ALL of that chrome moves to the expanded card (`.compact-tool-trace-
// foldout`), which now carries its own full-perimeter rim highlight instead
// of leaning on the outer element's. These read the actual CSS source (the
// same technique `bannedDefaultStylesCss.test.ts` uses) because a static-
// markup render can't observe which element paints a border — the row and
// the card are both plain `<div>`s with no visual-only prop to assert on.
describe('CompactToolTrace rim polarity — chrome lives on the expanded card, not the bare row', () => {
  const readCss = (): string =>
    readFileSync(
      new URL('../assets/css/06-component-panels-modals.css', import.meta.url),
      'utf8'
    )

  const cssBlockStartingAt = (source: string, selector: string): string => {
    const start = source.indexOf(selector)
    expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('}', start)
    expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
    return source.slice(start, end + 1)
  }

  it('keeps the outer .compact-tool-trace element bare — no border, radius, or box-shadow', () => {
    const outer = cssBlockStartingAt(readCss(), '.compact-tool-trace {')
    expect(outer).not.toContain('border:')
    expect(outer).not.toContain('border-radius:')
    expect(outer).not.toContain('box-shadow:')
    // The status-tinted custom property is still DEFINED here (it must cascade
    // down to the card), it just must not be used to paint the row itself.
    expect(outer).toContain('--compact-tool-rim:')
  })

  it('gives the expanded card (.compact-tool-trace-foldout) the full rim highlight', () => {
    const card = cssBlockStartingAt(readCss(), '.compact-tool-trace-foldout {')
    expect(card).toContain('border:')
    expect(card).toContain('border-radius:')
    expect(card).toContain('box-shadow:')
    expect(card).toContain('var(--compact-tool-rim)')
    // Full-perimeter rim only — never the banned left-edge accent stripe.
    expect(card).not.toContain('border-left')
  })
})

describe('friendlyGlobalToolLabel (General-chat tool-trace softening)', () => {
  it('softens the web family — including no-underscore aliases — to a friendly one-liner', () => {
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: 'web_search' }))).toBe('Searched the web')
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: 'websearch' }))).toBe('Searched the web')
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: 'google_web_search' }))).toBe(
      'Searched the web'
    )
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: 'web_fetch' }))).toBe('Read a web page')
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: 'webfetch' }))).toBe('Read a web page')
  })

  it('returns null for non-web tools so they keep their normal compact name', () => {
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: 'write_file' }))).toBeNull()
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: 'run_command' }))).toBeNull()
    expect(friendlyGlobalToolLabel(makeActivity({ toolName: '' }))).toBeNull()
  })
})

describe('extractToolFilePath', () => {
  it('prefers a path-like parameter (matching the label source) over activity.filePath', () => {
    expect(
      extractToolFilePath(makeActivity({ filePath: '/repo/a.ts', parameters: { path: '/other/b.ts' } }))
    ).toBe('/other/b.ts')
  })

  it('reads the well-known parameter keys', () => {
    expect(extractToolFilePath(makeActivity())).toBe('/repo/src/foo.ts')
    expect(
      extractToolFilePath(makeActivity({ parameters: { target: '/x/y.ts' } }))
    ).toBe('/x/y.ts')
  })

  it('falls back to the first-class activity.filePath when no path parameter is present', () => {
    expect(
      extractToolFilePath(makeActivity({ filePath: '/repo/only-first-class.ts', parameters: { query: 'todo' } }))
    ).toBe('/repo/only-first-class.ts')
  })

  it('returns undefined when neither a path parameter nor activity.filePath is present', () => {
    expect(
      extractToolFilePath(makeActivity({ filePath: undefined, parameters: { query: 'todo' } }))
    ).toBeUndefined()
  })
})

describe('splitCompactToolLabel', () => {
  it('splits a file verb label into prefix + trailing path', () => {
    const parts = splitCompactToolLabel(
      makeActivity({ filePath: undefined, parameters: { file_path: '/repo/src/foo.ts' } }),
      null
    )
    expect(parts.prefix).toBe('Wrote')
    expect(parts.filePath).toBe('/repo/src/foo.ts')
  })

  it('returns a softened global label whole with no clickable path', () => {
    const parts = splitCompactToolLabel(makeActivity(), 'Searched the web')
    expect(parts.prefix).toBe('Searched the web')
    expect(parts.filePath).toBeUndefined()
  })

  it('does not split when the label does not end in its resolved path', () => {
    // A humanized label that carries a path param but does NOT end in it must
    // stay whole rather than being torn apart at an arbitrary boundary.
    const parts = splitCompactToolLabel(
      makeActivity({
        toolName: 'mcp_custom_do_thing',
        displayName: 'Ran a custom action',
        category: 'unknown',
        filePath: undefined,
        parameters: { path: '/x/y.ts' }
      }),
      null
    )
    expect(parts.filePath).toBeUndefined()
    expect(parts.prefix).toBe('Ran a custom action')
  })
})

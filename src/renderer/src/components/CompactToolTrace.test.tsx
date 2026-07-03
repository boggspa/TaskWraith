import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CompactToolTrace } from './CompactToolTrace'
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

  it('renders Cursor as a first-class provider label', () => {
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

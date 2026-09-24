import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitLifecycleGlyph, type GitLifecycleGlyphKind } from './GitLifecycleGlyph'
import { pullRequestState } from '../PullRequestWorkflowPanel'

const KINDS: GitLifecycleGlyphKind[] = ['synced', 'open', 'ready', 'merged', 'closed']

function glyph(kind: GitLifecycleGlyphKind, size?: number): string {
  return renderToStaticMarkup(<GitLifecycleGlyph kind={kind} size={size} />)
}

describe('GitLifecycleGlyph', () => {
  it('draws a visually distinct shape for every lifecycle state', () => {
    const drawn = KINDS.map((kind) => glyph(kind))
    expect(new Set(drawn).size).toBe(KINDS.length)
    // Merged is the fork rejoining its base; closed is the line cancelled.
    expect(glyph('merged')).toContain('M5.4 7.2c3.7 0 5.4 1.7 6.1 3.8')
    expect(glyph('merged')).not.toContain('m14 5.4-4.4 4.4')
    expect(glyph('closed')).toContain('m14 5.4-4.4 4.4')
  })

  it('keeps the sidebar 11px default and scales for the Inspector', () => {
    expect(glyph('merged')).toContain('width="11"')
    expect(glyph('merged', 14)).toContain('width="14"')
  })
})

describe('pull request lifecycle grading', () => {
  it('grades each state to the sidebar glyph and tone vocabulary', () => {
    expect(pullRequestState({ state: 'MERGED' } as never)).toMatchObject({
      tone: 'merged',
      glyph: 'merged',
      label: 'Merged'
    })
    expect(pullRequestState({ state: 'CLOSED' } as never)).toMatchObject({
      tone: 'closed',
      glyph: 'closed'
    })
    expect(pullRequestState({ state: 'OPEN', isDraft: true } as never)).toMatchObject({
      tone: 'draft',
      glyph: 'open'
    })
    expect(pullRequestState({ state: 'OPEN' } as never)).toMatchObject({
      tone: 'open',
      glyph: 'open'
    })
  })

  it('paints merged purple rather than the app accent it used to borrow', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/assets/css/35-commits-inspector.css'),
      'utf8'
    )
    const block = (selector: string): string => {
      const start = css.indexOf(selector)
      if (start < 0) return ''
      const open = css.indexOf('{', start)
      return css.slice(start, css.indexOf('}', open) + 1)
    }

    // The same purple the sidebar uses; merged is the one final-success state.
    expect(block('.pull-request-state.is-merged {')).toContain('#a78bfa')
    expect(block('.pull-request-state.is-merged {')).not.toContain('var(--accent)')
    expect(block('.pull-request-state.is-closed {')).toContain('--danger')
    // No longer an uppercase text pill.
    expect(block('.pull-request-state {')).not.toContain('text-transform: uppercase')
  })
})

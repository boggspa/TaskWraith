import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/*
 * Static pins for the super-group fold-out phase (smooth settled-stack
 * collapse). No jsdom in this repo — these assert the CSS contract and the
 * TranscriptPanel wiring invariants that keep the animation sound:
 *  - folding rows must NOT enter hiddenRowKeys (0px slots can't record
 *    measurements while mid-animation), and
 *  - the fold phase must participate in the row render signature via
 *    superGroupKey (cached rows would otherwise skip the class change).
 */
const css = readFileSync(
  new URL('../assets/css/02-transcript-messages-fx.css', import.meta.url),
  'utf8'
)
const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')

describe('super-group fold-out CSS', () => {
  it('transitions the folding block height to zero from its natural height', () => {
    expect(css).toMatch(
      /\.transcript-message-block\.is-super-folding\s*\{[^}]*interpolate-size: allow-keywords;[^}]*height: 0;[^}]*overflow: hidden;/
    )
    expect(css).toMatch(/\.is-super-folding\s*\{[^}]*transition:\s*\n?\s*height 260ms/)
  })

  it('folds the virtualized per-child margin with a selector that outranks the slot rule', () => {
    expect(css).toContain(
      '.transcript-inner.transcript-virtualized > .transcript-message-block.is-super-folding'
    )
  })

  it('snaps instantly under reduced motion', () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.transcript-message-block\.is-super-folding\s*\{\s*transition: none;/
    )
  })
})

describe('super-group fold-out wiring', () => {
  it('keeps folding members out of the virtualizer hidden-row set until commit', () => {
    expect(panelSource).toContain('if (foldingSuperGroups.has(group.leadId)) continue')
  })

  it('joins the fold phase into superGroupKey so the row render signature changes', () => {
    expect(panelSource).toContain("superGroupFolding ? 'folding' : 'closed'")
  })

  it('applies is-super-folding as a distinct state from is-super-hidden', () => {
    expect(panelSource).toContain("superGroupFolding ? ' is-super-folding' : ''")
    expect(panelSource).toMatch(
      /superGroup && !superGroupExpanded && !isSuperLead && !superGroupFolding/
    )
  })

  it('commits shortly after the CSS transition completes', () => {
    expect(panelSource).toContain('const SUPER_FOLD_COMMIT_MS = 300')
    expect(css).toContain('height 260ms')
  })
})

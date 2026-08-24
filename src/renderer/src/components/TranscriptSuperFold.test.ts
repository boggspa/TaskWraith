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
    expect(panelSource).toContain('if (foldingSuperGroups.has(group.leadRowKey)) continue')
  })

  it('keys super-group membership and disclosure by collision-proof rowKey', () => {
    expect(panelSource).toContain('const superGroupByRowKey = useMemo')
    expect(panelSource).toContain('leadRowKey: run.members[0].rowKey')
    expect(panelSource).toContain('memberRowKeys: run.members.map((member) => member.rowKey)')
  })

  it('joins the fold phase into superGroupKey so the row render signature changes', () => {
    expect(panelSource).toContain("superGroupFoldPhase ? 'folding' : 'closed'")
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

describe('level-1 stack roll-up', () => {
  it('animates the row from its measured slot height with a fade-in summary', () => {
    expect(css).toMatch(
      /\.transcript-message-block\.is-stack-collapsing\s*\{[^}]*interpolate-size: allow-keywords;[^}]*overflow: hidden;[^}]*animation: transcript-stack-collapse 260ms/
    )
    expect(css).toMatch(/@keyframes transcript-stack-collapse\s*\{\s*from\s*\{\s*height: var\(--collapse-from/)
    expect(css).toContain('.transcript-message-block.is-super-lead-entering > *')
  })

  it('snaps instantly under reduced motion', () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.transcript-message-block\.is-stack-collapsing,[\s\S]{0,200}animation: none;/
    )
  })

  it('joins the entering phase into collapsedStackKey and excludes fold-owned rows', () => {
    expect(panelSource).toContain('collapsedStackKey = `${collapsedStackKey}:entering`')
    expect(panelSource).toMatch(
      /stackAutoCollapsible &&\s*!collapsedStackExpanded &&\s*!superGroupHidden &&\s*!superGroupFolding/
    )
    expect(panelSource).toContain("stackCollapseEntering ? ' is-stack-collapsing' : ''")
    expect(panelSource).toContain("'--collapse-from'")
  })

  it('never animates a first-sighted row and clears state on expand', () => {
    expect(panelSource).toContain('prevCollapsed === false')
    expect(panelSource).toContain('collapseState.entering.delete(liveViewportStackKey)')
  })
})

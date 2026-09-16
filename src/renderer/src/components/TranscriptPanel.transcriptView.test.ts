import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    out.push(path)
  }
  return out
}

/**
 * Every `<ActivityStack` element, excluding the three substring decoys that
 * live in the same files: `<ActivityStackSpeakerHeader`,
 * `<CollapsedActivityStackRow`, and any future `<ActivityStackX`. Requiring a
 * non-identifier character immediately after the name is what makes this
 * exact — a plain `includes('<ActivityStack')` finds six sites, not four.
 */
function activityStackSites(): { file: string; tag: string }[] {
  const sites: { file: string; tag: string }[] = []
  for (const file of sourceFiles(RENDERER_SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/<ActivityStack(?![A-Za-z0-9_])[\s\S]*?\/>/g)) {
      sites.push({ file, tag: match[0] })
    }
  }
  return sites
}

describe('every ActivityStack render site declares its transcript view', () => {
  // `transcriptView` is an OPTIONAL prop, so a site that omits it compiles
  // clean, renders clean, and silently shows everything. That is precisely the
  // failure `DEFAULT_TRANSCRIPT_VIEW`'s doc comment warns about, and it is not
  // catchable any other way: one of the four sites (the stack nested inside
  // TranscriptPanel's CollapsedActivityStackRow) only mounts when a stack has
  // already auto-collapsed, so no server-render test can reach it at all.

  it('finds every site, and no decoys', () => {
    // Anti-vacuity guard. Without this, a regex that matched nothing would let
    // every assertion below pass over an empty collection.
    const sites = activityStackSites()
    expect(sites.length).toBe(4)
    expect(sites.map((s) => s.file.split('/').pop()).sort()).toEqual([
      'EnsembleFanoutResultCard.tsx',
      'SubThreadReturnCard.tsx',
      'TranscriptPanel.tsx',
      'TranscriptPanel.tsx'
    ])
  })

  it('does not mistake ActivityStackSpeakerHeader for ActivityStack', () => {
    // Positive control for the regex: the decoy really is present in the tree,
    // so "4 sites" is a filtered count rather than a lucky one.
    const panel = readFileSync(join(RENDERER_SRC, 'components/TranscriptPanel.tsx'), 'utf8')
    expect(panel).toContain('<ActivityStackSpeakerHeader')
    expect(panel.split('<ActivityStack').length - 1).toBeGreaterThan(2)
  })

  it('passes transcriptView at every site', () => {
    const missing = activityStackSites()
      .filter((site) => !/\btranscriptView=/.test(site.tag))
      .map((site) => site.file.replace(RENDERER_SRC, ''))
    expect(missing).toEqual([])
  })
})

describe('the transcript-view subscription survives a server render', () => {
  it('passes the snapshot getter as getServerSnapshot too', () => {
    // Every renderer test in this repo is `renderToStaticMarkup`, and React's
    // server shim throws "Missing getServerSnapshot" when the third argument is
    // absent — which would red the whole TranscriptPanel suite at once rather
    // than failing here. This pins the intent so the third argument is not
    // "tidied away" as a duplicate.
    const hook = readFileSync(join(RENDERER_SRC, 'hooks/useTranscriptView.ts'), 'utf8')
    const call = hook.slice(hook.indexOf('useSyncExternalStore('), hook.indexOf('return useMemo('))
    expect(call).not.toBe('')
    expect(call.split('getTranscriptViewSnapshot').length - 1).toBe(2)
  })

  it('feeds the view into the row render signature', () => {
    // `transcriptRowRenderSignatureEqual` compares the field (pinned in
    // transcriptRowRenderCache.test.ts), but the object that POPULATES it is
    // an inline literal inside a 7,600-line component render, unreachable
    // without a DOM. Deleting the field there is silent: the comparator then
    // compares undefined to undefined on every row and every cached element
    // outlives the view switch. This is the only available pin.
    const panel = readFileSync(join(RENDERER_SRC, 'components/TranscriptPanel.tsx'), 'utf8')
    const start = panel.indexOf('const rowSignature: TranscriptRowRenderSignature = {')
    expect(start).toBeGreaterThan(-1)
    const literal = panel.slice(start, panel.indexOf('\n            }', start))
    expect(literal).toContain('virtualized:')
    expect(literal).toContain('transcriptView,')
  })

  it('folds live stacks only in the row renderer, never in super-group membership', () => {
    // Two callers, deliberately different predicates. The row renderer folds a
    // live stack under Minimal; super-group membership must not, or a live
    // Minimal row could be swallowed as a member while rendering as its own
    // card. Strictness in that direction is safe — the regression the
    // membership comment records needed membership LOOSER, not tighter.
    const panel = readFileSync(join(RENDERER_SRC, 'components/TranscriptPanel.tsx'), 'utf8')
    expect(panel.split('shouldAutoCollapseActivityStackForView(').length - 1).toBe(1)
    // `shouldAutoCollapseActivityStack(` cannot match the ForView name, since
    // the paren must follow `Stack` directly. One import line + one call.
    expect(panel.split('shouldAutoCollapseActivityStack(').length - 1).toBe(1)
  })

  it('subscribes exactly once, in TranscriptPanel, and threads the rest', () => {
    // Both cards render only from TranscriptPanel, so they take the view as a
    // prop. That is not a style choice: `SubThreadReturnCard` is invoked as a
    // PLAIN FUNCTION in its own suite, with no React dispatcher, so a hook
    // inside it throws "Cannot read properties of null". One subscription per
    // transcript also beats one per lane card on a wide fan-out, and it keeps
    // the settings default (slice 7) a one-argument change in one place.
    const panel = readFileSync(join(RENDERER_SRC, 'components/TranscriptPanel.tsx'), 'utf8')
    expect(panel).toContain('useTranscriptView(')
    for (const card of ['EnsembleFanoutResultCard.tsx', 'SubThreadReturnCard.tsx']) {
      const source = readFileSync(join(RENDERER_SRC, 'components', card), 'utf8')
      expect(source).not.toContain('useTranscriptView')
      expect(source).not.toContain('subscribeTranscriptView')
      expect(source).toContain('transcriptView?: TranscriptView')
    }
  })
})

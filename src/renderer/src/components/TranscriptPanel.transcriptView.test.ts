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
function activityStackSites(): { file: string; tag: string; selfClosing: boolean }[] {
  const sites: { file: string; tag: string; selfClosing: boolean }[] = []
  for (const file of sourceFiles(RENDERER_SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/<ActivityStack(?![A-Za-z0-9_])/g)) {
      const tag = readOpeningTag(source, match.index!)
      sites.push({ file, tag, selfClosing: tag.endsWith('/>') })
    }
  }
  return sites
}

/**
 * Read one JSX opening tag, from `<Name` to its own `>` or `/>`.
 *
 * A lazy `[\s\S]*?\/>` is wrong in both directions and this guard is the only
 * thing standing between an unthreaded render site and a silently
 * everything-showing transcript, so it is worth doing properly:
 *
 *  - a CHILDREN-form site (`<ActivityStack ...>...</ActivityStack>`) has no
 *    `/>` of its own, so the lazy form runs on to the next self-closing tag
 *    anywhere below and hands back a span that may well contain some OTHER
 *    element's `transcriptView=` — a false pass, the dangerous direction;
 *  - a `/>` inside a prop (`icon={<Foo />}`) truncates the match early and can
 *    cut the real `transcriptView=` off the end.
 *
 * So: scan forward, tracking string literals and brace depth, and stop at the
 * first `>` that is genuinely at depth zero and outside quotes.
 */
function readOpeningTag(source: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === '>' && depth === 0) return source.slice(start, i + 1)
  }
  return source.slice(start)
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
    // Every site is self-closing today. If one ever takes children the tag
    // scanner still reads it correctly, but say so out loud rather than
    // letting the shape change go unnoticed.
    expect(sites.filter((site) => !site.selfClosing)).toEqual([])
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
    const end = panel.indexOf('\n            }', start)
    // Without this the end anchor is indentation-dependent and fails OPEN: a
    // missed `indexOf` returns -1, `slice(start, -1)` hands back the rest of
    // the file, and `transcriptView,` is certain to appear somewhere in it. The
    // guard would pass on a signature that had lost the field entirely.
    expect(end).toBeGreaterThan(start)
    const literal = panel.slice(start, end)
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
    // Counting occurrences is not enough: one of each would still pass if the
    // two were SWAPPED. Assert WHICH block each sits in.
    const strictAt = panel.indexOf('shouldAutoCollapseActivityStack(')
    const forViewAt = panel.indexOf('shouldAutoCollapseActivityStackForView(')
    expect(strictAt).toBeGreaterThan(-1)
    expect(forViewAt).toBeGreaterThan(-1)
    expect(panel.split('shouldAutoCollapseActivityStack(').length - 1).toBe(1)
    expect(panel.split('shouldAutoCollapseActivityStackForView(').length - 1).toBe(1)
    // The strict call is the super-group membership test; the view-aware one is
    // the row renderer's `stackAutoCollapsible`.
    const membershipAt = panel.indexOf('const membershipOf = (')
    const rowRendererAt = panel.indexOf('const stackAutoCollapsible =')
    expect(membershipAt).toBeGreaterThan(-1)
    expect(rowRendererAt).toBeGreaterThan(membershipAt)
    expect(strictAt).toBeGreaterThan(membershipAt)
    expect(strictAt).toBeLessThan(rowRendererAt)
    expect(forViewAt).toBeGreaterThan(rowRendererAt)
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

describe('a view flip invalidates measured row heights', () => {
  it('shares the density invalidation effect', () => {
    // A Minimal row is a one-liner where a Standard one was a full activity
    // stack, so every cached height is wrong by a large margin. Without this
    // the spacers stay sized for the pre-flip rows and the reader gets a
    // scroll jump with blank gaps. Density already had exactly this problem
    // and exactly this fix; the view rides the same effect.
    const panel = readFileSync(join(RENDERER_SRC, 'components/TranscriptPanel.tsx'), 'utf8')
    // Anchor on the density effect's own comment: there are several
    // `measurementsRef.current.clear()` sites and the first one is the
    // chat-change reset, which must NOT gain the view.
    const start = panel.indexOf('// Density change alters --space-lg')
    expect(start).toBeGreaterThan(-1)
    const effect = panel.slice(start, panel.indexOf('}, [', start) + 200)
    expect(effect).toContain('measurementsRef.current.clear()')
    expect(effect).toContain('geometryHeightsRef.current.clear()')
    const deps = effect.slice(effect.indexOf('}, ['))
    expect(deps).toContain('compactDensity')
    expect(deps).toContain('transcriptView')
  })

  it('threads the view into the virtualisation hook', () => {
    const panel = readFileSync(join(RENDERER_SRC, 'components/TranscriptPanel.tsx'), 'utf8')
    const call = panel.slice(panel.indexOf('} = useTranscriptVirtualization({'))
    expect(call).not.toBe('')
    expect(call.slice(0, 200)).toContain('transcriptView')
  })
})

describe('the recovered-activity caption never outlives its stack', () => {
  it('gates the note on whether the stack will render', () => {
    // The caption describes the stack beneath it. When a view filtered every
    // recovered activity away the stack rendered nothing and the note was left
    // captioning empty space.
    const card = readFileSync(join(RENDERER_SRC, 'components/SubThreadReturnCard.tsx'), 'utf8')
    expect(card).toContain('recoveredActivitiesVisible')
    const noteAt = card.indexOf('Parent-run activity recorded onto this card')
    expect(noteAt).toBeGreaterThan(-1)
    const gateAt = card.lastIndexOf('{recoveredActivitiesVisible && (', noteAt)
    expect(gateAt).toBeGreaterThan(-1)
    // The gate must be the one immediately wrapping the note, not an earlier
    // unrelated conditional.
    expect(card.slice(gateAt, noteAt)).not.toContain('</div>')
  })
})

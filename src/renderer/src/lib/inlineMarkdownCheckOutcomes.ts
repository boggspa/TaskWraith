import type { Element, Root, RootContent } from 'hast'

export type InlineMarkdownCheckOutcomeKind = 'text' | 'pass' | 'fail' | 'skip'

export interface InlineMarkdownCheckOutcomeSegment {
  kind: InlineMarkdownCheckOutcomeKind
  value: string
}

type AccentKind = Exclude<InlineMarkdownCheckOutcomeKind, 'text'>

interface AccentRange {
  start: number
  end: number
  kind: AccentKind
}

// Integers only, matching the diff-stat tokeniser's shape so grouped thousands
// ("2,127 tests green") read the same way in both idioms.
const COUNT_SOURCE = String.raw`(?:[1-9]\d{0,2}(?:,\d{3})+|0|[1-9]\d*)`

/** The unit a count measures. A count with no unit and no label is just a number. */
const COUNT_NOUN_SOURCE = String.raw`(?:tests?|specs?|suites?|checks?|cases?|files?|assertions?|examples?)`

/** The verified subject in an uncounted verdict ("typecheck passes"). */
const SUBJECT_SOURCE = String.raw`(?:type-?checks?|typescript|tests?|specs?|suites?|linting|lints?|builds?|compiles?|compilation|formatting|checks?|CI)`

// Longest alternatives first so a prefix ("pass") never wins over the word that
// actually appears ("passing") and forces a backtrack through the word guard.
const PASS_LABEL_SOURCE = String.raw`(?:passing|passes|passed|pass|green)`
const FAIL_LABEL_SOURCE = String.raw`(?:failing|failures|failure|failed|fails|fail|errors|error|red)`
// Warnings are a problem word like errors, but a caution rather than a defeat,
// so they take the muted accent while still reading as good news at zero.
const WARN_LABEL_SOURCE = String.raw`(?:warnings|warning|warns|warn)`
const SKIP_LABEL_SOURCE = String.raw`(?:skipping|skipped|skips|skip|pending|todo|ignored)`
const LABEL_SOURCE = `(?:${PASS_LABEL_SOURCE}|${FAIL_LABEL_SOURCE}|${WARN_LABEL_SOURCE}|${SKIP_LABEL_SOURCE})`

/** Verdict verbs carry more idioms than count labels ("build succeeded", "lint clean"). */
const PASS_VERB_SOURCE = String.raw`(?:passing|passes|passed|pass|succeeds|succeeded|green|clean|ok)`
const FAIL_VERB_SOURCE = String.raw`(?:failing|failed|fails|fail|errored|errors|broken|broke|red)`

/** Bare verdicts usable on either side of a transition arrow or after "all". */
const VERDICT_SOURCE = String.raw`(?:passing|passed|pass|green|failing|failed|fail|red|clean|broken)`

const PASS_TEST = new RegExp(`^${PASS_LABEL_SOURCE}$|^${PASS_VERB_SOURCE}$`, 'iu')
const FAIL_TEST = new RegExp(`^${FAIL_LABEL_SOURCE}$|^${FAIL_VERB_SOURCE}$`, 'iu')
const WARN_TEST = new RegExp(`^${WARN_LABEL_SOURCE}$`, 'iu')

// A count must not be glued to a word, a decimal, a currency or a percentage —
// "95% passing" and "v1.2 fails" are not counted outcomes.
const COUNT_PREFIX_GUARD = String.raw`(?<![\p{L}\p{N}_.,$£€¥%°+\-−/])`
const WORD_PREFIX_GUARD = String.raw`(?<![\p{L}\p{N}_])`
const WORD_SUFFIX_GUARD = String.raw`(?![\p{L}\p{N}_])`

const SEP = String.raw`[ \t]+`
const ARROW = String.raw`[ \t]*(?:→|➜|=>|-->|->)[ \t]*`
// Runners stack two units in real output ("2 test files failed"), so a count
// may carry up to two nouns before its label.
const OPTIONAL_NOUN_RUN = `(?:${SEP}${COUNT_NOUN_SOURCE}){0,2}`
const REQUIRED_NOUN_RUN = `(?:${SEP}${COUNT_NOUN_SOURCE}){1,2}`

/**
 * Branch order is significant: at a shared start offset the first alternative
 * wins, so the wider idiom has to precede the narrower one it contains.
 * "no lint errors" must beat "lint errors", and "98 files / 2127 tests green"
 * and "68/68 passing" must both beat the plain count that starts them.
 */
const CHECK_OUTCOME_PATTERN = new RegExp(
  [
    // "no lint errors", "zero regressions" — an absence of problems is a pass,
    // so the whole phrase is accented; colouring only "errors" would invert it.
    String.raw`${WORD_PREFIX_GUARD}(?<negated>(?:no|zero)${SEP}(?:(?:new|remaining|outstanding|further)${SEP})?(?:${SUBJECT_SOURCE}${SEP})?(?:errors?|failures?|regressions?|warnings?|problems?|issues?|failing${SEP}tests?))${WORD_SUFFIX_GUARD}`,
    // "red→green"
    String.raw`${WORD_PREFIX_GUARD}(?<transitionFrom>${VERDICT_SOURCE})${ARROW}(?<transitionTo>${VERDICT_SOURCE})${WORD_SUFFIX_GUARD}`,
    // "All green"
    String.raw`${WORD_PREFIX_GUARD}(?<allPhrase>all${SEP}(?<allVerdict>${VERDICT_SOURCE}))${WORD_SUFFIX_GUARD}`,
    // "98 files / 2127 tests green" — both counts share the trailing label.
    String.raw`${COUNT_PREFIX_GUARD}(?<groupFirst>${COUNT_SOURCE})${REQUIRED_NOUN_RUN}[ \t]*[/,][ \t]*(?<groupSecond>${COUNT_SOURCE})${REQUIRED_NOUN_RUN}${SEP}(?<groupLabel>${LABEL_SOURCE})${WORD_SUFFIX_GUARD}`,
    // "68/68 passing", "2122/2127 tests green"
    String.raw`${COUNT_PREFIX_GUARD}(?<ratio>${COUNT_SOURCE}/${COUNT_SOURCE})${OPTIONAL_NOUN_RUN}${SEP}(?<ratioLabel>${LABEL_SOURCE})${WORD_SUFFIX_GUARD}`,
    // "2127 passed", "5 tests failed", "3 skipped"
    String.raw`${COUNT_PREFIX_GUARD}(?<count>${COUNT_SOURCE})${OPTIONAL_NOUN_RUN}${SEP}(?<countLabel>${LABEL_SOURCE})${WORD_SUFFIX_GUARD}`,
    // "Typecheck passes", "tests failed", "build succeeded"
    String.raw`${WORD_PREFIX_GUARD}(?<phrase>${SUBJECT_SOURCE}${SEP}(?<phraseVerb>${PASS_VERB_SOURCE}|${FAIL_VERB_SOURCE}))${WORD_SUFFIX_GUARD}`
  ].join('|'),
  'giu'
)

function classifyVerdict(word: string): AccentKind | null {
  if (PASS_TEST.test(word)) return 'pass'
  if (FAIL_TEST.test(word)) return 'fail'
  return null
}

function classifyLabel(label: string): AccentKind {
  const verdict = classifyVerdict(label)
  return verdict ?? 'skip'
}

/** Errors, failures and warnings all count as problems; the rest do not. */
function isProblemLabel(label: string): boolean {
  return FAIL_TEST.test(label) || WARN_TEST.test(label)
}

/**
 * A count reverses its label's polarity at zero: "0 failures" is the same good
 * news as "no failures" and must never glow red. "0 passed" claims nothing, so
 * it stays unaccented rather than being dressed up as a success.
 */
function classifyCount(count: string, label: string): AccentKind | null {
  const kind = classifyLabel(label)
  if (count !== '0') return kind
  return isProblemLabel(label) ? 'pass' : null
}

function pushRange(
  ranges: AccentRange[],
  start: number,
  value: string,
  kind: AccentKind | null
): void {
  if (!kind) return
  ranges.push({ start, end: start + value.length, kind })
}

function accentRanges(value: string): AccentRange[] {
  const ranges: AccentRange[] = []
  for (const match of value.matchAll(CHECK_OUTCOME_PATTERN)) {
    const start = match.index
    const groups = match.groups
    if (start === undefined || !groups) continue

    if (groups.negated) {
      pushRange(ranges, start, groups.negated, 'pass')
      continue
    }

    if (groups.transitionFrom && groups.transitionTo) {
      pushRange(ranges, start, groups.transitionFrom, classifyVerdict(groups.transitionFrom))
      const toOffset = match[0].indexOf(groups.transitionTo, groups.transitionFrom.length)
      if (toOffset >= 0) {
        pushRange(
          ranges,
          start + toOffset,
          groups.transitionTo,
          classifyVerdict(groups.transitionTo)
        )
      }
      continue
    }

    if (groups.allPhrase && groups.allVerdict) {
      pushRange(ranges, start, groups.allPhrase, classifyVerdict(groups.allVerdict))
      continue
    }

    if (groups.groupFirst && groups.groupSecond && groups.groupLabel) {
      const kind = classifyLabel(groups.groupLabel)
      pushRange(
        ranges,
        start,
        groups.groupFirst,
        classifyCount(groups.groupFirst, groups.groupLabel)
      )
      const secondOffset = match[0].indexOf(groups.groupSecond, groups.groupFirst.length)
      if (secondOffset >= 0) {
        pushRange(
          ranges,
          start + secondOffset,
          groups.groupSecond,
          groups.groupSecond === '0' ? classifyCount(groups.groupSecond, groups.groupLabel) : kind
        )
      }
      continue
    }

    if (groups.ratio && groups.ratioLabel) {
      const numerator = groups.ratio.slice(0, groups.ratio.indexOf('/'))
      pushRange(ranges, start, groups.ratio, classifyCount(numerator, groups.ratioLabel))
      continue
    }

    if (groups.count && groups.countLabel) {
      pushRange(ranges, start, groups.count, classifyCount(groups.count, groups.countLabel))
      continue
    }

    if (groups.phrase && groups.phraseVerb) {
      pushRange(ranges, start, groups.phrase, classifyVerdict(groups.phraseVerb))
    }
  }
  return ranges
}

/**
 * Recognise the check-result idioms agents relay from command output. Every
 * accent keeps its own words — the count, the label, the "no" in "no errors" —
 * so colour is emphasis only and copying the rendered Markdown yields the
 * source text unchanged.
 */
export function tokeniseInlineMarkdownCheckOutcomes(
  value: string
): InlineMarkdownCheckOutcomeSegment[] {
  if (!value) return [{ kind: 'text', value }]

  const segments: InlineMarkdownCheckOutcomeSegment[] = []
  let cursor = 0
  for (const range of accentRanges(value)) {
    if (range.start < cursor) continue
    if (range.start > cursor)
      segments.push({ kind: 'text', value: value.slice(cursor, range.start) })
    segments.push({ kind: range.kind, value: value.slice(range.start, range.end) })
    cursor = range.end
  }

  if (cursor < value.length) segments.push({ kind: 'text', value: value.slice(cursor) })
  return segments.length > 0 ? segments : [{ kind: 'text', value }]
}

const SKIPPED_MARKDOWN_TAGS = new Set(['a', 'code', 'pre'])

function checkOutcomeElement(kind: AccentKind, value: string): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['markdown-inline-check-outcome', `is-${kind}`]
    },
    children: [{ type: 'text', value }]
  }
}

function annotateCheckOutcomes(parent: Root | Element): void {
  const nextChildren: RootContent[] = []
  for (const child of parent.children as RootContent[]) {
    if (child.type === 'text') {
      const segments = tokeniseInlineMarkdownCheckOutcomes(child.value)
      if (segments.length === 1 && segments[0].kind === 'text') {
        nextChildren.push(child)
        continue
      }
      for (const segment of segments) {
        nextChildren.push(
          segment.kind === 'text'
            ? { type: 'text', value: segment.value }
            : checkOutcomeElement(segment.kind, segment.value)
        )
      }
      continue
    }

    if (
      child.type === 'element' &&
      !SKIPPED_MARKDOWN_TAGS.has(child.tagName) &&
      typeof child.properties.dataColorToken !== 'string'
    ) {
      annotateCheckOutcomes(child)
    }
    nextChildren.push(child)
  }
  parent.children = nextChildren as typeof parent.children
}

/** Annotate check-result idioms after Markdown has become safe HAST. */
export function rehypeInlineMarkdownCheckOutcomes(): (tree: Root) => void {
  return (tree) => annotateCheckOutcomes(tree)
}

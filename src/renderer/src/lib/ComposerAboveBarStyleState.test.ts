import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_AREA_HAS_ABOVE_STACK_CLASS,
  COMPOSER_ENSEMBLE_ROW_SELECTOR,
  COMPOSER_PRIMARY_WORKSPACE_ROW_CLASS,
  COMPOSER_STACK_HAS_ENSEMBLE_ROWS_CLASS,
  COMPOSER_STACK_HAS_PRIMARY_ROW_CLASS,
  COMPOSER_STACK_MULTI_ROW_CLASS,
  applyComposerAboveBarStyleState,
  clearComposerAboveBarStyleState,
  readComposerAboveBarSnapshot,
  type ClassListLike
} from './ComposerAboveBarStyleState'

const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n')

const CSS_FILES = [
  'src/renderer/src/assets/css/03-composer-welcome-activity.css',
  'src/renderer/src/assets/css/08-theme-picker-overrides.css',
  'src/renderer/src/assets/css/09-ensemble-work-session.css',
  'src/renderer/src/assets/css/10-provider-shell-overrides.css',
  'src/renderer/src/assets/css/17-composer-hint-pills.css'
]

/** Same normalization Blink uses when it serializes a selector into a trace. */
const normalizeCss = (css: string): string =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/'/g, '"')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')

class StubClassList implements ClassListLike {
  readonly tokens: Set<string>
  writes = 0

  constructor(initial: readonly string[] = []) {
    this.tokens = new Set(initial)
  }

  contains(token: string): boolean {
    return this.tokens.has(token)
  }

  add(token: string): void {
    this.tokens.add(token)
    this.writes++
  }

  remove(token: string): void {
    this.tokens.delete(token)
    this.writes++
  }
}

function createStack(
  options: {
    children?: readonly (readonly string[])[]
    ensembleDescendant?: boolean
    withArea?: boolean
  } = {}
) {
  const classList = new StubClassList()
  const areaClassList = options.withArea === false ? null : new StubClassList()
  const querySelectorCalls: string[] = []
  const stack = {
    classList,
    children: (options.children ?? []).map((tokens) => ({ classList: new StubClassList(tokens) })),
    querySelector(selector: string): unknown {
      querySelectorCalls.push(selector)
      return options.ensembleDescendant ? {} : null
    },
    closest(): { readonly classList: ClassListLike } | null {
      return areaClassList ? { classList: areaClassList } : null
    }
  }
  return { stack, classList, areaClassList, querySelectorCalls }
}

describe('composer above-bar style state', () => {
  it('treats two element children as the :has(> :nth-child(2)) condition', () => {
    expect(readComposerAboveBarSnapshot(createStack({ children: [] }).stack).hasMultipleRows).toBe(
      false
    )
    expect(
      readComposerAboveBarSnapshot(createStack({ children: [['a']] }).stack).hasMultipleRows
    ).toBe(false)
    expect(
      readComposerAboveBarSnapshot(createStack({ children: [['a'], ['b']] }).stack).hasMultipleRows
    ).toBe(true)
    expect(
      readComposerAboveBarSnapshot(createStack({ children: [['a'], ['b'], ['c']] }).stack)
        .hasMultipleRows
    ).toBe(true)
  })

  it('matches the primary workspace row as a DIRECT child only', () => {
    const present = createStack({
      children: [
        ['composer-above-bar'],
        ['composer-workspace-above-row', 'composer-workspace-above-row--primary']
      ]
    })
    expect(readComposerAboveBarSnapshot(present.stack).hasPrimaryWorkspaceRow).toBe(true)

    // A non-primary workspace row must not satisfy `:has(> ...--primary)`.
    const absent = createStack({ children: [['composer-workspace-above-row']] })
    expect(readComposerAboveBarSnapshot(absent.stack).hasPrimaryWorkspaceRow).toBe(false)
    // Proven structurally: the direct-child condition never consults
    // querySelector (which would also match descendants).
    expect(absent.querySelectorCalls).toEqual([COMPOSER_ENSEMBLE_ROW_SELECTOR])
  })

  it('matches ensemble rows as descendants using the exact replaced :has() argument', () => {
    const withRows = createStack({ ensembleDescendant: true })
    expect(readComposerAboveBarSnapshot(withRows.stack).hasEnsembleRows).toBe(true)
    expect(withRows.querySelectorCalls).toEqual([COMPOSER_ENSEMBLE_ROW_SELECTOR])
    expect(readComposerAboveBarSnapshot(createStack({}).stack).hasEnsembleRows).toBe(false)
  })

  it('applies every flag to the stack and its owning composer area', () => {
    const { stack, classList, areaClassList } = createStack({
      children: [['composer-workspace-above-row--primary'], ['ensemble-above-row']],
      ensembleDescendant: true
    })
    expect(applyComposerAboveBarStyleState(stack)).toBe(4)
    expect(classList.contains(COMPOSER_STACK_HAS_ENSEMBLE_ROWS_CLASS)).toBe(true)
    expect(classList.contains(COMPOSER_STACK_MULTI_ROW_CLASS)).toBe(true)
    expect(classList.contains(COMPOSER_STACK_HAS_PRIMARY_ROW_CLASS)).toBe(true)
    expect(areaClassList?.contains(COMPOSER_AREA_HAS_ABOVE_STACK_CLASS)).toBe(true)
  })

  it('writes nothing when re-applied to an unchanged stack', () => {
    const { stack, classList, areaClassList } = createStack({
      children: [['composer-workspace-above-row--primary'], ['ensemble-above-row']],
      ensembleDescendant: true
    })
    applyComposerAboveBarStyleState(stack)
    const stackWrites = classList.writes
    const areaWrites = areaClassList?.writes ?? 0

    expect(applyComposerAboveBarStyleState(stack)).toBe(0)
    expect(classList.writes).toBe(stackWrites)
    expect(areaClassList?.writes).toBe(areaWrites)
  })

  it('removes flags when the rows they describe leave the stack', () => {
    const populated = createStack({
      children: [['composer-workspace-above-row--primary'], ['ensemble-above-row']],
      ensembleDescendant: true
    })
    applyComposerAboveBarStyleState(populated.stack)

    // Same element, rows gone: re-read must drop all three stack flags while the
    // area flag stays (the stack itself is still mounted).
    const emptied = {
      ...populated.stack,
      children: [] as { readonly classList: ClassListLike }[],
      querySelector: () => null
    }
    expect(applyComposerAboveBarStyleState(emptied)).toBe(3)
    expect(populated.classList.contains(COMPOSER_STACK_HAS_ENSEMBLE_ROWS_CLASS)).toBe(false)
    expect(populated.classList.contains(COMPOSER_STACK_MULTI_ROW_CLASS)).toBe(false)
    expect(populated.classList.contains(COMPOSER_STACK_HAS_PRIMARY_ROW_CLASS)).toBe(false)
    expect(populated.areaClassList?.contains(COMPOSER_AREA_HAS_ABOVE_STACK_CLASS)).toBe(true)
  })

  it('clears only the area flag when the stack unmounts', () => {
    const { stack, classList, areaClassList } = createStack({ children: [['a'], ['b']] })
    applyComposerAboveBarStyleState(stack)
    expect(areaClassList?.contains(COMPOSER_AREA_HAS_ABOVE_STACK_CLASS)).toBe(true)

    expect(clearComposerAboveBarStyleState(stack)).toBe(1)
    expect(areaClassList?.contains(COMPOSER_AREA_HAS_ABOVE_STACK_CLASS)).toBe(false)
    // Stack-owned flags leave with the element, so they are not touched here.
    expect(classList.contains(COMPOSER_STACK_MULTI_ROW_CLASS)).toBe(true)
    expect(clearComposerAboveBarStyleState(stack)).toBe(0)
  })

  it('survives a stack rendered outside any composer area', () => {
    const { stack, classList } = createStack({ children: [['a'], ['b']], withArea: false })
    expect(applyComposerAboveBarStyleState(stack)).toBe(1)
    expect(classList.contains(COMPOSER_STACK_MULTI_ROW_CLASS)).toBe(true)
    expect(clearComposerAboveBarStyleState(stack)).toBe(0)
  })
})

describe('composer above-bar invalidation contract (CSS)', () => {
  // The four `:has()` conditions the trace named. A rule is only a problem when
  // one of them sits in front of a FEATURELESS subject (`> *`, `> *::after`,
  // `> *:first-child`, `> :not(...)`): Blink cannot key an invalidation set on a
  // subject with no class/id/tag feature, so it marks the whole subtree invalid
  // and — because the anchor is a `:has()` scope — schedules it at `HTML`.
  // Rules that keep `:has()` in front of a CLASS subject are keyed narrowly and
  // were never in the measured set.
  const HAS_CONDITIONS: readonly (readonly [string, RegExp])[] = [
    ['area :has(stack)', /\.composer-area:has\(\.composer-above-bar-stack\)/],
    ['stack :has(ensemble rows)', /\.composer-above-bar-stack:has\(:is\(\.ensemble-above-row/],
    ['stack :has(> :nth-child(2))', /\.composer-above-bar-stack:has\(> :nth-child\(2\)\)/],
    [
      'stack :has(> primary row)',
      /\.composer-above-bar-stack:has\(> \.composer-workspace-above-row--primary\)/
    ]
  ]

  const splitTopLevelCommas = (prelude: string): string[] => {
    const parts: string[] = []
    let depth = 0
    let start = 0
    for (let index = 0; index < prelude.length; index++) {
      const ch = prelude[index]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) {
        parts.push(prelude.slice(start, index))
        start = index + 1
      }
    }
    parts.push(prelude.slice(start))
    return parts
  }

  /** Every individual selector in a stylesheet, at-rules acting as containers. */
  const ruleSelectors = (css: string): string[] => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
    const selectors: string[] = []
    let depth = 0
    let start = 0
    for (let index = 0; index < source.length; index++) {
      const ch = source[index]
      if (ch === '{') {
        const prelude = source.slice(start, index).trim()
        if (prelude && !prelude.startsWith('@')) selectors.push(...splitTopLevelCommas(prelude))
        depth++
        start = index + 1
      } else if (ch === '}') {
        depth--
        start = index + 1
      } else if (ch === ';' && depth > 0) {
        start = index + 1
      }
    }
    return selectors
  }

  /**
   * The subject is the final compound; featureless means it carries no
   * class/id/tag. Tokenizing must respect parentheses, or the space inside
   * `:has(> :nth-child(2))` would look like a compound boundary.
   */
  const subjectIsFeatureless = (normalizedSelector: string): boolean => {
    const tokens: string[] = []
    let depth = 0
    let current = ''
    for (const ch of normalizedSelector) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (ch === ' ' && depth === 0) {
        if (current) tokens.push(current)
        current = ''
        continue
      }
      current += ch
    }
    if (current) tokens.push(current)
    const subject = tokens[tokens.length - 1] ?? ''

    // `:not(...)` contributes no POSITIVE feature, so strip it before deciding.
    // Everything else that carries a class/id/tag (including `:is(.a, .b)`,
    // whose arms are all classes) gives Blink something to key the set on.
    let stripped = ''
    let index = 0
    while (index < subject.length) {
      if (subject.startsWith(':not(', index)) {
        let notDepth = 0
        let cursor = index + 4
        for (; cursor < subject.length; cursor++) {
          if (subject[cursor] === '(') notDepth++
          else if (subject[cursor] === ')') {
            notDepth--
            if (notDepth === 0) break
          }
        }
        index = cursor + 1
        continue
      }
      stripped += subject[index]
      index++
    }
    return !/[.#]/.test(stripped) && !/^[a-zA-Z]/.test(stripped)
  }

  it('keeps no :has() condition in front of a featureless subject', () => {
    const offenders: string[] = []
    let inspected = 0
    for (const file of CSS_FILES) {
      for (const selector of ruleSelectors(readSource(file))) {
        const normalized = normalizeCss(selector).trim()
        const condition = HAS_CONDITIONS.find(([, pattern]) => pattern.test(normalized))
        if (!condition) continue
        inspected++
        if (subjectIsFeatureless(normalized))
          offenders.push(`${file} [${condition[0]}] ${normalized}`)
      }
    }
    // Non-vacuity: these conditions must still exist on class subjects, so an
    // empty scan would mean the parser stopped seeing the corpus.
    expect(inspected).toBeGreaterThan(10)
    expect(
      offenders,
      'A `:has()` condition in front of a featureless subject rebuilds the ' +
        'document-scale invalidation set the 20s trace measured.'
    ).toEqual([])
  })

  it('keys those rules off the replacement flag classes instead', () => {
    const all = CSS_FILES.map(readSource).join('\n')
    expect(all).toContain(COMPOSER_AREA_HAS_ABOVE_STACK_CLASS)
    expect(all).toContain(COMPOSER_STACK_HAS_ENSEMBLE_ROWS_CLASS)
    expect(all).toContain(COMPOSER_STACK_MULTI_ROW_CLASS)
    expect(all).toContain(COMPOSER_STACK_HAS_PRIMARY_ROW_CLASS)
  })

  it('leaves narrow class-subject :has() rules alone', () => {
    // These were never in the measured invalidation set (their subject carries a
    // class, so Blink keys the set narrowly). Removing them would be an
    // unrelated, unmeasured change.
    const ensemble = readSource('src/renderer/src/assets/css/09-ensemble-work-session.css')
    expect(ensemble).toContain('.composer-above-bar-stack:has(.ensemble-above-row)')
  })

  it('wires both the live composer and the Settings preview to the same hook', () => {
    for (const file of [
      'src/renderer/src/components/Composer.tsx',
      'src/renderer/src/components/ComposerShellPreview.tsx'
    ]) {
      const source = readSource(file)
      expect(source).toContain('useComposerAboveBarStyleState')
      expect(source).toContain('composer-above-bar-stack')
    }
  })

  it('reuses the primary-workspace-row class name the CSS still matches on', () => {
    expect(COMPOSER_PRIMARY_WORKSPACE_ROW_CLASS).toBe('composer-workspace-above-row--primary')
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The composer shells hide everything in the left picker bar that is not on an
 * explicit `data-composer-control` allowlist, with `display: none !important`.
 *
 * The custom-model input carried no control token, so picking "Custom model ID"
 * rendered a text field that every shipped shell immediately hid — the model
 * chip changed and nothing else, which is indistinguishable from the row doing
 * nothing at all. These tests pin the two halves of that contract together so a
 * new shell (or a new allowlist) cannot silently re-hide the field.
 */

const rendererRoot = join(process.cwd(), 'src/renderer/src')
const cssRoot = join(rendererRoot, 'assets/css')

const CUSTOM_MODEL_CONTROL = 'data-composer-control="custom-model"'
const ALLOWLIST_PREFIX = '.composer-inline-pickers-left > *:not('

function assetCssFiles(): string[] {
  return readdirSync(cssRoot)
    .filter((name) => name.endsWith('.css'))
    .map((name) => join(cssRoot, name))
}

/** Every selector line that hides non-allowlisted left-bar controls. */
function leftBarAllowlistSelectors(): { file: string; selector: string }[] {
  return assetCssFiles().flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes(ALLOWLIST_PREFIX))
      .map((selector) => ({ file: file.slice(cssRoot.length + 1), selector }))
  )
}

describe('composer custom-model control', () => {
  it('renders the custom-model field with a shell allowlist token', () => {
    const composer = readFileSync(join(rendererRoot, 'components/Composer.tsx'), 'utf8')
    const marker = 'className="composer-inline-custom-model"'
    const start = composer.indexOf(marker)
    expect(start, 'custom-model field missing from Composer').toBeGreaterThanOrEqual(0)
    // The token must sit on the same element as the class, not merely somewhere
    // in the file: the allowlist matches direct children of the left bar.
    const element = composer.slice(start, composer.indexOf('>', start))
    expect(element).toContain(CUSTOM_MODEL_CONTROL)
  })

  it('exempts the custom-model field from every shell left-bar allowlist', () => {
    const selectors = leftBarAllowlistSelectors()
    // Guard against a vacuous pass: this suite is worthless if the scan finds
    // no allowlists at all (renamed class, moved file, changed formatting).
    expect(selectors.length).toBeGreaterThanOrEqual(6)

    const unexempt = selectors
      .filter(({ selector }) => !selector.includes(`:not([${CUSTOM_MODEL_CONTROL}])`))
      .map(({ file, selector }) => `${file}: ${selector.slice(0, 80)}…`)

    expect(unexempt).toEqual([])
  })

  it('covers every shell that ships a left-bar allowlist', () => {
    const shells = new Set<string>()
    for (const { selector } of leftBarAllowlistSelectors()) {
      for (const match of selector.matchAll(/\[data-composer-style="([a-z-]+)"\]/g)) {
        shells.add(match[1])
      }
    }
    expect([...shells].sort()).toEqual([
      'chatgpt',
      'claude',
      'codex',
      'cursor',
      'gemini',
      'grok',
      'kimi'
    ])
  })
})

describe('composer custom-model persistence wiring', () => {
  const composerSource = (): string =>
    readFileSync(join(rendererRoot, 'components/Composer.tsx'), 'utf8')

  /** The JSX for the custom-model field, from its class down to its clear button. */
  function customModelFieldSource(source: string): string {
    const start = source.indexOf('className="composer-inline-custom-model"')
    expect(start, 'custom-model field missing from Composer').toBeGreaterThanOrEqual(0)
    const end = source.indexOf('aria-label="Remove custom model"', start)
    expect(end, 'clear button missing from the custom-model field').toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('saves the typed id on commit, never per keystroke', () => {
    const field = customModelFieldSource(composerSource())
    // Enter and blur are the two commit points; onChange must stay a pure
    // state update or the list fills with every prefix of the tag.
    expect(field).toContain('onBlur={saveCurrentCustomModel}')
    expect(field).toMatch(/onKeyDown=\{[\s\S]{0,200}saveCurrentCustomModel\(\)/)
    const onChange = field.slice(field.indexOf('onChange='), field.indexOf('onKeyDown='))
    expect(onChange).not.toContain('saveCurrentCustomModel')
    expect(onChange).not.toContain('addCustomProviderModel')
  })

  it('forgets a saved id when the field is cleared', () => {
    const field = customModelFieldSource(composerSource())
    expect(field).toContain('removeCustomProviderModel(')
    expect(field).toContain('persistCustomProviderModels(')
  })

  it('builds picker rows and the selected id through the shared helpers', () => {
    const source = composerSource()
    // Both must come from lib/customModelPickerRows: re-deriving either inline
    // is how the saved rows and the check mark drift apart.
    expect(source).toContain("from '../lib/customModelPickerRows'")
    expect(source).toContain('spliceSavedCustomModelRows(savedCustomModelStore')
    expect(source).toContain('customModelPickerSelectionId(')
    expect(source).toContain('selectedModelId={pickerSelectedModelId}')
  })
})

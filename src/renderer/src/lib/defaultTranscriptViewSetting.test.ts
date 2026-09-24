import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildTranscriptViewMenuItems } from '../components/TranscriptViewPicker'
import {
  DEFAULT_TRANSCRIPT_VIEW,
  resolveTranscriptView,
  transcriptViewForChat,
  type TranscriptView,
  type TranscriptViewByChatId
} from './transcriptViewOverride'

/**
 * Settings → Appearance → "Default transcript view".
 *
 * Almost every list this setting has to join FAILS OPEN. `SETTINGS_PATCH_KEYS`
 * drops an unlisted key with a bare `continue`; `rendererAppearanceSettings`
 * returns through an `as AppSettings` cast; both memo comparators are
 * hand-written equality chains; and `useAppearance` keeps five hand-maintained
 * per-key lists of which three are silent when missed. Nothing enumerates any
 * of them, so these guards are the coverage.
 *
 * Renderer tests here have no jsdom and the menu is a PORTAL, so the wiring is
 * pinned by source string and the behaviour by the pure builder. Every
 * negative below sits in a test that also asserts a positive over the same
 * source, so an empty or misread file cannot pass it.
 */
const RENDERER_SRC = join(__dirname, '..')
const MAIN_SRC = join(__dirname, '../../../main')

function renderer(relative: string): string {
  return readFileSync(join(RENDERER_SRC, relative), 'utf8')
}

function main(relative: string): string {
  return readFileSync(join(MAIN_SRC, relative), 'utf8')
}

/**
 * Names destructured from `component`'s props parameter.
 *
 * The text pin this replaced embedded a newline and four spaces, so a11edac52
 * reindenting the parameter list — `memo(\n  function TranscriptPanel({` became
 * `memo(function TranscriptPanel({` — reddened it without touching the claim.
 * Walking the binding pattern is indentation-independent, and THROWS when the
 * component is renamed or deleted rather than passing over an absent subject.
 */
function destructuredProps(source: string, component: string): string[] {
  const file = ts.createSourceFile(
    `${component}.tsx`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let pattern: ts.ObjectBindingPattern | undefined
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name?.text === component &&
      node.parameters[0] &&
      ts.isObjectBindingPattern(node.parameters[0].name)
    ) {
      pattern = node.parameters[0].name
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  if (!pattern) {
    throw new Error(
      `no \`function ${component}\` destructuring its props parameter. It was renamed, ` +
        'moved or rewritten to read props.x — update this test to the claim that replaced it.'
    )
  }
  return pattern.elements.flatMap((element) =>
    ts.isIdentifier(element.name) ? [element.name.text] : []
  )
}

describe('the default resolves the same way everywhere', () => {
  it('treats absence and junk as "follow the default", never as a pin', () => {
    expect(resolveTranscriptView(undefined)).toBe(DEFAULT_TRANSCRIPT_VIEW)
    expect(resolveTranscriptView(null)).toBe(DEFAULT_TRANSCRIPT_VIEW)
    expect(resolveTranscriptView('quiet')).toBe(DEFAULT_TRANSCRIPT_VIEW)
    expect(resolveTranscriptView('minimal')).toBe('minimal')
    expect(resolveTranscriptView('tools')).toBe('tools')
  })

  it('lets a per-chat override beat the setting, and nothing else', () => {
    const none: TranscriptViewByChatId = new Map<string, TranscriptView>()
    const pinned: TranscriptViewByChatId = new Map<string, TranscriptView>([['c1', 'standard']])
    expect(transcriptViewForChat(none, 'c1', resolveTranscriptView('minimal'))).toBe('minimal')
    expect(transcriptViewForChat(pinned, 'c1', resolveTranscriptView('minimal'))).toBe('standard')
    expect(transcriptViewForChat(none, 'c1', resolveTranscriptView(undefined))).toBe(
      DEFAULT_TRANSCRIPT_VIEW
    )
  })
})

describe('the menu names the real default', () => {
  it('builds the "Follow default" row from the resolved setting, not a constant', () => {
    // The row is the only one whose effect the reader cannot otherwise see, so
    // a wrong default here is confidently wrong rather than merely missing.
    const minimal = buildTranscriptViewMenuItems(resolveTranscriptView('minimal'), false, () => {})
    expect(minimal).toHaveLength(4)
    expect(minimal[0].id).toBe('default')
    expect(minimal[0].description).toBe('Using the Appearance default (Minimal)')
    expect(minimal[0].active).toBe(true)
    // Control: a DIFFERENT default produces a DIFFERENT row, so the assertion
    // above is reading the argument and not a hard-coded string.
    const tools = buildTranscriptViewMenuItems(resolveTranscriptView('tools'), false, () => {})
    expect(tools[0].description).toBe('Using the Appearance default (Tools)')
    const absent = buildTranscriptViewMenuItems(resolveTranscriptView(undefined), false, () => {})
    expect(absent[0].description).toBe('Using the Appearance default (Standard)')
  })
})

describe('the hooks take the default as an argument', () => {
  it('resolves through the threaded default in BOTH hooks, not DEFAULT_TRANSCRIPT_VIEW', () => {
    const hook = renderer('hooks/useTranscriptView.ts')
    const renderAt = hook.indexOf('export function useTranscriptView(')
    const menuAt = hook.indexOf('export function useTranscriptViewSelection(')
    // Assert the anchors BEFORE slicing: a missed indexOf is -1, and
    // `slice(-1)` is the last character of the file rather than ''.
    expect(renderAt).toBeGreaterThan(-1)
    expect(menuAt).toBeGreaterThan(renderAt)
    const bodies: Array<[string, string]> = [
      ['useTranscriptView', hook.slice(renderAt, menuAt)],
      ['useTranscriptViewSelection', hook.slice(menuAt)]
    ]
    for (const [name, body] of bodies) {
      expect(body, name).toContain('defaultView?: TranscriptView')
      // Anchored on the closing paren of the argument, so a longer form such as
      // `resolveTranscriptView(defaultView) ?? something` cannot satisfy it.
      expect(body, name).toContain('chatId ?? null, resolveTranscriptView(defaultView))')
      // A primitive left out of the deps freezes the resolved view at whatever
      // the default was on first mount — silent, and it looks like the memo bug.
      expect(body, name).toContain('[viewByChatId, chatId, defaultView]')
      // The negative has its positives directly above it, over the same slice.
      expect(body, name).not.toContain('DEFAULT_TRANSCRIPT_VIEW')
    }
  })

  it('still subscribes exactly once per hook', () => {
    // `getServerSnapshot` is the third argument in each; a second store
    // subscription for the default would break that count and the contract.
    const hook = renderer('hooks/useTranscriptView.ts')
    expect(hook.split('useSyncExternalStore(').length - 1).toBe(2)
    expect(hook.split('getTranscriptViewSnapshot').length - 1).toBe(5)
  })
})

describe('the default reaches every transcript and the menu', () => {
  it('is threaded into the panel hook by the panel prop', () => {
    const panel = renderer('components/TranscriptPanel.tsx')
    expect(panel).toContain('defaultTranscriptView?: TranscriptView')
    expect(destructuredProps(panel, 'TranscriptPanel')).toContain('defaultTranscriptView')
    expect(panel).toContain('useTranscriptView(chatId, defaultTranscriptView)')
  })

  it('is threaded into the picker, which is the row that would lie', () => {
    const picker = renderer('components/TranscriptViewPicker.tsx')
    expect(picker).toContain('defaultView?: TranscriptView')
    expect(picker).toContain('useTranscriptViewSelection(chatId, props.defaultView)')
  })

  it('is supplied at the composer mount of the picker', () => {
    const composer = renderer('components/Composer.tsx')
    const at = composer.indexOf('<TranscriptViewPicker')
    expect(at).toBeGreaterThan(-1)
    const close = composer.indexOf('/>', at)
    expect(close).toBeGreaterThan(at)
    const tag = composer.slice(at, close)
    // `appearance` is typed `any` in Composer, so nothing but this guard would
    // notice a misspelling here.
    expect(tag).toContain('defaultView={appearance.defaultTranscriptView}')
    // Control: the mount really is the one the menu tests pin.
    expect(tag).toContain('chatId={currentChat?.appChatId ?? null}')
  })

  it('reaches the main pane, the side chat and the settings panel', () => {
    const layout = renderer('app/views/MainAppLayout.tsx')
    expect(
      layout.split('defaultTranscriptView={appearance.defaultTranscriptView}').length - 1
    ).toBe(3)
  })

  it('reaches a multiview pane through the builder and the pane props', () => {
    const app = renderer('App.tsx')
    // Anchored to the ChatViewPane TAG, not searched loose over a ~30,000-line
    // file. Unanchored, this passes if the prop is moved to ANY other element —
    // a wrapper, the side panel, a debug surface — while every multiview pane
    // silently renders the wrong default. The comparator cannot catch that
    // either: it compares two undefineds equal.
    const paneAt = app.indexOf('<ChatViewPane')
    expect(paneAt).toBeGreaterThan(-1)
    const paneTag = app.slice(paneAt, app.indexOf('/>', paneAt))
    expect(paneTag).toContain('defaultTranscriptView={appearance.defaultTranscriptView}')
    const builder = renderer('lib/buildChatViewProps.ts')
    expect(builder).toContain(
      "defaultTranscriptView?: TranscriptPanelProps['defaultTranscriptView']"
    )
    expect(builder).toContain('defaultTranscriptView: input.defaultTranscriptView,')
  })
})

describe('the write path persists the choice', () => {
  it('gives the key its own block in handleSettingsChange', () => {
    // There is no spread in that function: every key is its own `if`, and one
    // that is missing compiles and simply never persists.
    const app = renderer('App.tsx')
    const at = app.indexOf('if (next.defaultTranscriptView !== undefined) {')
    expect(at).toBeGreaterThan(-1)
    const end = app.indexOf('\n    }', at)
    expect(end).toBeGreaterThan(at)
    const block = app.slice(at, end)
    // Newline terminator: `settingsPatch.defaultTranscriptView = next.x` is a
    // prefix of longer forms, and the previous slice shipped exactly that bug.
    expect(block).toContain('settingsPatch.defaultTranscriptView = next.defaultTranscriptView\n')
    expect(block).toContain(
      'appearance.update({ defaultTranscriptView: next.defaultTranscriptView })'
    )
  })

  it('is declared on the update type App actually receives', () => {
    // SettingsPanel's own onChange literal is a separate hand-written copy, so
    // adding the key there alone compiles while the value never reaches App.
    const update = renderer('lib/settingsPanelUpdate.ts')
    expect(update).toContain("defaultTranscriptView?: AppSettings['defaultTranscriptView']")
  })

  it('joins all four useAppearance lists it has to join', () => {
    const hook = renderer('hooks/useAppearance.ts')
    // Interface + initial state are compile-caught because the field is
    // REQUIRED on AppearanceState; the other two are silent when missed.
    expect(hook).toContain('defaultTranscriptView: TranscriptView\n')
    expect(hook).toContain('defaultTranscriptView: DEFAULT_TRANSCRIPT_VIEW,')
    // Hydrate: missed, `...prev` retains the mount default and the stored value
    // never loads — "works until I restart the app".
    expect(hook).toContain(
      'defaultTranscriptView: resolveTranscriptView(settings.defaultTranscriptView),'
    )
    // Persist: missed, state and DOM move and settings.json does not.
    // Anchored on the literal's FIRST key, not on `.updateSettings({` alone —
    // the hydrate path issues its own one-key call earlier in the file, and
    // anchoring there would span three hundred lines and pin nothing.
    const persistAt = hook.indexOf('.updateSettings({\n            appearanceMode: next.mode,')
    expect(persistAt).toBeGreaterThan(-1)
    const persistEnd = hook.indexOf('\n          })', persistAt)
    expect(persistEnd).toBeGreaterThan(persistAt)
    expect(hook.slice(persistAt, persistEnd)).toContain(
      'defaultTranscriptView: next.defaultTranscriptView,'
    )
  })
})

describe('the Appearance control', () => {
  it('sits beside Fan-out lanes and reads the shared catalogue', () => {
    const panel = renderer('components/SettingsPanel.tsx')
    const at = panel.indexOf(
      '<span className="settings-field-label">Default transcript view</span>'
    )
    expect(at).toBeGreaterThan(-1)
    // The placement this test is NAMED for, actually asserted. Slicing from the
    // label to the next `</label>` says nothing about which card the label sits
    // in, so the old version passed with the control moved anywhere in the file.
    const fanoutAt = panel.indexOf('<span className="settings-field-label">Fan-out lanes</span>')
    expect(fanoutAt).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(fanoutAt)
    // Adjacent, not merely somewhere below: no other field label between them.
    const between = panel.slice(fanoutAt + 1, at)
    expect(between).not.toContain('<span className="settings-field-label">')
    const end = panel.indexOf('</label>', at)
    expect(end).toBeGreaterThan(at)
    const control = panel.slice(at, end)
    expect(control).toContain('value={resolveTranscriptView(defaultTranscriptView)}')
    expect(control).toContain(
      'onChange({ defaultTranscriptView: e.target.value as TranscriptView })'
    )
    expect(control).toContain('TRANSCRIPT_VIEW_OPTIONS.map(')
    // The catalogue exists so the menu and this control cannot word the same
    // three views differently; the positive above proves it is referenced.
    expect(control).not.toContain('Thinking and tool viewports hidden')
  })

  it('declares the prop on BOTH hand-written prop shapes in that file', () => {
    // The read path (interface) and the write path (the separate `onChange`
    // literal) are independent copies: one alone compiles green.
    const panel = renderer('components/SettingsPanel.tsx')
    expect(panel).toContain('\n  defaultTranscriptView?: TranscriptView\n')
    expect(panel).toContain('\n    defaultTranscriptView?: TranscriptView\n')
    expect(panel).toContain('\n  defaultTranscriptView,\n')
  })
})

describe('the main-process half', () => {
  it('declares the field optional and leaves it out of defaultSettings', () => {
    // Absence IS the contract: a value in defaultSettings would give every
    // install an explicit pin that beats a later user choice.
    const types = main('store/types.ts')
    expect(types).toContain('defaultTranscriptView?: TranscriptView\n')
    const store = main('store/index.ts')
    const at = store.indexOf('const defaultSettings: AppSettings = {')
    expect(at).toBeGreaterThan(-1)
    const end = store.indexOf('\n}', at)
    expect(end).toBeGreaterThan(at)
    const literal = store.slice(at, end)
    // Control: this really is the defaults literal, and it really is populated.
    expect(literal).toContain("promptSurfaceStyle: 'liquid_glass',")
    expect(literal).not.toContain('defaultTranscriptView')
    expect(literal).not.toContain('fanoutLaneLayout')
  })

  it('is allowlisted for persistence next to its precedent', () => {
    const sanitizers = main('settings/MainSanitizers.ts')
    expect(sanitizers).toContain("'defaultTranscriptView',")
  })

  it('is forwarded by the only projection popouts and utility windows have', () => {
    const handlers = main('ipc/settingsHandlers.ts')
    const at = handlers.indexOf('function rendererAppearanceSettings(')
    expect(at).toBeGreaterThan(-1)
    const end = handlers.indexOf('} as AppSettings', at)
    expect(end).toBeGreaterThan(at)
    const projection = handlers.slice(at, end)
    expect(projection).toContain('defaultTranscriptView: settings.defaultTranscriptView,')
    // Shipped-but-unreachable before this slice, in the same function.
    expect(projection).toContain('fanoutLaneLayout: settings.fanoutLaneLayout,')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRANSCRIPT_VIEWS } from '../lib/transcriptViewFold'
import {
  resetTranscriptViewOverridesForTest,
  type TranscriptView
} from '../lib/transcriptViewOverride'
import { TRANSCRIPT_VIEW_OPTIONS } from './settings/settingsUiOptions'
import { buildTranscriptViewMenuItems } from './TranscriptViewPicker'

/**
 * The popover is a PORTAL, and portals never render under
 * `renderToStaticMarkup` — this whole harness has no DOM. So a test asserting
 * menu markup would run over an empty string and pass no matter what the menu
 * contained. The item array is the thing worth pinning, which is exactly why
 * the builder is exported separately (same reason
 * `buildMultiviewLayoutGridItems` is).
 */

beforeEach(() => {
  resetTranscriptViewOverridesForTest()
})

describe('buildTranscriptViewMenuItems', () => {
  it('offers four rows: follow-default first, then quietest to loudest', () => {
    // Anti-vacuity for every assertion below: if the builder ever returned an
    // empty array, the `find` calls would all yield undefined and the
    // `toBe(...)` checks would compare undefined to undefined.
    const items = buildTranscriptViewMenuItems('standard', false, () => {})
    expect(items).toHaveLength(4)
    expect(items.map((item) => item.id)).toEqual(['default', ...TRANSCRIPT_VIEWS])
    // The catalogue order is the menu order, and it is quietest first.
    expect(items.map((item) => item.id)).toEqual(['default', 'minimal', 'tools', 'standard'])
  })

  it('takes its labels and helper text from the shared catalogue', () => {
    // One source for the menu and the Appearance default, so the two cannot
    // describe the same three views differently.
    const items = buildTranscriptViewMenuItems('standard', false, () => {})
    for (const option of TRANSCRIPT_VIEW_OPTIONS) {
      const item = items.find((candidate) => candidate.id === option.value)
      expect(item?.label, option.value).toBe(option.label)
      expect(item?.description, option.value).toBe(option.helper)
    }
    // Every row has copy; an empty description would leave rows that differ
    // only by a word the user cannot see.
    for (const item of items) {
      expect(item.label.length, item.id).toBeGreaterThan(0)
      expect(item.description.length, item.id).toBeGreaterThan(0)
    }
  })

  it('ticks follow-default, and ONLY follow-default, on an un-overridden chat', () => {
    // The four-item contract. Keying `active` on the resolved view alone would
    // tick both "Follow default" and whichever view the default resolves to,
    // which reads as two selections.
    const items = buildTranscriptViewMenuItems('standard', false, () => {})
    expect(items.filter((item) => item.active).map((item) => item.id)).toEqual(['default'])
  })

  it('ticks the pinned view, and only it, on an overridden chat', () => {
    for (const view of TRANSCRIPT_VIEWS) {
      const items = buildTranscriptViewMenuItems(view, true, () => {})
      expect(
        items.filter((item) => item.active).map((item) => item.id),
        view
      ).toEqual([view])
    }
  })

  it('distinguishes a deliberate standard pin from following a standard default', () => {
    // The state the fourth row exists to make reachable. Both resolve to
    // `standard`; they must not tick the same row.
    const following = buildTranscriptViewMenuItems('standard', false, () => {})
    const pinned = buildTranscriptViewMenuItems('standard', true, () => {})
    expect(following.find((item) => item.id === 'default')?.active).toBe(true)
    expect(following.find((item) => item.id === 'standard')?.active).toBe(false)
    expect(pinned.find((item) => item.id === 'default')?.active).toBe(false)
    expect(pinned.find((item) => item.id === 'standard')?.active).toBe(true)
  })

  it('sends null for follow-default and the view for every other row', () => {
    // THE regression this menu shape exists to prevent. A row that sent the
    // resolved view instead of null would pin the chat on the likeliest click
    // in the feature — opening the menu and choosing what is already selected.
    const onSelect = vi.fn<(view: TranscriptView | null) => void>()
    const items = buildTranscriptViewMenuItems('standard', false, onSelect)
    items.find((item) => item.id === 'default')!.onSelect()
    expect(onSelect).toHaveBeenCalledWith(null)
    for (const view of TRANSCRIPT_VIEWS) {
      onSelect.mockClear()
      items.find((item) => item.id === view)!.onSelect()
      expect(onSelect, view).toHaveBeenCalledWith(view)
    }
  })

  it('names the default it is following, since that row shows no other clue', () => {
    // Every other row states its own effect. This one does not, so the copy has
    // to say which view the Appearance default currently resolves to.
    for (const view of TRANSCRIPT_VIEWS) {
      const label = TRANSCRIPT_VIEW_OPTIONS.find((option) => option.value === view)!.label
      const items = buildTranscriptViewMenuItems(view, false, () => {})
      expect(items[0].description, view).toContain(label)
    }
    // When the chat IS overridden the row is an action rather than a status,
    // so it must not claim to be in use.
    const overridden = buildTranscriptViewMenuItems('minimal', true, () => {})
    expect(overridden[0].description).not.toContain('Using')
  })
})

describe('the picker cannot write a stray empty key', () => {
  it('guards the chat id before writing, and renders nothing without one', () => {
    // `appChatId ?? ''` appears in more than one pane. A '' key is written into
    // the snapshot and notifies every listener, while both readers short-circuit
    // on it — the menu writes, the store churns, and nothing changes. Source
    // guard because the component holds hooks and this harness has no
    // dispatcher to render it with.
    const source = readFileSync(join(__dirname, 'TranscriptViewPicker.tsx'), 'utf8')
    expect(source).toContain('props.chatId && props.chatId.length > 0 ? props.chatId : null')
    expect(source).toContain('if (!chatId) return null')
    const onSelect = source.indexOf('setTranscriptViewOverride(chatId, next)')
    expect(onSelect).toBeGreaterThan(-1)
    // The write is guarded in the same closure, not somewhere hopeful above it.
    expect(source.slice(onSelect - 120, onSelect)).toContain('if (!chatId) return')
  })

  it('passes the snapshot getter as getServerSnapshot in the hook it uses', () => {
    // Without the third argument React's server shim throws "Missing
    // getServerSnapshot", which would red every suite that mounts a composer
    // at once rather than failing anywhere near this component.
    const hook = readFileSync(join(__dirname, '../hooks/useTranscriptView.ts'), 'utf8')
    const at = hook.indexOf('export function useTranscriptViewSelection')
    expect(at).toBeGreaterThan(-1)
    const body = hook.slice(at)
    expect(body.split('getTranscriptViewSnapshot').length - 1).toBe(2)
  })

  it('is actually mounted in the composer, with a non-empty chat id', () => {
    // Without this the whole menu could be deleted from the icon row and every
    // other test here would still pass — they all exercise the builder, which
    // does not care whether anything renders it. The mount is the only thing
    // that makes six commits of transcript-view mechanism reachable at all.
    const composer = readFileSync(join(__dirname, 'Composer.tsx'), 'utf8')
    const at = composer.indexOf('<TranscriptViewPicker')
    expect(at).toBeGreaterThan(-1)
    const tag = composer.slice(at, composer.indexOf('/>', at))
    // `?? null`, never `?? ''` — see the empty-key note above.
    expect(tag).toContain('chatId={currentChat?.appChatId ?? null}')
    expect(tag).not.toContain("?? ''")
    // And it is wired to the slash command, not just to its own icon.
    expect(tag).toContain("composerSurfaceOpenSignal(composerSurfaceRequest, 'view')")
  })

  it('does not mention the activity-stack component, which would red the site count', () => {
    // TranscriptPanel.transcriptView.test.ts scans every renderer source file
    // for the opening tag and asserts EXACTLY four sites. A mention of it here —
    // even inside a doc comment — reds that guard from a file that renders no
    // such component. Cheap to pin, baffling to debug.
    const source = readFileSync(join(__dirname, 'TranscriptViewPicker.tsx'), 'utf8')
    expect(source).not.toContain(`<${'ActivityStack'}`)
  })
})

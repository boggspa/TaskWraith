import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MultiviewPaneMediaRef } from '../../../shared/multiviewLayouts'
import { MediaPane } from './MediaPane'
import {
  STUDIO_EFFECT_PREVIEW_IDLE,
  StudioEffectPreviewControl,
  adoptStudioEffectPreviewState,
  applyStudioEffectPreviewResult,
  studioEffectPreviewLabel,
  type StudioEffectPreviewViewState
} from './StudioEffectPreviewControl'

const ACTIVE: StudioEffectPreviewViewState = {
  active: true,
  displayName: 'Filmic Warm.cube',
  effectId: 'a'.repeat(64),
  error: null,
  busy: false
}

function videoRef(): MultiviewPaneMediaRef {
  return {
    id: 'pane-1',
    kind: 'video',
    name: 'clip.mp4',
    sha256: 'b'.repeat(64),
    mimeType: 'video/mp4'
  }
}

describe('studioEffectPreviewLabel', () => {
  it('reads None at rest', () => {
    expect(studioEffectPreviewLabel(STUDIO_EFFECT_PREVIEW_IDLE)).toBe('None')
  })

  it('reads the operator filename when a LUT is active', () => {
    expect(studioEffectPreviewLabel(ACTIVE)).toBe('Filmic Warm.cube')
  })

  it('degrades to a short identity rather than an empty label', () => {
    // Reachable after a restart whose imported file was removed: the preview
    // itself still works because the cube text lives in the document.
    expect(studioEffectPreviewLabel({ ...ACTIVE, displayName: null })).toBe('aaaaaaaaaaaa…')
  })
})

describe('applyStudioEffectPreviewResult', () => {
  /**
   * LOAD-BEARING. A bad file is an ordinary operator mistake and must NOT drop
   * a grade that is already applied. Making the refusal branch overwrite state
   * fails this test.
   */
  it('retains the active LUT when a load is refused, and names the reason', () => {
    // The refusal deliberately carries an INACTIVE state — exactly what the
    // host returns for `studio_unavailable`, and what a stale read would look
    // like. Retention must come from `prior`, not from the result, or a failed
    // load silently wipes a grade the operator already had. Passing a state
    // equal to `prior` here would make this assertion unfalsifiable.
    const next = applyStudioEffectPreviewResult(ACTIVE, {
      ok: false,
      code: 'malformed_entry',
      state: { active: false, displayName: null, effectId: null }
    })

    expect(next.active).toBe(true)
    expect(next.displayName).toBe('Filmic Warm.cube')
    expect(next.effectId).toBe(ACTIVE.effectId)
    expect(next.error).toBe('That .cube file has a malformed entry.')
    expect(next.busy).toBe(false)
  })

  it('falls back to the raw code when a refusal has no readable text', () => {
    const next = applyStudioEffectPreviewResult(ACTIVE, {
      ok: false,
      code: 'stale_base',
      state: ACTIVE
    })
    expect(next.error).toBe('stale_base')
    expect(next.active).toBe(true)
  })

  it('treats a dismissed dialog as a no-op that clears any prior error', () => {
    const withError: StudioEffectPreviewViewState = { ...ACTIVE, error: 'previous complaint' }
    const next = applyStudioEffectPreviewResult(withError, {
      ok: true,
      canceled: true,
      state: { active: true, displayName: 'Filmic Warm.cube', effectId: ACTIVE.effectId }
    })

    expect(next.active).toBe(true)
    expect(next.displayName).toBe('Filmic Warm.cube')
    expect(next.error).toBeNull()
  })

  it('adopts a successful load and a successful clear', () => {
    const loaded = applyStudioEffectPreviewResult(STUDIO_EFFECT_PREVIEW_IDLE, {
      ok: true,
      state: { active: true, displayName: 'Teal.cube', effectId: 'c'.repeat(64) }
    })
    expect(loaded).toMatchObject({ active: true, displayName: 'Teal.cube', error: null })

    const cleared = applyStudioEffectPreviewResult(loaded, {
      ok: true,
      state: { active: false, displayName: null, effectId: null }
    })
    expect(cleared).toMatchObject({ active: false, displayName: null, effectId: null })
  })

  it('adopts a restart-hydrated state', () => {
    expect(
      adoptStudioEffectPreviewState({
        active: true,
        displayName: 'Teal Orange.cube',
        effectId: 'd'.repeat(64)
      })
    ).toMatchObject({ active: true, displayName: 'Teal Orange.cube', error: null, busy: false })
  })
})

describe('StudioEffectPreviewControl rendering', () => {
  it('shows both actions and the resting state', () => {
    const markup = renderToStaticMarkup(<StudioEffectPreviewControl api={null} />)
    expect(markup).toContain('Load .cube…')
    expect(markup).toContain('Clear LUT')
    expect(markup).toContain('LUT: None')
    expect(markup).toContain('data-lut-active="false"')
  })

  it('shows the active filename and enables Clear once a LUT is applied', () => {
    const markup = renderToStaticMarkup(
      <StudioEffectPreviewControl api={null} initialState={ACTIVE} />
    )
    expect(markup).toContain('Filmic Warm.cube')
    expect(markup).toContain('data-lut-active="true"')
  })

  it('surfaces a bounded refusal message', () => {
    const markup = renderToStaticMarkup(
      <StudioEffectPreviewControl
        api={null}
        initialState={{ ...ACTIVE, error: 'That .cube file is too large.' }}
      />
    )
    expect(markup).toContain('That .cube file is too large.')
    // The prior LUT is still shown — a refusal does not silently drop it.
    expect(markup).toContain('Filmic Warm.cube')
  })
})

describe('MediaPane toolbar reachability', () => {
  /**
   * LOAD-BEARING CALLER CONTROL. Deleting the <StudioEffectPreviewControl />
   * from the MediaPane toolbar fails this test, so the operator gesture cannot
   * silently disappear the way the earlier effect-preview seam did.
   */
  it('mounts the LUT control in the video pane toolbar', () => {
    const markup = renderToStaticMarkup(<MediaPane mediaRef={videoRef()} onClose={() => {}} />)
    expect(markup).toContain('studio-lut-control')
    expect(markup).toContain('Load .cube…')
    expect(markup).toContain('Clear LUT')
  })

  it('does not offer a LUT on an audio pane', () => {
    const audio: MultiviewPaneMediaRef = {
      ...videoRef(),
      kind: 'audio',
      name: 'take.m4a',
      mimeType: 'audio/mp4'
    }
    const markup = renderToStaticMarkup(<MediaPane mediaRef={audio} onClose={() => {}} />)
    expect(markup).not.toContain('studio-lut-control')
  })
})
